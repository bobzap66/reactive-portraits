const WebSocket=require('ws');
const {createHash,randomUUID}=require('node:crypto');
const roles=Object.freeze(['standby','intro','gameplay','break','technical','ending','artwork','cinematic']);
const hash=s=>createHash('sha256').update(s).digest('base64');
function authentication(password,salt,challenge){return hash(hash(password+salt)+challenge);}
function mapping(value,scenes){
 const result={};for(const role of roles){const scene=value?.[role];if(scene===undefined||scene==='')continue;if(typeof scene!=='string'||!scenes.includes(scene))throw Error('Unknown OBS scene for '+role);result[role]=scene;}return result;
}
function targetFor({enabled,activeCampaign,campaign,mappings,status,role,expectedScene}){
 if(!enabled||!status.connected)throw Error('OBS unavailable');
 if(campaign!==activeCampaign)throw Error('Select this campaign in Reactive Portraits first');
 if(!roles.includes(role))throw Error('Unsupported production role');
 if(typeof expectedScene!=='string'||status.scene!==expectedScene)throw Error('OBS scene changed; review and try again');
 const scene=mappings?.[role];if(!scene||!status.scenes.includes(scene))throw Error('Scene is not mapped or no longer exists');return scene;
}
function createOBS({WebSocketImpl=WebSocket}={}){
 let socket=null,settings={},identified=false,connecting=false,refreshing=false,generation=0,lastRefresh=0;
 let status={connected:false,scene:null,scenes:[],streaming:false,recording:false,error:''};
 const pending=new Map();
 const reset=error=>{identified=false;connecting=false;refreshing=false;lastRefresh=0;status={connected:false,scene:null,scenes:[],streaming:false,recording:false,error};for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error(error||'OBS disconnected'));}pending.clear();};
 function close(){generation++;const old=socket;socket=null;reset('');try{old?.terminate();}catch{}}
 function request(type,data={}){
  if(!identified||socket?.readyState!==WebSocketImpl.OPEN)return Promise.reject(Error('OBS disconnected'));
  return new Promise((resolve,reject)=>{const requestId=randomUUID(),timer=setTimeout(()=>{pending.delete(requestId);reject(Error('OBS request timed out'));},3000);pending.set(requestId,{resolve,reject,timer});try{socket.send(JSON.stringify({op:6,d:{requestType:type,requestId,requestData:data}}));}catch(e){clearTimeout(timer);pending.delete(requestId);reject(e);}});
 }
 async function refresh(){
  if(!identified||refreshing)return;refreshing=true;const gen=generation;
  try{const [sc,st,rec]=await Promise.all([request('GetSceneList'),request('GetStreamStatus'),request('GetRecordStatus')]);if(gen!==generation)return;
   status={connected:true,scene:sc.currentProgramSceneName,scenes:sc.scenes.map(s=>s.sceneName),streaming:st.outputActive===true,recording:rec.outputActive===true,error:''};lastRefresh=Date.now();
  }catch(e){if(gen===generation){close();status.error=e.message;}}finally{if(gen===generation)refreshing=false;}
 }
 function connect(){
  if(!settings.enabled||socket||connecting)return;connecting=true;const gen=++generation;
  const ws=new WebSocketImpl('ws://127.0.0.1:'+settings.port,{handshakeTimeout:3000,maxPayload:1024*1024});socket=ws;
  const timeout=setTimeout(()=>{if(gen===generation&&!identified){close();status.error='OBS handshake timed out';}},5000);
  ws.on('message',raw=>{if(gen!==generation)return;try{const {op,d}=JSON.parse(raw.toString());
   if(op===0){const auth=d.authentication;ws.send(JSON.stringify({op:1,d:{rpcVersion:1,eventSubscriptions:0,...(auth?{authentication:authentication(settings.password||'',auth.salt,auth.challenge)}:{})}}));}
   if(op===2){clearTimeout(timeout);identified=true;connecting=false;void refresh();}
   if(op===7){const p=pending.get(d.requestId);if(!p)return;pending.delete(d.requestId);clearTimeout(p.timer);if(d.requestStatus?.result)p.resolve(d.responseData||{});else p.reject(Error(d.requestStatus?.comment||'OBS rejected request'));}
  }catch{close();status.error='Invalid OBS response';}});
  const failed=message=>{clearTimeout(timeout);if(gen!==generation)return;generation++;socket=null;reset(message);try{ws.terminate();}catch{}};
  ws.on('error',()=>failed('Cannot connect to OBS WebSocket'));ws.on('close',code=>failed(code===4009?'Authentication failed — check the OBS password':code===4010?'OBS RPC version incompatible':'OBS disconnected ('+code+')'));
 }
 const timer=setInterval(()=>{if(!settings.enabled)return;if(!socket)connect();else if(identified)void refresh();},2000);timer.unref?.();
 return {configure(next){close();settings={...next};if(settings.enabled)connect();},getStatus(){return {...status,connected:status.connected&&Date.now()-lastRefresh<7000,scenes:[...status.scenes]};},async switchScene(scene,expectedScene,stillAllowed=()=>true){const current=await request('GetCurrentProgramScene');if(current.currentProgramSceneName!==expectedScene||!stillAllowed())throw Error('Production state changed; review and try again');await request('SetCurrentProgramScene',{sceneName:scene});await refresh();},close};
}
module.exports={roles,authentication,mapping,targetFor,createOBS};
