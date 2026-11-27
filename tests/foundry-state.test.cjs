const test=require('node:test');
const assert=require('node:assert/strict');
const {matchesSecret,sanitizeSnapshot,createStore}=require('../foundry-state.cjs');
const snapshot={apiVersion:1,available:true,combat:{active:true},characters:[{actorUuid:'Actor.a',name:'Hero',health:{value:20,max:30,temp:5},inCombat:true,activeTurn:true,secret:'discard'}]};
test('pairing key must match',()=>{assert.equal(matchesSecret('abc','abc'),true);assert.equal(matchesSecret('abd','abc'),false);assert.equal(matchesSecret('',''),false);});
test('snapshot contains only supported fields',()=>{const s=sanitizeSnapshot(snapshot);assert.equal(s.characters[0].health.temp,5);assert.equal(s.characters[0].activeTurn,true);assert.equal(s.characters[0].secret,undefined);});
test('combat ending clears turn flags',()=>{const s=sanitizeSnapshot({...snapshot,combat:{active:false}});assert.equal(s.characters[0].activeTurn,false);assert.equal(s.characters[0].inCombat,false);});
test('campaign separation and expiry',()=>{let time=0;const store=createStore({now:()=>time});store.put('one',snapshot);assert.equal(store.get('one').available,true);assert.equal(store.get('two').available,false);time=12000;assert.equal(store.get('one').available,false);});
test('invalid snapshot rejected',()=>assert.throws(()=>sanitizeSnapshot({apiVersion:2,available:true})));
