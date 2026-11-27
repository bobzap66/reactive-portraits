const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { matchesSecret, createStore } = require('./foundry-state.cjs');
const foundryStore = createStore();
let pairingKey = randomBytes(32).toString('hex');

const root = __dirname;
const port = Number(process.env.PORT || 8766);
const configFile = path.join(root, 'campaigns.json');
const stateFile = path.join(root, 'reactive-state.json');
const defaultConfig = { campaigns: [] };
let config = readJson(configFile, null);
if (!config) {
  config = readJson(path.join(root, 'campaigns.example.json'), defaultConfig);
  writeJson(configFile, config);
}
let state = readJson(stateFile, { campaign: config.campaigns[0]?.id || '', sessions: {} });
let discordUsers = [];

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
function send(res, status, body = '', type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) { reject(new Error('Request body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('Request body must be valid JSON')); }
    });
    req.on('error', reject);
  });
}
function validateConfig(value) {
  if (!value || !Array.isArray(value.campaigns)) throw new Error('Config must contain a campaigns array.');
  const ids = new Set();
  for (const campaign of value.campaigns) {
    if (!campaign.id || !campaign.label || !Array.isArray(campaign.people)) throw new Error('Each campaign needs an ID, label, and people list.');
    if (ids.has(campaign.id)) throw new Error(`Campaign ID “${campaign.id}” is used more than once.`);
    ids.add(campaign.id);
    const personIds = new Set();
    for (const person of campaign.people) {
      if (!person.id || !person.name) throw new Error(`Every participant in ${campaign.label} needs an ID and name.`);
      if (personIds.has(person.id)) throw new Error(`Participant ID “${person.id}” is duplicated in ${campaign.label}.`);
      personIds.add(person.id);
      if (person.image && (person.image.startsWith('/') || person.image.includes('..') || /^[a-z]+:/i.test(person.image))) {
        throw new Error(`Portrait for ${person.name} must be a relative path inside this project.`);
      }
    }
  }
  return value;
}
function staticFile(urlPath, res) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0]); }
  catch { return send(res, 400, 'Bad path'); }
  if (decoded === '/') decoded = '/index.html';
  const file = path.resolve(root, `.${decoded}`);
  if (!['/index.html','/app.js','/styles.css'].includes(decoded) && !decoded.startsWith('/assets/')) return send(res, 404, 'Not found');
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found');
  const ext = path.extname(file).toLowerCase();
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  try {
    const origin = req.headers.origin;
    const localOrigins = ['http://127.0.0.1:'+port, 'http://localhost:'+port];
    const localHost = ['127.0.0.1:'+port, 'localhost:'+port].includes(req.headers.host);
    if (!localHost) return send(res, 403, 'Local host only');
    if (pathname === '/api/foundry' && req.method === 'POST') {
      if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return send(res, 403, 'Extension requests only');
      if (!matchesSecret(req.headers.authorization?.replace(/^Bearer /,''), pairingKey)) return send(res, 401, 'Invalid pairing key');
      const value = await readBody(req, 65536);
      if (!config.campaigns.some(c => c.id === value.campaign)) return send(res, 400, 'Unknown campaign');
      foundryStore.put(value.campaign, value.snapshot);
      return send(res, 204);
    }
    if (pathname === '/api/foundry/pair' && req.method === 'GET') {
      if ((origin && !localOrigins.includes(origin)) || !['same-origin','none'].includes(req.headers['sec-fetch-site'] || 'none')) return send(res, 403, 'Local controller only');
      return send(res, 200, JSON.stringify({key:pairingKey, campaign:state.campaign}), 'application/json; charset=utf-8');
    }
    if (pathname === '/api/foundry/pair' && req.method === 'POST') {
      if ((origin && !localOrigins.includes(origin)) || req.headers['sec-fetch-site'] !== 'same-origin') return send(res,403,'Local controller only');
      pairingKey=randomBytes(32).toString('hex');foundryStore.clear();
      return send(res,204);
    }
    if (pathname === '/api/foundry' && req.method === 'GET') {
      const campaign = new URL(req.url,'http://127.0.0.1').searchParams.get('campaign');
      return send(res,200,JSON.stringify(foundryStore.get(campaign)),'application/json; charset=utf-8');
    }
    if (req.method === 'POST' && origin && !localOrigins.includes(origin)) return send(res, 403, 'Local requests only');
    if (pathname === '/api/config' && req.method === 'GET') return send(res, 200, JSON.stringify(config), 'application/json; charset=utf-8');
    if (pathname === '/api/config' && req.method === 'POST') {
      config = validateConfig(await readBody(req));
      writeJson(configFile, config);
      const validCampaigns = new Set(config.campaigns.map(campaign => campaign.id));
      if (!validCampaigns.has(state.campaign)) state.campaign = config.campaigns[0]?.id || '';
      for (const id of Object.keys(state.sessions || {})) if (!validCampaigns.has(id)) delete state.sessions[id];
      writeJson(stateFile, state);
      return send(res, 204);
    }
    if (pathname === '/api/state' && req.method === 'GET') return send(res, 200, JSON.stringify(state), 'application/json; charset=utf-8');
    if (pathname === '/api/discord/users' && req.method === 'GET') return send(res, 200, JSON.stringify(discordUsers), 'application/json; charset=utf-8');
    if (pathname === '/api/discord/users' && req.method === 'POST') {
      const value = await readBody(req);
      if (!Array.isArray(value.users)) return send(res, 400, 'Expected a users array');
      discordUsers = value.users.filter(user => user && user.id && user.label).map(user => ({ id: String(user.id), label: String(user.label) }));
      return send(res, 204);
    }
    if (pathname === '/api/state' && req.method === 'POST') {
      const value = await readBody(req);
      if (!value || typeof value !== 'object' || !value.sessions || typeof value.sessions !== 'object') return send(res, 400, 'Invalid state');
      state = value;
      if (!config.campaigns.some(campaign => campaign.id === state.campaign)) state.campaign = config.campaigns[0]?.id || '';
      writeJson(stateFile, state);
      return send(res, 204);
    }
    if (pathname === '/api/speaker' && req.method === 'POST') {
      const value = await readBody(req);
      if (!config.campaigns.some(campaign => campaign.id === value.campaign)) return send(res, 400, 'Unknown campaign');
      state.sessions = state.sessions || {};
      state.sessions[value.campaign] = state.sessions[value.campaign] || { active: null, absent: {}, crops: {} };
      state.sessions[value.campaign].active = value.speaker || null;
      state.campaign = value.campaign;
      writeJson(stateFile, state);
      return send(res, 204);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return staticFile(req.url, res);
  } catch (error) {
    return send(res, 400, error.message);
  }
});

server.listen(port, '127.0.0.1', () => console.log(`Reactive Portraits is ready at http://127.0.0.1:${port}`));
