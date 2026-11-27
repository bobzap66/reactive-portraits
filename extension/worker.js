// One explicitly paired GM tab. Secrets stay in extension session storage.
const endpoint="http://127.0.0.1:8766/api/foundry";
let queue=Promise.resolve();
async function send(b,snapshot){
 const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+b.secret},body:JSON.stringify({campaign:b.campaign,snapshot}),signal:AbortSignal.timeout(4000)});
 if(!response.ok)throw Error("Local controller rejected bridge: "+response.status);
}
async function install(b){
 await chrome.scripting.executeScript({target:{tabId:b.tabId},world:"ISOLATED",func:(channel)=>{
  globalThis.__rpRelayCleanup?.();
  const relay=e=>{if(e.source===window&&e.data?.kind==="rp-foundry"&&e.data.channel===channel)chrome.runtime.sendMessage({kind:"snapshot",channel,snapshot:e.data.snapshot}).catch(()=>{});};
  window.addEventListener("message",relay);
  globalThis.__rpRelayCleanup=()=>window.removeEventListener("message",relay);
 },args:[b.channel]});
 await chrome.scripting.executeScript({target:{tabId:b.tabId},world:"MAIN",func:(channel)=>{
  globalThis.__rpFoundryCleanup?.();
  const api=globalThis.game?.modules?.get("greene-gaming-stream-director")?.api?.gmIntegration;
  if(!api)throw Error("Stream Director API unavailable");
  const emit=snapshot=>window.postMessage({kind:"rp-foundry",channel,snapshot},location.origin);
  const stop=api.subscribe(emit);
  const heartbeat=setInterval(()=>emit(api.getSnapshot()),3000);
  globalThis.__rpFoundryCleanup=()=>{stop();clearInterval(heartbeat);};
 },args:[b.channel]});
}
async function read(tabId){
 const [r]=await chrome.scripting.executeScript({target:{tabId},world:"MAIN",func:()=>{
  const g=globalThis.game,api=g?.modules?.get("greene-gaming-stream-director")?.api?.gmIntegration;
  return api?.getSnapshot?.()??null;
 }});
 return r?.result;
}
async function detach(b){
 if(!b)return;
 try{await chrome.scripting.executeScript({target:{tabId:b.tabId},world:"MAIN",func:()=>globalThis.__rpFoundryCleanup?.()});}catch{}
 try{await chrome.scripting.executeScript({target:{tabId:b.tabId},world:"ISOLATED",func:()=>globalThis.__rpRelayCleanup?.()});}catch{}
 try{await send(b,{apiVersion:1,available:false});}catch{}
}
async function tick(){
 const {bridge:b}=await chrome.storage.session.get("bridge");if(!b)return;
 try{
  const s=await read(b.tabId);if(!s)throw Error("Stream Director API unavailable");
  await send(b,s);
  await install(b);
  b.status=s.available?"Connected":"GM portrait API unavailable";
 }catch(e){b.status=e.message;await detach(b);}
 await chrome.storage.session.set({bridge:b});
}
function serial(fn){const task=queue.catch(()=>{}).then(fn);queue=task;return task;}
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
 if(sender.id!==chrome.runtime.id)return;
 if(sender.tab){
  if(msg.kind!=="snapshot")return;
  serial(async()=>{const {bridge:b}=await chrome.storage.session.get("bridge");if(b&&sender.tab.id===b.tabId&&msg.channel===b.channel){await send(b,msg.snapshot);return {ok:true};}return {ok:false};}).then(reply,e=>reply({error:e.message}));return true;
 }
 serial(async()=>{
  if(msg.kind==="connect"){
   const s=await read(msg.tabId);if(!s?.available)throw Error("Open the GM browser and enable Stream Director GM portrait integration first");
   const {bridge:old}=await chrome.storage.session.get("bridge");await detach(old);
   const b={tabId:msg.tabId,campaign:msg.campaign,secret:msg.secret,channel:crypto.randomUUID(),status:"Connected"};
   await send(b,s);await chrome.storage.session.set({bridge:b});await install(b);
   await chrome.alarms.create("heartbeat",{periodInMinutes:0.5});
   return {status:"Connected"};
  }
  if(msg.kind==="disconnect"){const {bridge}=await chrome.storage.session.get("bridge");await detach(bridge);await chrome.storage.session.remove("bridge");await chrome.alarms.clear("heartbeat");return {status:"Disconnected"};}
  return {error:"Unknown request"};
 }).then(reply,e=>reply({error:e.message}));return true;
});
chrome.alarms.onAlarm.addListener(a=>{if(a.name==="heartbeat")void serial(tick);});
chrome.tabs.onRemoved.addListener(tabId=>void serial(async()=>{const {bridge}=await chrome.storage.session.get("bridge");if(bridge?.tabId===tabId){await detach(bridge);await chrome.storage.session.remove("bridge");await chrome.alarms.clear("heartbeat");}}));
