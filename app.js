const $ = selector => document.querySelector(selector);
const campaignSelect = $('#campaignSelect');
const cards = $('#cards');
const manager = $('#manager');
const editor = $('#editor');
const peopleEditor = $('#peopleEditor');
const notice = $('#notice');
const params = new URLSearchParams(location.search);
if (params.has('overlay')) document.body.classList.add('overlay');

let config = { campaigns: [] };
let state = { campaign: '', sessions: {} };
let editingId = null;
let saveTimer = null;
let discordUsers = [];
let foundryState = null;
let foundryCampaign = null;
let foundryRequest = false;
let assetRefreshSequence = 0;

function activeCampaign() { return config.campaigns.find(item => item.id === state.campaign) || config.campaigns[0]; }
function currentSession(campaignId = state.campaign) {
  state.sessions ||= {};
  state.sessions[campaignId] ||= { active: null, absent: {}, crops: {} };
  const current = state.sessions[campaignId];
  current.absent ||= {};
  current.crops ||= {};
  return current;
}
function defaultCrop(person) { return { zoom: 1.25, x: 50, y: 18, ...(person.crop || {}) }; }
function setNotice(message = '') { notice.textContent = message; }
async function loadAll() {
  const [configResponse, stateResponse] = await Promise.all([fetch('/api/config'), fetch('/api/state')]);
  if (!configResponse.ok || !stateResponse.ok) throw new Error('Could not load the saved campaign setup.');
  config = await configResponse.json();
  state = await stateResponse.json();
  const requested = params.get('campaign');
  if (requested && config.campaigns.some(item => item.id === requested)) state.campaign = requested;
  if (!config.campaigns.some(item => item.id === state.campaign)) state.campaign = config.campaigns[0]?.id || '';
  if (params.has('overlay') && requested) await saveState();
  render();
}
async function saveState() {
  await fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
}
function queueStateSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveState().catch(() => {}), 180);
}
async function saveConfig() {
  const response = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
  if (!response.ok) throw new Error(await response.text());
  await saveState();
}

function render() {
  campaignSelect.replaceChildren();
  for (const campaign of config.campaigns) {
    const option = document.createElement('option');
    option.value = campaign.id;
    option.textContent = campaign.label;
    campaignSelect.append(option);
  }
  const campaign = activeCampaign();
  if (!campaign) {
    cards.innerHTML = '<p class="manager-empty">Create a campaign to get started.</p>';
    $('#overlayLink').href = '?overlay';
    return;
  }
  state.campaign = campaign.id;
  campaignSelect.value = campaign.id;
  const overlayUrl = new URL(location.href);
  overlayUrl.search = new URLSearchParams({ overlay: '', campaign: campaign.id }).toString();
  $('#overlayLink').href = overlayUrl.href;
  if (!params.has('overlay')) campaignSelect.hidden = false;
  const session = currentSession(campaign.id);
  cards.style.setProperty('--columns', Math.max(1, Math.min(8, campaign.people.length)));
  cards.replaceChildren();
  campaign.people.forEach(person => {
    const crop = session.crops[person.id] ||= defaultCrop(person);
    const card = document.createElement('article');
    card.dataset.personId=person.id;
    card.className = `portrait-card${session.active === person.id ? ' speaking' : ''}${session.absent[person.id] ? ' absent' : ''}`;
    const button = document.createElement('button');
    button.className = 'portrait-button';
    button.type = 'button';
    button.title = `Mark ${person.name} as the current speaker`;
    const image = document.createElement('img');
    image.src = person.image || 'assets/portrait-placeholder.svg';
    image.alt = person.name;
    image.style.setProperty('--zoom', crop.zoom);
    image.style.setProperty('--x', `${crop.x}%`);
    image.style.setProperty('--y', `${crop.y}%`);
    image.onerror = () => { image.src = 'assets/portrait-placeholder.svg'; };
    const shade = document.createElement('span'); shade.className = 'portrait-shade';
    const name = document.createElement('span'); name.className = 'portrait-name'; name.textContent = person.name;
    const role = document.createElement('span'); role.className = 'portrait-role'; role.textContent = person.role || '';
    const turn=document.createElement('span');turn.className='foundry-turn';turn.textContent='ACTIVE TURN';turn.hidden=true;
    const hp=document.createElement('span');hp.className='foundry-health';hp.hidden=true;
    const fill=document.createElement('span');fill.className='foundry-health-fill';const temp=document.createElement('span');temp.className='foundry-health-temp';hp.append(fill,temp);
    button.append(image, shade, name, role, turn, hp);

    button.onclick = async () => { session.active = session.active === person.id ? null : person.id; render(); await saveState(); };
    card.append(button);
    if (!params.has('overlay')) {
      const tools = document.createElement('div'); tools.className = 'card-tools';
      const absent = document.createElement('button'); absent.className = 'button secondary'; absent.textContent = session.absent[person.id] ? 'Show' : 'Dim';
      absent.onclick = async () => { session.absent[person.id] = !session.absent[person.id]; render(); await saveState(); };
      tools.append(absent);
      const reset = document.createElement('button'); reset.className = 'button secondary'; reset.textContent = 'Reset crop';
      reset.onclick = async () => { session.crops[person.id] = defaultCrop({}); render(); await saveState(); };
      tools.append(reset);
      for (const [key, label, min, max, step] of [['zoom','Zoom',1,3.5,.05],['x','Horizontal',0,100,1],['y','Vertical',0,100,1]]) {
        const description = document.createElement('label'); description.className='tool-label'; description.textContent = `${label}: ${key === 'zoom' ? `${Number(crop[key]).toFixed(2)}×` : `${crop[key]}%`}`;
        const slider = document.createElement('input'); slider.type='range'; slider.min=min; slider.max=max; slider.step=step; slider.value=crop[key]; slider.setAttribute('aria-label', `${label} crop for ${person.name}`);
        if (key === 'x' || key === 'y') slider.title = 'At low zoom, there may be little room to pan. Increase Zoom to move a square portrait within the frame.';
        slider.oninput = () => {
          crop[key] = Number(slider.value);
          image.style.setProperty('--zoom', crop.zoom);
          image.style.setProperty('--x', `${crop.x}%`);
          image.style.setProperty('--y', `${crop.y}%`);
          description.textContent = `${label}: ${key === 'zoom' ? `${Number(crop[key]).toFixed(2)}x` : `${crop[key]}%`}`;
          queueStateSave();
        };
        tools.append(description, slider);
      }
      card.append(tools);
    }
    cards.append(card);
  });
  renderFoundry();
}

campaignSelect.onchange = async () => { state.campaign = campaignSelect.value; await saveState(); render(); };
$('#manageCampaigns').onclick = () => { renderManager(); manager.showModal(); };
$('#newCampaign').onclick = () => beginEdit({ id: '', label: '', title: '', channelId: '', people: [{ id: 'gm', name: 'Game Master', role: 'GM', image: 'assets/portrait-placeholder.svg', discordId: '' }] });
$('#cancelEdit').onclick = () => { editor.hidden = true; editingId = null; renderManager(); };
$('#addPerson').onclick = async () => { addPersonRow({ name: '', role: 'Player Character', image: 'assets/portrait-placeholder.svg', discordId: '' }); await refreshPortraitOptions(); };
$('#saveCampaign').onclick = async () => {
  const label = $('#campaignLabel').value.trim();
  if (!label) return $('#campaignLabel').focus();
  const people = [...peopleEditor.querySelectorAll('.person-row')].map(row => {
    const [name, role] = [...row.querySelectorAll('input')].map(input => input.value.trim());
    const foundryActorUuid = row.querySelector('.foundry-actor').value.trim();
    const image = row.querySelector('.portrait-select').value;
    const discordId = row.querySelector('.discord-select').value;
    const id = row.dataset.id || slug(name) || 'participant';
    return { id, name, role, image, discordId, foundryActorUuid };
  }).filter(person => person.name);
  if (!people.length) return alert('Add at least one participant.');
  const campaign = { foundryEnabled:$('#foundryEnabled').checked, foundryHealth:$('#foundryHealth').checked, foundryTurn:$('#foundryTurn').checked, id: editingId || slug(label), label, title: $('#campaignTitle').value.trim(), channelId: $('#channelId').value.trim(), people };
  if (!campaign.id) campaign.id = `campaign-${Date.now()}`;
  if (!editingId && config.campaigns.some(item => item.id === campaign.id)) campaign.id = `${campaign.id}-${Date.now().toString(36)}`;
  if (config.campaigns.some(item => item.id !== editingId && item.id === campaign.id)) return alert('A campaign with that name already exists.');
  try {
    const uniqueIds = new Set();
    people.forEach((person, index) => {
      if (uniqueIds.has(person.id)) person.id = `${person.id}-${index + 1}`;
      uniqueIds.add(person.id);
    });
    config.campaigns = editingId ? config.campaigns.map(item => item.id === editingId ? campaign : item) : [...config.campaigns, campaign];
    state.campaign = campaign.id;
    const session = currentSession(campaign.id);
    for (const personId of Object.keys(session.crops)) if (!people.some(person => person.id === personId)) delete session.crops[personId];
    for (const personId of Object.keys(session.absent)) if (!people.some(person => person.id === personId)) delete session.absent[personId];
    await saveConfig();
    editor.hidden = true; editingId = null; manager.close(); setNotice('Campaign saved.'); render();
  } catch (error) { alert(`Could not save campaign: ${error.message}`); }
};
$('#deleteCampaign').onclick = async () => {
  const campaign = config.campaigns.find(item => item.id === editingId);
  if (!campaign || !confirm(`Remove “${campaign.label}” and its saved portrait settings?`)) return;
  config.campaigns = config.campaigns.filter(item => item.id !== editingId);
  delete state.sessions[editingId];
  state.campaign = config.campaigns[0]?.id || '';
  try { await saveConfig(); editor.hidden = true; editingId = null; manager.close(); render(); }
  catch (error) { alert(`Could not remove campaign: ${error.message}`); }
};
$('#loadDiscordUsers').onclick = async () => {
  try {
    const response = await fetch('/api/discord/users', { cache: 'no-store' });
    discordUsers = await response.json();
    if (!discordUsers.length) setNotice('No Discord users are available yet. Start an automatic Discord bridge and make sure it is connected to this campaign’s voice channel, then try again.');
    else setNotice(`Loaded ${discordUsers.length} Discord voice channel member${discordUsers.length === 1 ? '' : 's'}.`);
    for (const row of peopleEditor.querySelectorAll('.person-row')) {
      const select = row.querySelector('.discord-select');
      const selected = select.value;
      fillDiscordOptions(select, selected);
    }
  } catch (error) { setNotice(`Could not load Discord users: ${error.message}`); }
};

function slug(value) { return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }
function renderManager() {
  const list = $('#managerList'); list.replaceChildren();
  if (!config.campaigns.length) { const empty=document.createElement('p'); empty.className='manager-empty'; empty.textContent='No campaigns yet. Add one to get started.'; list.append(empty); }
  for (const campaign of config.campaigns) {
    const row=document.createElement('div'); row.className='campaign-row';
    const label=document.createElement('strong'); label.textContent=`${campaign.label} · ${campaign.people.length} participant${campaign.people.length===1?'':'s'}`;
    const edit=document.createElement('button'); edit.className='button secondary'; edit.type='button'; edit.textContent='Edit'; edit.onclick=()=>beginEdit(campaign);
    row.append(label,edit); list.append(row);
  }
}
async function beginEdit(campaign) {
  editingId = campaign.id || null;
  $('#formHeading').textContent = editingId ? 'Edit campaign' : 'Add campaign';
  $('#campaignLabel').value = campaign.label || '';
  $('#campaignTitle').value = campaign.title || '';
  $('#channelId').value = campaign.channelId || '';
  $('#foundryEnabled').checked=campaign.foundryEnabled===true;
  $('#foundryHealth').checked=campaign.foundryHealth!==false;
  $('#foundryTurn').checked=campaign.foundryTurn!==false;
  updateAssetHint();
  $('#deleteCampaign').hidden = !editingId;
  peopleEditor.replaceChildren();
  (campaign.people || []).forEach(person => addPersonRow(person));
  editor.hidden = false;
  await refreshPortraitOptions();
  $('#campaignLabel').focus();
}
function addPersonRow(person) {
  const row=document.createElement('div'); row.className='person-row'; row.dataset.id=person.id || '';
  const fields=[['Name',person.name||'','Participant name'],['Role',person.role||'','Optional label']];
  fields.forEach(([label,value,placeholder])=>{const wrap=document.createElement('label');wrap.textContent=label;const input=document.createElement('input');input.value=value;input.placeholder=placeholder;wrap.append(input);row.append(wrap)});
  const portraitWrap=document.createElement('label');portraitWrap.textContent='Portrait';
  const portraitSelect=document.createElement('select');portraitSelect.className='portrait-select';portraitSelect.dataset.selected=person.image||'assets/portrait-placeholder.svg';
  portraitSelect.addEventListener('change',()=>{portraitSelect.dataset.selected=portraitSelect.value;});
  portraitWrap.append(portraitSelect);row.append(portraitWrap);
  const discordWrap=document.createElement('label');discordWrap.textContent='Discord speaker';
  const discordSelect=document.createElement('select');discordSelect.className='discord-select';
  fillDiscordOptions(discordSelect, person.discordId || '');
  discordWrap.append(discordSelect);row.append(discordWrap);
  const actorWrap=document.createElement('label');actorWrap.textContent='Foundry actor UUID';const actorInput=document.createElement('input');actorInput.className='foundry-actor';actorInput.value=person.foundryActorUuid||'';actorInput.placeholder='Actor.abc123 (optional)';actorInput.setAttribute('list','foundryActors');actorWrap.append(actorInput);row.append(actorWrap);
  const remove=document.createElement('button');remove.type='button';remove.className='button danger remove-person';remove.textContent='Remove';remove.onclick=()=>row.remove();row.append(remove);peopleEditor.append(row);
}
function editorCampaignId() { return editingId || slug($('#campaignLabel').value.trim()); }
function updateAssetHint() {
  const campaignId=editorCampaignId();
  $('#assetHint').textContent=campaignId ? `Add portrait images to assets/${campaignId}/, then select them from each Portrait dropdown.` : 'Enter a campaign name to see where to put its portrait images.';
}
async function refreshPortraitOptions() {
  const campaignId=editorCampaignId();
  const sequence=++assetRefreshSequence;
  let assets=[];
  let unavailable=false;
  if (campaignId) {
    try {
      const response=await fetch(`/api/assets?campaign=${encodeURIComponent(campaignId)}`,{cache:'no-store'});
      if (!response.ok) throw new Error('Asset list request failed');
      assets=await response.json();
    } catch { unavailable=true; }
  }
  if (sequence!==assetRefreshSequence || campaignId!==editorCampaignId()) return;
  updateAssetHint();
  if (unavailable) $('#assetHint').textContent += ' Restart the controller with npm start to load this folder.';
  for (const row of peopleEditor.querySelectorAll('.person-row')) {
    const select=row.querySelector('.portrait-select');
    const selected=select.value || select.dataset.selected || 'assets/portrait-placeholder.svg';
    select.replaceChildren();
    const placeholder=document.createElement('option');placeholder.value='assets/portrait-placeholder.svg';placeholder.textContent='Default placeholder';select.append(placeholder);
    if (selected && selected!=='assets/portrait-placeholder.svg' && !assets.includes(selected)) {
      const existing=document.createElement('option');existing.value=selected;existing.textContent=`Saved image outside folder (${selected})`;select.append(existing);
    }
    for (const imagePath of assets) {
      const option=document.createElement('option');option.value=imagePath;option.textContent=imagePath.split('/').pop();select.append(option);
    }
    select.value=selected || 'assets/portrait-placeholder.svg';
  }
}
$('#campaignLabel').addEventListener('input', updateAssetHint);
$('#campaignLabel').addEventListener('change', refreshPortraitOptions);
function fillDiscordOptions(select, selectedId) {
  select.replaceChildren();
  const none=document.createElement('option');none.value='';none.textContent='Not assigned';select.append(none);
  if (selectedId && !discordUsers.some(user => user.id === selectedId)) {
    const current=document.createElement('option');current.value=selectedId;current.textContent=`Saved Discord ID ${selectedId}`;select.append(current);
  }
  for (const user of discordUsers) {
    const option=document.createElement('option');option.value=user.id;option.textContent=user.label;select.append(option);
  }
  select.value=selectedId || '';
}

function renderFoundry(){
 const campaign=activeCampaign();
 const status=$('#foundryStatus');
 if(status){const connected=foundryCampaign===campaign?.id&&foundryState?.available;status.textContent=!campaign?.foundryEnabled?'Foundry: disabled':connected?'Foundry: connected':'Foundry: waiting for GM bridge';status.dataset.connected=String(!!connected);}
 const data=campaign?.foundryEnabled&&foundryCampaign===campaign.id&&foundryState?.available?foundryState:null;
 for(const card of cards.querySelectorAll('.portrait-card')){
  const person=campaign?.people.find(p=>p.id===card.dataset.personId);
  const matches=data?.characters.filter(c=>c.actorUuid===person?.foundryActorUuid)||[];
  const actor=matches.find(c=>c.activeTurn)||matches.find(c=>c.inCombat)||matches[0];
  const combat=data?.combat.active&&actor?.inCombat&&!card.classList.contains('absent');
  const turn=card.querySelector('.foundry-turn'),hp=card.querySelector('.foundry-health');
  turn.hidden=!(combat&&actor.activeTurn&&campaign.foundryTurn!==false);
  hp.hidden=!(combat&&actor.health&&campaign.foundryHealth!==false);
  if(!hp.hidden){
   const h=actor.health;hp.querySelector('.foundry-health-fill').style.width=Math.min(100,100*h.value/h.max)+'%';
   hp.querySelector('.foundry-health-temp').style.width=Math.min(100,100*(h.temp||0)/h.max)+'%';
   hp.title=h.value+'/'+h.max+' HP'+(h.temp?' + '+h.temp+' temporary HP':'');
  }
 }
}
async function refreshFoundry(){
 const campaign=activeCampaign();
 if(!campaign?.foundryEnabled){foundryState=null;renderFoundry();return;}
 if(foundryRequest)return;foundryRequest=true;
 try{const response=await fetch('/api/foundry?campaign='+encodeURIComponent(campaign.id),{cache:'no-store'});if(!response.ok)throw Error('Unavailable');const next=await response.json();if(activeCampaign()?.id===campaign.id){foundryCampaign=campaign.id;foundryState=next;renderFoundry();}}catch{foundryState=null;renderFoundry();}finally{foundryRequest=false;}
}
$('#foundryPair').onclick=async()=>{
 try{const response=await fetch('/api/foundry/pair');if(!response.ok)throw Error('Pairing unavailable');const data=await response.json();$('#pairCampaign').value=data.campaign;$('#pairKey').value=data.key;$('#pairDialog').showModal();}catch(e){setNotice(e.message);}
};
$('#rotatePair').onclick=async()=>{if(!confirm('Revoke all saved Foundry bridge credentials? Each campaign will need to be paired again.'))return;const response=await fetch('/api/foundry/pair',{method:'POST'});if(response.ok){$('#pairDialog').close();$('#foundryPair').click();}};
$('#loadFoundryActors').onclick=async()=>{
 try{const response=await fetch('/api/foundry?campaign='+encodeURIComponent(editingId||state.campaign));const data=await response.json();const list=$('#foundryActors');list.replaceChildren();for(const actor of data.characters||[]){const option=document.createElement('option');option.value=actor.actorUuid;option.label=actor.name;list.append(option);}setNotice(data.characters?.length?'Foundry actors loaded. Select a UUID in each participant row.':'No Foundry actor data. Connect the GM bridge first.');}catch(e){setNotice(e.message);}
};
loadAll().then(() => {
  void refreshFoundry();setInterval(refreshFoundry,600);

  if (params.has('overlay')) campaignSelect.hidden = true;
  setInterval(async () => {
    if (!params.has('overlay') && manager.open) return;
    try {
      const response = await fetch('/api/state', { cache: 'no-store' });
      const next = await response.json();
      if (JSON.stringify(next) !== JSON.stringify(state)) { state = next; render(); }
    } catch {}
  }, 600);
}).catch(error => setNotice(error.message));
