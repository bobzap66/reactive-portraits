const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const configPath = path.join(__dirname, 'discord-rpc.config.json');
if (!fs.existsSync(configPath)) {
  console.error('Missing discord-rpc.config.json. Copy discord-rpc.config.example.json and add your Discord application details.');
  process.exit(1);
}
const privateConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!privateConfig.clientId || !privateConfig.clientSecret || !privateConfig.redirectUri) {
  console.error('discord-rpc.config.json needs clientId, clientSecret, and redirectUri.');
  process.exit(1);
}

const speakingDelayMs = Number(privateConfig.speakingDelayMs ?? 500);
const scopes = privateConfig.scopes || ['rpc', 'identify', 'rpc.voice.read'];
const socketPaths = process.platform === 'win32'
  ? Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`)
  : [...new Set([process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, process.env.TMP, process.env.TEMP, '/tmp'].filter(Boolean))]
    .flatMap(dir => Array.from({ length: 10 }, (_, i) => path.join(dir, `discord-ipc-${i}`)));

let config = { campaigns: [] };
let activeCampaign = '';
let activeChannelId = '';
let lastRosterRefresh = 0;
let currentSpeaker = null;
let rpc;
let socket;
let rx = Buffer.alloc(0);
const pending = new Map();
const activeSpeakers = new Set();
const pendingSpeakers = new Map();

function getJson(route) {
  return new Promise((resolve, reject) => http.get(`http://127.0.0.1:8766${route}`, response => {
    let body = ''; response.setEncoding('utf8'); response.on('data', part => body += part);
    response.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error(`Invalid JSON from ${route}`)); } });
  }).on('error', reject));
}
function postJson(route, value) {
  const body = JSON.stringify(value);
  const req = http.request({ hostname: '127.0.0.1', port: 8766, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => response.resume());
  req.on('error', error => console.error('Could not reach Reactive Portraits:', error.message));
  req.end(body);
}
function campaignById(id) { return config.campaigns.find(campaign => campaign.id === id); }
function personForUser(campaignId, userId) {
  return campaignById(campaignId)?.people.find(person => String(person.discordId || '') === String(userId));
}
function emitSpeaker(person, campaignId) {
  if (!person || currentSpeaker === person.id) return;
  currentSpeaker = person.id;
  console.log(`Speaking: ${person.name} [${campaignId}]`);
  postJson('/api/speaker', { campaign: campaignId, speaker: person.id });
}
function clearSpeaker(person, campaignId) {
  if (!person) return;
  const key = `${campaignId}:${person.id}`;
  activeSpeakers.delete(key);
  if (currentSpeaker === person.id) {
    currentSpeaker = null;
    postJson('/api/speaker', { campaign: campaignId, speaker: null });
  }
}

function frame(opcode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(8);
  header.writeInt32LE(opcode, 0);
  header.writeInt32LE(body.length, 4);
  socket.write(Buffer.concat([header, body]));
}
function command(cmd, args = {}, evt) {
  const nonce = crypto.randomUUID();
  const payload = { cmd, nonce, args };
  if (evt) payload.evt = evt;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(nonce); reject(new Error(`Discord RPC timed out during ${cmd}.`)); }, 15000);
    pending.set(nonce, { resolve, reject, timer });
    frame(1, payload);
  });
}
function receiveFrames(chunk) {
  rx = Buffer.concat([rx, chunk]);
  while (rx.length >= 8) {
    const opcode = rx.readInt32LE(0);
    const length = rx.readInt32LE(4);
    if (length < 0 || length > 4 * 1024 * 1024) throw new Error('Discord RPC sent an invalid frame.');
    if (rx.length < 8 + length) return;
    const data = rx.subarray(8, 8 + length);
    rx = rx.subarray(8 + length);
    if (opcode === 2) throw new Error('Discord RPC closed the connection.');
    if (opcode !== 1) continue;
    let message;
    try { message = JSON.parse(data.toString('utf8')); }
    catch { throw new Error('Discord RPC sent invalid JSON.'); }
    if (message.nonce && pending.has(message.nonce)) {
      const request = pending.get(message.nonce);
      clearTimeout(request.timer); pending.delete(message.nonce);
      if (message.evt === 'ERROR') request.reject(new Error(message.data?.message || `Discord RPC error ${message.data?.code || ''}`));
      else request.resolve(message);
      continue;
    }
    if (message.evt === 'SPEAKING_START') onSpeaking(message.data?.user_id, true);
    if (message.evt === 'SPEAKING_STOP') onSpeaking(message.data?.user_id, false);
    if (['VOICE_STATE_CREATE', 'VOICE_STATE_UPDATE', 'VOICE_STATE_DELETE'].includes(message.evt)) lastRosterRefresh = 0;
    if (message.evt === 'ERROR') console.error('Discord RPC:', message.data?.message || message.data?.code);
  }
}
function onSpeaking(userId, started) {
  const campaignId = activeCampaign;
  const person = personForUser(campaignId, userId);
  if (!person) return;
  const key = `${campaignId}:${person.id}`;
  const userKey = String(userId);
  if (started) {
    activeSpeakers.add(key);
    clearTimeout(pendingSpeakers.get(userKey));
    pendingSpeakers.set(userKey, setTimeout(() => {
      pendingSpeakers.delete(userKey);
      if (activeSpeakers.has(key)) emitSpeaker(person, campaignId);
    }, speakingDelayMs));
  } else {
    clearTimeout(pendingSpeakers.get(userKey));
    pendingSpeakers.delete(userKey);
    clearSpeaker(person, campaignId);
  }
}

function postToken(code, verifier) {
  const body = new URLSearchParams({
    client_id: String(privateConfig.clientId),
    client_secret: privateConfig.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: privateConfig.redirectUri,
    code_verifier: verifier
  }).toString();
  return new Promise((resolve, reject) => {
    const req = https.request('https://discord.com/api/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', part => text += part);
      response.on('end', () => {
        let value; try { value = JSON.parse(text); } catch { return reject(new Error('Discord returned an invalid OAuth response.')); }
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(value.error_description || value.error || 'Discord OAuth token exchange failed.'));
        resolve(value.access_token);
      });
    });
    req.on('error', reject); req.end(body);
  });
}
function publishRoster(users) {
  const body = JSON.stringify({ users });
  const req = http.request({ hostname: '127.0.0.1', port: 8766, path: '/api/discord/users', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => response.resume());
  req.on('error', error => console.error('Could not update the Discord user list:', error.message));
  req.end(body);
}
async function refreshRoster() {
  if (!activeChannelId || !rpc || Date.now() - lastRosterRefresh < 10000) return;
  lastRosterRefresh = Date.now();
  try {
    const response = await command('GET_CHANNEL', { channel_id: activeChannelId });
    const users = (response.data?.voice_states || []).map(item => ({
      id: String(item.user?.id || ''),
      label: `${item.nick || item.user?.global_name || item.user?.username || 'Discord user'}${item.user?.username && item.nick !== item.user.username ? ` (@${item.user.username})` : ''} — ${item.user?.id || ''}`
    })).filter(user => user.id);
    publishRoster(users);
  } catch (error) { console.error('Could not read Discord channel members:', error.message); }
}
function randomVerifier() { return crypto.randomBytes(32).toString('base64url'); }
function challenge(verifier) { return crypto.createHash('sha256').update(verifier).digest('base64url'); }

function connectPipe(index = 0) {
  if (index >= socketPaths.length) throw new Error('Could not find Discord desktop RPC. Make sure the Discord desktop app is running.');
  return new Promise((resolve, reject) => {
    const candidate = net.createConnection(socketPaths[index]);
    candidate.once('connect', () => { socket = candidate; resolve(); });
    candidate.once('error', error => {
      candidate.destroy();
      if (index + 1 < socketPaths.length) connectPipe(index + 1).then(resolve, reject);
      else reject(new Error('Could not find Discord desktop RPC. Make sure the Discord desktop app is running.'));
    });
  });
}
async function authorize() {
  const verifier = randomVerifier();
  const state = crypto.randomBytes(18).toString('hex');
  const result = await command('AUTHORIZE', {
    client_id: String(privateConfig.clientId), scopes,
    response_type: 'code', code_challenge: challenge(verifier), code_challenge_method: 'S256', state
  });
  if (!result.data?.code) throw new Error('Discord did not return an authorization code.');
  const accessToken = await postToken(result.data.code, verifier);
  await command('AUTHENTICATE', { access_token: accessToken });
  console.log('Authorized with the Discord desktop app.');
}
async function updateSubscription() {
  if (!rpc) return;
  const state = await getJson('/api/state');
  const nextId = campaignById(state.campaign)?.id || config.campaigns[0]?.id || '';
  const campaign = campaignById(nextId);
  const nextChannel = String(campaign?.channelId || '');
  if (nextId !== activeCampaign) {
    activeCampaign = nextId;
    currentSpeaker = null;
    activeSpeakers.clear();
    for (const timer of pendingSpeakers.values()) clearTimeout(timer);
    pendingSpeakers.clear();
  }
  if (nextChannel === activeChannelId) return;
  if (activeChannelId) {
    for (const evt of ['SPEAKING_START', 'SPEAKING_STOP']) {
      await command('UNSUBSCRIBE', { channel_id: activeChannelId }, evt).catch(() => {});
    }
  }
  activeChannelId = nextChannel;
  lastRosterRefresh = 0;
  publishRoster([]);
  if (!activeChannelId) { console.log(`No voice channel configured for ${campaign?.label || 'the selected campaign'}.`); return; }
  for (const evt of ['SPEAKING_START', 'SPEAKING_STOP']) {
    await command('SUBSCRIBE', { channel_id: activeChannelId }, evt);
  }
  await refreshRoster();
  console.log(`Listening for speaker events in ${campaign.label}.`);
}
async function refresh() {
  try {
    const next = await getJson('/api/config');
    config = next;
    await updateSubscription();
    await refreshRoster();
  } catch (error) { console.error('Could not refresh RPC campaign:', error.message); }
}
async function main() {
  await connectPipe();
  socket.on('error', error => console.error('Discord RPC socket error:', error.message));
  socket.on('close', () => { console.error('Discord RPC disconnected. Restart this bridge after Discord reconnects.'); process.exitCode = 1; });
  frame(0, { v: 1, client_id: String(privateConfig.clientId) });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Discord did not complete the RPC handshake.')), 10000);
    const onData = chunk => {
      try {
        rx = Buffer.concat([rx, chunk]);
        if (rx.length < 8) return;
        const opcode = rx.readInt32LE(0); const length = rx.readInt32LE(4);
        if (opcode !== 1 || rx.length < 8 + length) return;
        const ready = JSON.parse(rx.subarray(8, 8 + length).toString('utf8'));
        if (ready.evt !== 'READY') return;
        clearTimeout(timer); socket.off('data', onData); rx = Buffer.alloc(0); resolve();
      } catch (error) { clearTimeout(timer); reject(error); }
    };
    socket.on('data', onData);
  });
  socket.on('data', receiveFrames);
  console.log('Connected to the Discord desktop app. Approve the Reactive Portraits authorization prompt if it appears.');
  await authorize();
  rpc = true;
  await refresh();
  setInterval(refresh, 1000);
}
main().catch(error => { console.error('Discord RPC bridge failed:', error.message); process.exitCode = 1; socket?.destroy(); });
