const test=require('node:test'),assert=require('node:assert/strict');
const {allowOverlayRead}=require('../overlay-access.cjs');
const origins=['http://127.0.0.1:8766','http://localhost:8766'];
test('local overlay allows OBS without metadata, direct navigation and same-origin fetch',()=>{for(const site of [undefined,'none','same-origin'])assert.equal(allowOverlayRead({'sec-fetch-site':site},origins),true);assert.equal(allowOverlayRead({origin:origins[0],'sec-fetch-site':'same-origin'},origins),true);});
test('cross-origin overlay requests are rejected',()=>{for(const site of ['cross-site','same-site'])assert.equal(allowOverlayRead({'sec-fetch-site':site},origins),false);assert.equal(allowOverlayRead({origin:'https://example.org'},origins),false);});
