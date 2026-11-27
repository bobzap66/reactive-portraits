const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { matchesSecret, createStore } = require('./foundry-state.cjs');
const foundryStore = createStore();
const {createOBS,roles,mapping,targetFor}=require('./obs.cjs');
const obs=createOBS();
const {createCues}=require('./production-cues.cjs');
const cues=createCues();

const root = __dirname;
const port = Number(process.env.PORT || 8766);
const configFile = path.join(root, 'campaigns.json');
const stateFile = path.join(root, 'reactive-state.json');
const pairingFile = path.join(root, 'foundry-pairing.json');
let pairingKey = readJson(pairingFile, null)?.key;
if (typeof pairingKey !== 'string' || !/^[a-f0-9]{64}$/.test(pairingKey)) { pairingKey = randomBytes(32).toString('hex'); persistPairingKey(pairingKey); }
function persistPairingKey(key) { fs.writeFileSync(pairingFile+'.tmp', JSON.stringify({key}), {mode:0o600}); fs.renameSync(pairingFile+'.tmp', pairingFile); }
const assetsRoot = path.join(root, 'assets');
const defaultConfig = { campaigns: [] };
let config = readJson(configFile, null);
if (!config) {
  config = readJson(path.join(root, 'campaigns.example.json'), defaultConfig);
  writeJson(configFile, config);
}
let state = readJson(stateFile, { campaign: config.campaigns[0]?.id || '', sessions: {} });
let discordUsers = [];
const obsFile=path.join(root,'obs-config.json');
let obsConfig=readJson(obsFile,{enabled:false,port:4455,password:'',campaigns:{}});
obsConfig={enabled:obsConfig.enabled===true,port:Number.isInteger(obsConfig.port)&&obsConfig.port>0&&obsConfig.port<65536?obsConfig.port:4455,password:typeof obsConfig.password==='string'?obsConfig.password:'',campaigns:obsConfig.campaigns||{},cueKey:typeof obsConfig.cueKey==='string'&&/^[a-f0-9]{64}$/.test(obsConfig.cueKey)?obsConfig.cueKey:randomBytes(32).toString('hex')};
fs.writeFileSync(obsFile,JSON.stringify(obsConfig,null,2),{mode:0o600});
obs.configure(obsConfig);
const cueState=()=>{const s=obs.getStatus(),campaign=state.campaign;return {enabled:obsConfig.enabled,connected:s.connected,scene:s.scene,sceneEpoch:s.sceneEpoch,campaign,mappings:obsConfig.campaigns[campaign]||{},active:true};};
const cueTimer=setInterval(()=>cues.snapshot(cueState()),500);cueTimer.unref();
const obsStatus=campaign=>{const s=obs.getStatus(),active=state.campaign===campaign;return {enabled:obsConfig.enabled,connected:s.connected,scene:s.scene,streaming:s.streaming,recording:s.recording,mappings:obsConfig.campaigns[campaign]||{},active,cue:active?cues.snapshot(cueState()):null};};

function campaignAssetDir(campaignId) {
  if (typeof campaignId !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(campaignId)) throw new Error('Campaign ID must use letters, numbers, underscores, or hyphens.');
  const directory = path.resolve(assetsRoot, campaignId);
  if (!directory.startsWith(assetsRoot + path.sep)) throw new Error('Invalid campaign asset folder.');
  return directory;
}
function ensureCampaignAssetDirs(campaigns) {
  for (const campaign of campaigns) fs.mkdirSync(campaignAssetDir(campaign.id), { recursive: true });
}
ensureCampaignAssetDirs(config.campaigns);

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
    campaignAssetDir(campaign.id);
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
  if (!['/index.html','/app.js','/styles.css'].includes(decoded) && !file.startsWith(assetsRoot + path.sep)) return send(res, 404, 'Not found');
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
    if (pathname.startsWith('/api/obs/')) {
      const local=(origin===undefined||localOrigins.includes(origin))&&req.headers['sec-fetch-site']==='same-origin';
      const bridge=(!origin||/^chrome-extension:\/\/[a-p]{32}$/.test(origin))&&matchesSecret(req.headers.authorization?.replace(/^Bearer /,''),pairingKey);
      const json=value=>send(res,200,JSON.stringify(value),'application/json; charset=utf-8');
      if(pathname==='/api/obs/config'&&local){
        if(req.method==='GET')return json({enabled:obsConfig.enabled,port:obsConfig.port,hasPassword:!!obsConfig.password,campaigns:obsConfig.campaigns,cueKey:obsConfig.cueKey,status:obs.getStatus()});
        if(req.method==='POST'){
          const v=await readBody(req,65536);
          if(typeof v.enabled!=='boolean'||!Number.isInteger(v.port)||v.port<1||v.port>65535||typeof v.password!=='string'||v.password.length>256)throw Error('Invalid OBS connection settings');
          const next={...obsConfig,enabled:v.enabled,port:v.port,password:v.clearPassword===true?'':v.password||obsConfig.password};
          fs.writeFileSync(obsFile,JSON.stringify(next,null,2),{mode:0o600});obsConfig=next;obs.configure(obsConfig);return send(res,204);
        }
      }
      if(pathname==='/api/obs/mapping'&&local&&req.method==='POST'){
        const v=await readBody(req,65536);if(!config.campaigns.some(c=>c.id===v.campaign))throw Error('Unknown campaign');
        const s=obs.getStatus();if(!s.connected)throw Error('Connect OBS before mapping scenes');
        const next={...obsConfig,campaigns:{...obsConfig.campaigns,[v.campaign]:mapping(v.mappings,s.scenes)}};
        fs.writeFileSync(obsFile,JSON.stringify(next,null,2),{mode:0o600});obsConfig=next;return send(res,204);
      }
      if(pathname==='/api/obs/cue/intro-complete'&&req.method==='POST'){
        if(origin!==undefined||req.headers['sec-fetch-site']||!matchesSecret(req.headers.authorization?.replace(/^Bearer /,''),obsConfig.cueKey))return send(res,403,'Local automation credential required');
        const v=await readBody(req,4096),s=cueState();
        if(v.campaign!==s.campaign||v.scene!==s.scene||!cues.complete(s))return send(res,409,'Intro scene or campaign no longer active');
        return send(res,204);
      }
      if(!bridge)return send(res,403,'Paired bridge only');
      if(pathname==='/api/obs/status'&&req.method==='GET'){
        const campaign=new URL(req.url,'http://127.0.0.1').searchParams.get('campaign');
        if(!config.campaigns.some(c=>c.id===campaign))throw Error('Unknown campaign');return json(obsStatus(campaign));
      }
      if(pathname==='/api/obs/scene'&&req.method==='POST'){
        const v=await readBody(req,4096);if(!config.campaigns.some(c=>c.id===v.campaign))throw Error('Unknown campaign');
        if(!foundryStore.get(v.campaign).available)throw Error('GM bridge unavailable');
        const target=targetFor({enabled:obsConfig.enabled,activeCampaign:state.campaign,campaign:v.campaign,mappings:obsConfig.campaigns[v.campaign],status:obs.getStatus(),role:v.role,expectedScene:v.expectedScene});
        await obs.switchScene(target,v.expectedScene,()=>obsConfig.enabled&&state.campaign===v.campaign&&foundryStore.get(v.campaign).available&&obsConfig.campaigns[v.campaign]?.[v.role]===target&&matchesSecret(req.headers.authorization?.replace(/^Bearer /,''),pairingKey));return json(obsStatus(v.campaign));
      }
      return send(res,404,'Not found');
    }
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
      const nextKey=randomBytes(32).toString('hex');persistPairingKey(nextKey);pairingKey=nextKey;foundryStore.clear();
      return send(res,204);
    }
    if (pathname === '/api/foundry' && req.method === 'GET') {
      const campaign = new URL(req.url,'http://127.0.0.1').searchParams.get('campaign');
      return send(res,200,JSON.stringify(foundryStore.get(campaign)),'application/json; charset=utf-8');
    }

    if (req.method === 'POST' && origin && !localOrigins.includes(origin)) return send(res, 403, 'Local requests only');
    if (pathname === '/api/config' && req.method === 'GET') return send(res, 200, JSON.stringify(config), 'application/json; charset=utf-8');
    if (pathname === '/api/config' && req.method === 'POST') {
      const nextConfig = validateConfig(await readBody(req));
      ensureCampaignAssetDirs(nextConfig.campaigns);
      config = nextConfig;
      writeJson(configFile, config);
      const validCampaigns = new Set(config.campaigns.map(campaign => campaign.id));
      if (!validCampaigns.has(state.campaign)) state.campaign = config.campaigns[0]?.id || '';
      for (const id of Object.keys(state.sessions || {})) if (!validCampaigns.has(id)) delete state.sessions[id];
      writeJson(stateFile, state);
      return send(res, 204);
    }
    if (pathname === '/api/assets' && req.method === 'GET') {
      const campaignId = new URL(req.url, 'http://127.0.0.1').searchParams.get('campaign');
      const directory = campaignAssetDir(campaignId);
      fs.mkdirSync(directory, { recursive: true });
      const extensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.svg']);
      const files = fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase()))
        .map(entry => `assets/${campaignId}/${entry.name}`)
        .sort((a, b) => a.localeCompare(b));
      return send(res, 200, JSON.stringify(files), 'application/json; charset=utf-8');
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
