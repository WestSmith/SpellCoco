import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {client,state,room,plain,flush} from './helpers.mjs';
const online='NET.async=true;NET.mode="host";UI_MODE="host";NET.code="ROOM1";NET.myName="Shawn";NET.seat=1;NET.myIndex=1;NET.rev=0;NET.gameCode="ROOM1";NET.caps={livesel:true};';
const deliver=(c,m)=>{c.ctx.reply=plain(m);c.run('asyncOnMessage(reply)')};
const push=(h,m)=>h.r.onMessage(h.sockets[1],JSON.stringify(m));
function quota(c,limit){
 c.ctx.entries=()=>[...c.saved];c.ctx.limit=limit;
 c.run(`console={...console,warn:()=>{}};const store=localStorage.setItem;localStorage.setItem=(k,v)=>{
 const total=entries().filter(([key])=>key!==k).reduce((n,[key,value])=>n+key.length+value.length,0)+k.length+v.length;
 if(total>limit)throw Error('QuotaExceededError');return store(k,v)}`);
}
function closing(kind){
 const st={...state(),id:'match00002',turnIndex:1};[...'CAT'].forEach((ch,i)=>st.tiles[i].char=ch);
 if(kind==='timeout'){st.cocoTimerActive=true;st.timeLeft=1}
 const c=client();c.load(st,online+'CONFIG.rounds=1;buildTrie(["CAT"]);');return {st,c};
}
function finish(c,kind){
 if(kind==='word')c.run('game.handleTileClick(0);game.handleTileClick(1);game.handleTileClick(2);game.submitWord()');
 else{c.fire(c.run('game.timerInterval'));c.fireDelay(800)}
}
async function refresh(c,h,limit){
 const f=client();for(const [k,v]of c.saved)f.saved.set(k,v);if(limit)quota(f,limit);
 f.run(online+'STATS=lsGet("spellcoco.stats",STATS);NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');
 await h.r.onHello(h.sockets[1],{name:'Shawn',dev:'b'});deliver(f,h.sockets[1].messages.at(-1));
 for(const m of f.sent.filter(m=>m.type==='__a')){await push(h,m);deliver(f,h.sockets[1].messages.at(-1))}
 return f;
}
for(const kind of ['word','timeout'])for(const rematch of [false,true])test(`REGRESSION: partial aggregate quota retains accepted ${kind} statistics, rematch=${rematch}`,async()=>{
 const {st,c}=closing(kind),limit=kind==='word'?5534:4306;quota(c,limit);finish(c,kind);
 assert.ok(c.saved.has('spellcoco.pending.ROOM1'));assert.ok(c.saved.has('spellcoco.endings.ROOM1'));
 const h=room(st);for(const m of c.sent.filter(m=>m.type==='__a'))await push(h,m);for(const m of h.sockets[1].messages)deliver(c,m);
 if(rematch){c.run('Math.random=()=>0;startRematch()');for(const m of c.sent.filter(m=>m.op==='newgame'))await push(h,m)}
 const f=await refresh(c,h,limit);assert.equal(f.run('STATS.games'),1);
 assert.equal(JSON.parse(f.saved.get('spellcoco.stats')).games,1);
 const again=await refresh(f,h,limit);assert.equal(again.run('STATS.games'),1);
});

function shellWorker(){
 const listeners={},timers=new Map(),stored=new Map(),waits=[];let next=0,controller;
 const url='https://x.test/SpellCoco/index.html';stored.set(url,new Response('CACHED GOOD SHELL'));
 const response=new Response(new ReadableStream({start(c){controller=c;c.enqueue(new TextEncoder().encode('<html>'))}}),{headers:{'content-type':'text/html'}});
 Object.defineProperty(response,'type',{value:'basic'});
 const key=k=>typeof k==='string'?k:k.url;
 const cache={match:async k=>stored.get(key(k))?.clone(),put:async(k,r)=>{const body=await r.arrayBuffer();stored.set(key(k),new Response(body,{headers:r.headers}))},keys:async()=>[],delete:async()=>true};
 vm.runInNewContext(fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8'),{
 self:{location:{origin:'https://x.test',href:'https://x.test/SpellCoco/sw.js'},addEventListener:(k,f)=>listeners[k]=f},
 caches:{open:async()=>cache,match:cache.match},URL,Response,fetch:async()=>response,
 setTimeout:(f,ms)=>{timers.set(++next,{f,ms});return next},clearTimeout:id=>timers.delete(id)});
 let reply;listeners.fetch({request:{url,method:'GET',mode:'navigate',headers:{has:()=>false}},respondWith:p=>reply=p,waitUntil:p=>waits.push(p)});
 return {reply,timers,controller,stored,url,waits};
}
for(const failure of ['stall','error'])test(`REGRESSION: shell body ${failure} falls back to complete cached HTML`,async()=>{
 const w=shellWorker();await flush();
 if(failure==='stall')for(const t of w.timers.values())t.f();else w.controller.error(Error('body connection lost'));
 // Bound the test wait so the old hanging body fails, rather than hanging the suite.
 let watchdog;
 const result=await Promise.race([w.reply.then(r=>r.text()).catch(()=> 'BODY ERROR'),new Promise(resolve=>{watchdog=setTimeout(()=>resolve('BODY STILL PENDING'),1000)})]);
 clearTimeout(watchdog);
 assert.equal(result,'CACHED GOOD SHELL');assert.equal(await w.stored.get(w.url).clone().text(),'CACHED GOOD SHELL');
 assert.equal(w.timers.size,0);
 if(failure==='stall')w.controller.error(Error('late body failure'));
 await Promise.allSettled(w.waits);
});
test('complete streamed shell preserves response metadata and refreshes cache',async()=>{
 const w=shellWorker();await flush();w.controller.enqueue(new TextEncoder().encode('COMPLETE</html>'));w.controller.close();
 const r=await w.reply;assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'text/html');
 assert.equal(await r.text(),'<html>COMPLETE</html>');await Promise.all(w.waits);
 assert.equal(await w.stored.get(w.url).text(),'<html>COMPLETE</html>');assert.equal(w.timers.size,0);
});

for(const rematch of [false,true])test(`statistics-only write failure stays retryable without recounting, rematch=${rematch}`,async()=>{
 const {st,c}=closing('word');finish(c,'word');
 c.run('console={...console,warn:()=>{}};const store=localStorage.setItem;localStorage.setItem=(k,v)=>{if(k==="spellcoco.stats")throw Error("quota");store(k,v)}');
 const h=room(st);for(const m of c.sent.filter(m=>m.type==='__a'))await push(h,m);
 for(let i=0;i<3;i++)for(const m of h.sockets[1].messages)deliver(c,m);
 assert.equal(c.run('STATS.games'),1);assert.ok(c.saved.has('spellcoco.endings.ROOM1'));
 assert.equal(c.saved.has('spellcoco.gover.ROOM1.match00002'),false);
 if(rematch){c.run('Math.random=()=>0;startRematch()');for(const m of c.sent.filter(m=>m.op==='newgame'))await push(h,m)}
 const f=await refresh(c,h);assert.equal(f.run('STATS.games'),1);assert.equal(f.run('NET.endingMoves.size'),0);
 assert.equal((await refresh(f,h)).run('STATS.games'),1);
});
test('atomic receipt deduplicates across tabs when compatibility marker writes fail',async()=>{
 const {st,c}=closing('word');finish(c,'word');
 c.run('console={...console,warn:()=>{}};const store=localStorage.setItem;localStorage.setItem=(k,v)=>{if(k.startsWith("spellcoco.gover."))throw Error("quota");store(k,v)}');
 const h=room(st);for(const m of c.sent.filter(m=>m.type==='__a'))await push(h,m);for(const m of h.sockets[1].messages)deliver(c,m);
 assert.equal(c.saved.has('spellcoco.gover.ROOM1'),false);assert.equal(JSON.parse(c.saved.get('spellcoco.stats')).games,1);
 const f=await refresh(c,h);assert.equal(f.run('STATS.games'),1);
 const tab=client();tab.run(online);for(const [k,v]of c.saved)tab.saved.set(k,v);
 tab.ctx.finished=h.db.get('game');tab.run('asyncShowEnding(finished);asyncShowEnding(finished)');
 assert.equal(tab.run('STATS.games'),1);assert.equal(JSON.parse(tab.saved.get('spellcoco.stats')).games,1);
});
test('id-less cached endings can count again after a live rematch',()=>{
 const c=client(),st=state();c.load(st,online);
 c.run('recordStatsOnce(game.players,null);recordStatsOnce(game.players,null)');assert.equal(c.run('STATS.games'),1);
 c.ctx.next=st;c.run('asyncLoadGame(next);recordStatsOnce(game.players,null);recordStatsOnce(game.players,null)');
 assert.equal(c.run('STATS.games'),2);
 c.run('NET.sendStart();recordStatsOnce(game.players,null)');assert.equal(c.run('STATS.games'),3);
});
test('Solo and unrecorded guest endings retain their existing statistics rules',()=>{
 const c=client();c.run('recordStatsOnce([{name:"Shawn",score:20},{name:"Coco",score:10,isCoco:true}],"solo000001")');
 assert.equal(c.run('STATS.coco.games'),1);assert.equal(c.run('STATS.games'),0);assert.equal(c.run('STATS.recordedGames'),undefined);
 c.run('recordStatsOnce([{name:"Guest",score:20},{name:"Shawn",score:10}],"guest00001")');assert.equal(c.run('STATS.games'),0);
});
test('late complete shell refreshes cache after timeout fallback',async()=>{
 const w=shellWorker();await flush();for(const t of w.timers.values())t.f();
 assert.equal(await (await w.reply).text(),'CACHED GOOD SHELL');
 w.controller.enqueue(new TextEncoder().encode('LATE</html>'));w.controller.close();for(const p of w.waits)await p;
 assert.equal(await w.stored.get(w.url).text(),'<html>LATE</html>');
});
test('the sole durable pending ending survives when both ledger and statistics writes fail',async()=>{
 const {st,c}=closing('word');
 c.run('console={...console,warn:()=>{}};const store=localStorage.setItem;localStorage.setItem=(k,v)=>{if(k==="spellcoco.stats"||k.startsWith("spellcoco.endings."))throw Error("quota");store(k,v)}');
 finish(c,'word');assert.ok(c.saved.has('spellcoco.pending.ROOM1'));assert.equal(c.saved.has('spellcoco.endings.ROOM1'),false);
 const h=room(st);for(const m of c.sent.filter(m=>m.type==='__a'))await push(h,m);
 for(const m of h.sockets[1].messages)deliver(c,m);
 assert.ok(c.saved.has('spellcoco.pending.ROOM1'));assert.equal(c.run('STATS.games'),1);
 const f=await refresh(c,h);assert.equal(f.run('STATS.games'),1);assert.equal(f.saved.has('spellcoco.pending.ROOM1'),false);
});
test('a failed previous result save leaves the paid live rematch and its pending operation intact',async()=>{
 const {st,c}=closing('word');finish(c,'word');c.run('Math.random=()=>0.9;startRematch();game.swapTargetId=0;game.performSwap("A")');
 const expected=plain(c.run('game.serialize()')),pending=c.run('NET.pendingMove.q');
 c.run('console={...console,warn:()=>{}};const store=localStorage.setItem;localStorage.setItem=(k,v)=>{if(k==="spellcoco.stats")throw Error("quota");store(k,v)}');
 const h=room(st);for(const m of c.sent.filter(m=>m.type==='__a'))await push(h,m);
 const ending=c.sent.find(m=>m.op==='move'&&m.state.over);
 const ack=h.sockets[1].messages.find(m=>m.op==='moveok'&&m.q===ending.q);deliver(c,ack);deliver(c,ack);
 assert.equal(c.run('NET.pendingMove.q'),pending);assert.deepEqual(plain(c.run('game.serialize()')),expected);
 for(const m of h.sockets[1].messages)deliver(c,m);
 const f=await refresh(c,h);assert.equal(f.run('STATS.games'),1);assert.equal(f.run('game.over'),false);
 f.ctx.expectedPlayers=expected.players;assert.deepEqual(plain(f.run('cleanPlayers(game.serialize().players)')),plain(f.run('cleanPlayers(expectedPlayers)')));
 assert.deepEqual(plain(f.run('game.serialize()')).tiles,expected.tiles);
});
test('statistics failure still reconciles the accepted final result and room revision',async()=>{
 const {st,c}=closing('timeout');finish(c,'word');
 const rival=client();rival.load(st,online+'CONFIG.rounds=1;');finish(rival,'timeout');
 c.run('console={...console,warn:()=>{}};const store=localStorage.setItem;localStorage.setItem=(k,v)=>{if(k==="spellcoco.stats")throw Error("quota");store(k,v)}');
 const h=room(st);await push(h,rival.sent.find(m=>m.op==='move'&&m.state.over));
 await push(h,c.sent.find(m=>m.op==='move'&&m.state.over));const reply=h.sockets[1].messages.at(-1);
 assert.equal(reply.reason,'game-over');deliver(c,reply);
 assert.equal(c.run('NET.rev'),reply.rev);assert.equal(c.run('STATS.games'),1);assert.equal(c.run('STATS.draws'),1);
 assert.match(c.doc.getElementById('winner-banner').innerText,/draw/);assert.ok(c.saved.has('spellcoco.endings.ROOM1'));
 const f=await refresh(c,h);assert.equal(f.run('STATS.games'),1);assert.equal(f.run('STATS.draws'),1);
});
