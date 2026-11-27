// In-memory, read-only production cues. No OBS commands are issued here.
function createCues({now=Date.now}={}){
 let key=null,entered=0,ready=false;
 function update({connected,enabled,active,campaign,scene,sceneEpoch,mappings}){
  const next=connected&&enabled&&active&&scene?JSON.stringify([campaign,scene,sceneEpoch,mappings?.intro,mappings?.break,mappings?.technical]):null;
  if(next!==key){key=next;entered=now();ready=false;}
  return key!==null;
 }
 function snapshot(s){if(!update(s))return null;return {id:key,elapsedMs:Math.max(0,now()-entered),introReady:ready&&s.scene===s.mappings?.intro};}
 function complete(s){if(!update(s)||!s.mappings?.intro||s.scene!==s.mappings.intro)return false;ready=true;return true;}
 return {snapshot,complete,reset(){key=null;ready=false;}};
}
module.exports={createCues};
