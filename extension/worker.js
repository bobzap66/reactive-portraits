// Persistent, explicitly authorized origins and world-to-campaign mappings.
const endpoint="http://127.0.0.1:8766/api/foundry";
const obsEndpoint="http://127.0.0.1:8766/api/obs";
async function obsRequest(b,role,expectedScene){
 const headers={"Authorization":"Bearer "+b.secret};
 const response=await fetch(role?obsEndpoint+"/scene":obsEndpoint+"/status?campaign="+encodeURIComponent(b.campaign),{headers:{...headers,...(role?{"Content-Type":"application/json"}:{})},...(role?{method:"POST",body:JSON.stringify({campaign:b.campaign,role,expectedScene})}:{}),signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw Error((await response.text()).slice(0,200));return response.json();
}
let queue=Promise.resolve();
const serial=fn=>{const task=queue.catch(()=>{}).then(fn);queue=task;return task;};
async function saved(){return (await chrome.storage.local.get("pairings")).pairings||[];}
async function live(){return (await chrome.storage.session.get("connections")).connections||[];}
async function saveLive(connections){await chrome.storage.session.set({connections});}
async function read(tabId){
 const [r]=await chrome.scripting.executeScript({target:{tabId},world:"MAIN",func:()=>{
  const g=globalThis.game,api=g?.modules?.get("greene-gaming-stream-director")?.api?.gmIntegration;
  if(!g?.ready||!g.user?.isGM||!g.world?.id||!api)return null;
  return {origin:location.origin,world:String(g.world.id),snapshot:api.getSnapshot()};
 }});
 return r?.result;
}
async function send(b,snapshot){
 const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+b.secret},body:JSON.stringify({campaign:b.campaign,snapshot}),signal:AbortSignal.timeout(4000)});
 if(!response.ok)throw Error("Local controller rejected bridge: "+response.status);
}
async function install(b){
 await chrome.scripting.executeScript({target:{tabId:b.tabId},world:"ISOLATED",func:(channel)=>{
  globalThis.__rpRelayCleanup?.();
  const relay=e=>{if(e.source===window&&e.data?.kind==="rp-foundry"&&e.data.channel===channel)chrome.runtime.sendMessage({kind:"snapshot",channel,world:e.data.world,snapshot:e.data.snapshot}).catch(()=>{});};
  const obsRelay=e=>{if(e.source!==window||e.origin!==location.origin||e.data?.kind!=="rp-obs-request"||e.data.channel!==channel)return;
   const {id,world,role,expectedScene}=e.data;
   if(typeof id!=="string"||id.length>100)return;
   chrome.runtime.sendMessage({kind:"obs",channel,world,role,expectedScene}).then(result=>window.postMessage({kind:"rp-obs-response",channel,id,result},location.origin)).catch(()=>{});
  };
  window.addEventListener("message",relay);window.addEventListener("message",obsRelay);
  globalThis.__rpRelayCleanup=()=>{window.removeEventListener("message",relay);window.removeEventListener("message",obsRelay);};
 },args:[b.channel]});
 await chrome.scripting.executeScript({target:{tabId:b.tabId},world:"MAIN",func:(channel,world)=>{
  globalThis.__rpFoundryCleanup?.();
  const g=globalThis.game,api=g?.modules?.get("greene-gaming-stream-director")?.api?.gmIntegration;
  if(!g?.user?.isGM||String(g.world?.id)!==world||!api)throw Error("Wrong Foundry world or GM API unavailable");
  const emit=snapshot=>{if(globalThis.game?.user?.isGM&&String(globalThis.game?.world?.id)===world)window.postMessage({kind:"rp-foundry",channel,world,snapshot},location.origin);};
  const stop=api.subscribe(emit);
  const heartbeat=setInterval(()=>emit(api.getSnapshot()),3000);
  const production=g.modules.get("greene-gaming-stream-director")?.api?.obsProduction;
  const detachProduction=production?.attach?.({request:({role,expectedScene}={})=>new Promise((resolve,reject)=>{
   if(!globalThis.game?.user?.isGM||String(globalThis.game?.world?.id)!==world){reject(Error("Wrong GM world"));return;}
   const id=crypto.randomUUID();
   const cleanup=()=>{clearTimeout(timeout);window.removeEventListener("message",response);};
   const response=e=>{if(e.source!==window||e.origin!==location.origin||e.data?.kind!=="rp-obs-response"||e.data.channel!==channel||e.data.id!==id)return;cleanup();const result=e.data.result;if(result?.error)reject(Error(result.error));else resolve(result?.status);};
   const timeout=setTimeout(()=>{cleanup();reject(Error("OBS bridge timed out"));},6000);
   window.addEventListener("message",response);window.postMessage({kind:"rp-obs-request",channel,id,world,role,expectedScene},location.origin);
  })});
  globalThis.__rpFoundryCleanup=()=>{stop();clearInterval(heartbeat);detachProduction?.();};
 },args:[b.channel,b.world]});
}
async function detach(b){
 try{await chrome.scripting.executeScript({target:{tabId:b.tabId},world:"MAIN",func:()=>globalThis.__rpFoundryCleanup?.()});}catch{}
 try{await chrome.scripting.executeScript({target:{tabId:b.tabId},world:"ISOLATED",func:()=>globalThis.__rpRelayCleanup?.()});}catch{}
 try{await send(b,{apiVersion:1,available:false});}catch{}
}
async function removeWhere(predicate){
 const connections=await live(),removed=connections.filter(predicate);
 await saveLive(connections.filter(b=>!predicate(b)));
 for(const b of removed)await detach(b);
}
async function connect(tabId,identity,pairing){
 if(!identity?.snapshot?.available)return;
 const existing=(await live()).find(b=>b.tabId===tabId&&b.origin===identity.origin&&b.world===identity.world&&b.campaign===pairing.campaign);
 if(existing)return;
 await removeWhere(b=>b.tabId===tabId||b.campaign===pairing.campaign);
 const b={...pairing,tabId,channel:crypto.randomUUID()};
 await send(b,identity.snapshot);
 await saveLive([...(await live()),b]);
 try{await install(b);}catch(e){await removeWhere(x=>x.channel===b.channel);throw e;}
}
async function reconcile(){
 const pairings=await saved();
 const tabs=await chrome.tabs.query({});
 const connections=await live();
 for(const b of connections){
  const tab=tabs.find(t=>t.id===b.tabId);
  if(!tab||!pairings.some(p=>p.origin===b.origin&&p.world===b.world&&p.campaign===b.campaign&&p.secret===b.secret)||!tab.url?.startsWith(b.origin+"/")){
   await removeWhere(x=>x.channel===b.channel);continue;
  }
  try{
   const identity=await read(b.tabId);
   if(!identity?.snapshot?.available||identity.origin!==b.origin||identity.world!==b.world){await removeWhere(x=>x.channel===b.channel);continue;}
   await send(b,identity.snapshot);
   // A reload can destroy the page subscription without changing the tab ID.
   await install(b);
  }catch{await removeWhere(x=>x.channel===b.channel);}
 }
 for(const tab of tabs){
  if(!tab.url||tab.status!=="complete"||(await live()).some(b=>b.tabId===tab.id))continue;
  let origin;try{origin=new URL(tab.url).origin;}catch{continue;}
  if(!pairings.some(p=>p.origin===origin))continue;
  try{
   const identity=await read(tab.id);
   const p=pairings.find(p=>p.origin===identity?.origin&&p.world===identity?.world);
   if(p&&!(await live()).some(b=>b.campaign===p.campaign))await connect(tab.id,identity,p);
  }catch{}
 }
}
async function start(){await chrome.alarms.create("heartbeat",{periodInMinutes:0.5});await reconcile();}
chrome.runtime.onInstalled.addListener(()=>void serial(start));
chrome.runtime.onStartup.addListener(()=>void serial(start));
chrome.alarms.onAlarm.addListener(a=>{if(a.name==="heartbeat")void serial(reconcile);});
chrome.tabs.onUpdated.addListener((tabId,change)=>{if(change.status==="loading"||change.url)void serial(()=>removeWhere(b=>b.tabId===tabId));if(change.status==="complete")void serial(reconcile);});
chrome.tabs.onRemoved.addListener(tabId=>void serial(()=>removeWhere(b=>b.tabId===tabId)));
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
 if(sender.id!==chrome.runtime.id)return;
 if(sender.tab){
  if(!["snapshot","obs"].includes(msg.kind)||sender.frameId!==0)return;
  serial(async()=>{
   const b=(await live()).find(b=>b.tabId===sender.tab.id&&b.channel===msg.channel&&b.world===msg.world&&sender.origin===b.origin);
   if(!b)return {error:"GM bridge unavailable"};
   if(msg.kind==="obs"){const identity=await read(b.tabId);if(!identity?.snapshot?.available||identity.origin!==b.origin||identity.world!==b.world)return {error:"GM bridge unavailable"};return {status:await obsRequest(b,msg.role,msg.expectedScene)};}
   try{await send(b,msg.snapshot);return {ok:true};}catch(e){await removeWhere(x=>x.channel===b.channel);return {error:e.message};}
  }).then(reply,e=>reply({error:e.message}));return true;
 }
 serial(async()=>{
  if(msg.kind==="status"){
   const pairings=await saved(),connections=await live();
   return {pairings:pairings.map(({origin,world,campaign})=>({origin,world,campaign,connected:connections.some(b=>b.origin===origin&&b.world===world&&b.campaign===campaign)}))};
  }
  if(msg.kind==="connect"){
   const identity=await read(msg.tabId);
   if(!identity?.snapshot?.available)throw Error("Open the GM browser and enable Stream Director GM portrait integration first");
   if(!await chrome.permissions.contains({origins:[identity.origin+"/*"]}))throw Error("Allow access to this Foundry site for automatic reconnection");
   const b={origin:identity.origin,world:identity.world,campaign:msg.campaign,secret:msg.secret};
   // Verify the credential before replacing any saved mapping.
   await send(b,identity.snapshot);
   await removeWhere(x=>x.campaign===b.campaign||x.origin===b.origin&&x.world===b.world);
   const pairings=(await saved()).filter(p=>p.campaign!==b.campaign&&!(p.origin===b.origin&&p.world===b.world));
   await chrome.storage.local.set({pairings:[...pairings,b]});
   await connect(msg.tabId,identity,b);await chrome.alarms.create("heartbeat",{periodInMinutes:0.5});
   return {status:"Paired and connected"};
  }
  if(msg.kind==="forget"){
   const match=p=>p.origin===msg.origin&&p.world===msg.world;
   const pairings=(await saved()).filter(p=>!match(p));
   await chrome.storage.local.set({pairings});
   await removeWhere(match);
   if(!pairings.some(p=>p.origin===msg.origin))await chrome.permissions.remove({origins:[msg.origin+"/*"]});
   return {status:"Unpaired"};
  }
  if(msg.kind==="reconnect"){await reconcile();return {status:"Reconnect check complete"};}
  return {error:"Unknown request"};
 }).then(reply,e=>reply({error:e.message}));return true;
});
