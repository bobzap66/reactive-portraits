const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, entersState, VoiceConnectionStatus } = require('@discordjs/voice');

const privateConfigPath = path.join(__dirname, 'discord-bridge.config.json');
if (!fs.existsSync(privateConfigPath)) {
  console.error('Missing discord-bridge.config.json. Copy discord-bridge.config.example.json and add your bot token and server ID.');
  process.exit(1);
}
const privateConfig = JSON.parse(fs.readFileSync(privateConfigPath, 'utf8'));
if (!privateConfig.token || !privateConfig.guildId) {
  console.error('discord-bridge.config.json needs token and guildId.');
  process.exit(1);
}
const speakingDelayMs = Number(privateConfig.speakingDelayMs ?? 500);
let campaignConfig = { campaigns: [] };
let activeCampaign = '';
let connection = null;
let currentChannelId = null;
let currentCampaignId = null;
let currentSpeaker = null;
const pendingSpeakers = new Map();
const activeSpeakers = new Set();
let client;

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
function campaignById(id) { return campaignConfig.campaigns.find(campaign => campaign.id === id); }
function personForUser(campaignId, discordId) {
  return campaignById(campaignId)?.people.find(person => String(person.discordId || '') === String(discordId));
}
function publishRoster(channel) {
  const users = [...(channel?.members?.values?.() || [])].map(member => ({
    id: String(member.id),
    label: `${member.displayName || member.user.globalName || member.user.username}${member.user.username && member.displayName !== member.user.username ? ` (@${member.user.username})` : ''} — ${member.id}`
  }));
  const body = JSON.stringify({ users });
  const req = http.request({ hostname: '127.0.0.1', port: 8766, path: '/api/discord/users', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => response.resume());
  req.on('error', error => console.error('Could not update the Discord user list:', error.message));
  req.end(body);
}
function sendSpeaking(person, campaignId) {
  if (!person || currentSpeaker === person.id) return;
  currentSpeaker = person.id;
  console.log(`Speaking: ${person.name} [${campaignId}]`);
  postJson('/api/speaker', { campaign: campaignId, speaker: person.id });
}
function clearSpeaking(person, campaignId) {
  if (!person) return;
  activeSpeakers.delete(`${campaignId}:${person.id}`);
  if (currentSpeaker === person.id) {
    currentSpeaker = null;
    postJson('/api/speaker', { campaign: campaignId, speaker: null });
  }
}

async function refresh() {
  try {
    const [nextConfig, state] = await Promise.all([getJson('/api/config'), getJson('/api/state')]);
    campaignConfig = nextConfig;
    const nextCampaign = campaignById(state.campaign)?.id || campaignConfig.campaigns[0]?.id || '';
    if (nextCampaign !== activeCampaign) {
      activeCampaign = nextCampaign;
      currentSpeaker = null;
      for (const timer of pendingSpeakers.values()) clearTimeout(timer);
      pendingSpeakers.clear(); activeSpeakers.clear();
      if (state.sessions?.[activeCampaign]?.active) currentSpeaker = state.sessions[activeCampaign].active;
    }
    if (!client?.isReady() || !activeCampaign) return;
    const campaign = campaignById(activeCampaign);
    const channelId = campaign?.channelId;
    if (!channelId) {
      if (connection) { connection.destroy(); connection = null; currentChannelId = null; currentCampaignId = null; }
      return;
    }
    if (connection && currentChannelId === channelId && currentCampaignId === activeCampaign) return;
    if (connection) connection.destroy();
    connection = null; currentChannelId = null; currentCampaignId = null;
    const guild = await client.guilds.fetch(privateConfig.guildId);
    const channel = await guild.channels.fetch(channelId);
    if (!channel?.isVoiceBased()) throw new Error(`The channel configured for “${campaign.label}” is not a voice channel.`);
    publishRoster(channel);
    connection = joinVoiceChannel({ channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: true });
    currentChannelId = channel.id;
    currentCampaignId = activeCampaign;
    const connectionCampaignId = currentCampaignId;
    connection.receiver.speaking.on('start', userId => {
      const campaignId = connectionCampaignId;
      const person = personForUser(campaignId, userId);
      if (!person) return;
      const key = `${campaignId}:${person.id}`;
      activeSpeakers.add(key);
      clearTimeout(pendingSpeakers.get(String(userId)));
      pendingSpeakers.set(String(userId), setTimeout(() => {
        pendingSpeakers.delete(String(userId));
        if (activeSpeakers.has(key)) sendSpeaking(person, campaignId);
      }, speakingDelayMs));
    });
    connection.receiver.speaking.on('end', userId => {
      const campaignId = connectionCampaignId;
      const person = personForUser(campaignId, userId);
      clearTimeout(pendingSpeakers.get(String(userId)));
      pendingSpeakers.delete(String(userId));
      clearSpeaking(person, campaignId);
    });
    connection.once(VoiceConnectionStatus.Ready, () => console.log(`Listening in ${channel.name} for ${campaign.label}.`));
    connection.on('error', error => console.error('Discord voice error:', error.message));
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try { await Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5_000), entersState(connection, VoiceConnectionStatus.Connecting, 5_000)]); }
      catch { connection?.destroy(); connection = null; currentChannelId = null; currentCampaignId = null; }
    });
  } catch (error) {
    console.error('Could not update Discord voice connection:', error.message);
  }
}

client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
client.on('voiceStateUpdate', state => {
  if (state.channelId && state.channelId === currentChannelId) publishRoster(state.channel);
  else if (state.oldState?.channelId === currentChannelId) publishRoster(state.oldState.channel);
});
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await refresh();
  setInterval(refresh, 1000);
});
client.on('error', error => console.error('Discord client error:', error));
client.login(privateConfig.token).catch(error => { console.error('Discord login failed:', error.message); process.exit(1); });
