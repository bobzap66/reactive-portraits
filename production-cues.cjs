// In-memory, read-only production cues. No OBS commands are issued here.
function createCues({now=Date.now}={}){
 let key=null,entered=0,ready=false,deadline=null,breakTimer=null;
 function update({connected,enabled,active,campaign,scene,sceneEpoch,mappings}){
  const next=connected&&enabled&&active&&scene?JSON.stringify([campaign,scene,sceneEpoch,mappings?.intro,mappings?.break,mappings?.technical]):null;
  if(next!==key){key=next;entered=now();ready=false;deadline=null;breakTimer=null;}
  return key!==null;
 }
 function snapshot(s){if(!update(s))return null;return {id:key,elapsedMs:Math.max(0,now()-entered),introReady:ready&&s.scene===s.mappings?.intro,introRemainingMs:deadline===null?null:Math.max(0,deadline-now()),breakTimer:s.scene===s.mappings?.break?breakSnapshot():null};}
 function complete(s){if(!update(s)||!s.mappings?.intro||s.scene!==s.mappings.intro)return false;ready=true;return true;}
 function countdown(s,remainingMs){if(!update(s)||s.scene!==s.mappings?.intro||!Number.isFinite(remainingMs)||remainingMs<0||remainingMs>86400000||ready)return false;deadline=now()+remainingMs;return true;}
 function breakSnapshot(){if(!breakTimer)return {mode:'indefinite',remainingMs:null};return {mode:breakTimer.mode,remainingMs:breakTimer.mode==='indefinite'?null:breakTimer.mode==='paused'?breakTimer.remainingMs:Math.max(0,breakTimer.deadline-now())};}
 function controlBreak(s,action,minutes){
  if(!update(s)||!s.mappings?.break||s.scene!==s.mappings.break)return false;
  const current=breakSnapshot();
  if(action==='start'){
   if(minutes===null){breakTimer={mode:'indefinite'};return true;}
   if(!Number.isInteger(minutes)||minutes<1||minutes>120)return false;
   breakTimer={mode:'running',deadline:now()+minutes*60000};return true;
  }
  if(current.mode==='indefinite')return false;
  if(action==='extend'&&[1,5].includes(minutes)){const remaining=Math.min(7200000,current.remainingMs+minutes*60000);breakTimer=current.mode==='paused'?{mode:'paused',remainingMs:remaining}:{mode:'running',deadline:now()+remaining};return true;}
  if(action==='pause'&&current.mode==='running'&&current.remainingMs>0){breakTimer={mode:'paused',remainingMs:current.remainingMs};return true;}
  if(action==='resume'&&current.mode==='paused'){breakTimer={mode:'running',deadline:now()+current.remainingMs};return true;}
  return false;
 }
 return {snapshot,complete,countdown,controlBreak,reset(){key=null;ready=false;deadline=null;}};
}
module.exports={createCues};
