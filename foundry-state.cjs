const { timingSafeEqual }=require('node:crypto');
const safeId=v=>typeof v==='string'&&v.length>0&&v.length<=200;
const number=v=>typeof v==='number'&&Number.isFinite(v);
function matchesSecret(provided,expected){
 if(typeof provided!=='string'||typeof expected!=='string'||!expected)return false;
 const a=Buffer.from(provided),b=Buffer.from(expected);
 return a.length===b.length&&timingSafeEqual(a,b);
}
function sanitizeSnapshot(value){
 if(!value||value.apiVersion!==1||typeof value.available!=='boolean')throw Error('Unsupported snapshot');
 if(!value.available)return {available:false,combat:{active:false},characters:[]};
 if(!Array.isArray(value.characters)||value.characters.length>200)throw Error('Invalid characters');
 const active=value.combat?.active===true;
 const rows=[];
 for(const c of value.characters){
  if(!safeId(c?.actorUuid)||typeof c.name!=='string')continue;
  const h=c.health;
  const health=h&&number(h.value)&&number(h.max)&&h.max>0?{value:Math.max(0,h.value),max:h.max,temp:number(h.temp)?Math.max(0,h.temp):null}:null;
  rows.push({actorUuid:c.actorUuid,name:c.name.slice(0,120),health,inCombat:active&&c.inCombat===true,activeTurn:active&&c.inCombat===true&&c.activeTurn===true});
 }
 return {available:true,combat:{active},characters:rows};
}
function createStore({ttl=12000,now=Date.now}={}){
 const states=new Map();
 return {
  put(campaign,snapshot){states.set(campaign,{snapshot:sanitizeSnapshot(snapshot),at:now()});},
  get(campaign){const entry=states.get(campaign);return entry&&now()-entry.at<ttl?entry.snapshot:{available:false,combat:{active:false},characters:[]};},
  clear(){states.clear();}
 };
}
module.exports={matchesSecret,sanitizeSnapshot,createStore};
