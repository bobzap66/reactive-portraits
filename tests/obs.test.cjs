const test=require('node:test'),assert=require('node:assert/strict');
const {authentication,mapping,targetFor}=require('../obs.cjs');
test('authentication produces deterministic SHA256 base64 response',()=>{assert.equal(authentication('p','s','c').length,44);assert.notEqual(authentication('p','s','c'),authentication('q','s','c'));});
test('only known scene names and roles can be mapped',()=>{assert.deepEqual(mapping({gameplay:'Game',bad:'Other'},['Game']),{gameplay:'Game'});assert.throws(()=>mapping({gameplay:'Missing'},['Game']));});
test('manual scene switch requires matching active campaign and expected current program scene',()=>{const args={enabled:true,activeCampaign:'a',campaign:'a',mappings:{gameplay:'Game'},status:{connected:true,scene:'Intro',scenes:['Intro','Game']},role:'gameplay',expectedScene:'Intro'};assert.equal(targetFor(args),'Game');for(const override of [{enabled:false},{campaign:'b'},{expectedScene:'Break'},{role:'StartStream'},{mappings:{gameplay:'Missing'}},{status:{...args.status,connected:false}}])assert.throws(()=>targetFor({...args,...override}));});

test('standby and technical difficulties are independent optional roles',()=>{const maps=mapping({standby:'Quiet',intro:'Intro',technical:'Trouble',gameplay:'Game'},['Quiet','Intro','Trouble','Game']);assert.deepEqual(maps,{standby:'Quiet',intro:'Intro',gameplay:'Game',technical:'Trouble'});assert.deepEqual(mapping({intro:'Intro'},['Intro']),{intro:'Intro'});const args={enabled:true,activeCampaign:'a',campaign:'a',mappings:maps,status:{connected:true,scene:'Intro',scenes:['Quiet','Intro','Trouble','Game']},expectedScene:'Intro'};assert.equal(targetFor({...args,role:'standby'}),'Quiet');assert.equal(targetFor({...args,role:'technical'}),'Trouble');});

test('late duplicate scene event does not invalidate a confirmed break timer',async()=>{
 const {EventEmitter}=require('node:events');
 const {createOBS}=require('../obs.cjs');
 const {createCues}=require('../production-cues.cjs');
 let ws,scene='Game';
 class FakeWS extends EventEmitter {
  static OPEN=1;
  readyState=1;
  constructor(){super();ws=this;}
  send(raw){const {op,d}=JSON.parse(raw);if(op!==6)return;
   let responseData={};
   if(d.requestType==='GetSceneList')responseData={currentProgramSceneName:scene,scenes:[{sceneName:'Game'},{sceneName:'Break'}]};
   if(d.requestType==='GetCurrentProgramScene')responseData={currentProgramSceneName:scene};
   if(d.requestType==='SetCurrentProgramScene')scene=d.requestData.sceneName;
   queueMicrotask(()=>this.emit('message',JSON.stringify({op:7,d:{requestId:d.requestId,requestStatus:{result:true},responseData}})));
  }
  terminate(){}
 }
 const obs=createOBS({WebSocketImpl:FakeWS});
 try {
  obs.configure({enabled:true,port:4455});ws.emit('message',JSON.stringify({op:2,d:{}}));
  await new Promise(resolve=>setImmediate(resolve));
  await obs.switchScene('Break','Game');
  const snapshot=()=>({...obs.getStatus(),enabled:true,active:true,campaign:'a',mappings:{break:'Break'}});
  const cues=createCues();
  assert.equal(cues.controlBreak(snapshot(),'start',5),true);
  const epoch=obs.getStatus().sceneEpoch;
  ws.emit('message',JSON.stringify({op:5,d:{eventType:'CurrentProgramSceneChanged',eventData:{sceneName:'Break'}}}));
  assert.equal(obs.getStatus().sceneEpoch,epoch);
  assert.equal(cues.snapshot(snapshot()).breakTimer.mode,'running');
  ws.emit('message',JSON.stringify({op:5,d:{eventType:'CurrentProgramSceneChanged',eventData:{sceneName:'Game'}}}));
  assert.equal(cues.snapshot(snapshot()).breakTimer,null);
 } finally {obs.configure({enabled:false});}
});
