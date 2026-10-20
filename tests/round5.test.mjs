import test from 'node:test';
import assert from 'node:assert/strict';
import {client,state,room,socket,plain} from './helpers.mjs';
const online='NET.async=true;NET.mode="host";UI_MODE="host";NET.code="ROOM1";NET.myName="Shawn";NET.seat=1;NET.myIndex=1;NET.rev=0;NET.gameCode="ROOM1";NET.caps={livesel:true};';
const initial=()=>{const st={...state(),id:'match00002',turnIndex:1};[...'CATS'].forEach((ch,i)=>st.tiles[i].char=ch);return st};
const deliver=(c,m)=>{c.ctx.reply=plain(m);c.run('asyncOnMessage(reply)')};
const push=(h,m)=>h.r.onMessage(h.sockets[1],JSON.stringify(m));
const submit=(c,n=3)=>c.run(Array.from({length:n},(_,i)=>`game.handleTileClick(${i});`).join('')+'game.submitWord()');
for(const restart of [false,true])test(`v89 recap cannot bypass its rejected closing move, reconnect=${restart}`,async()=>{
 const st=initial(),c=client();c.load(st,online+'CONFIG.rounds=1;buildTrie(["CAT"]);');submit(c);
 const closing=c.sent.find(m=>m.op==='move'&&m.state.over);
 // Actual v89 wire shape: the closing move has base/stream, its recap only gid/q.
 const recap=c.sent.find(m=>m.op==='gameover');delete recap.base;delete recap.stream;delete recap.closing;
 const h=room(st);await h.r.onMessage(h.sockets[0],JSON.stringify({type:'__a',op:'coco'}));
 const authoritative=structuredClone(h.db.get('game'));await push(h,closing);
 assert.equal(h.sockets[1].messages.at(-1).reason,'stale');
 if(restart){h.r=new h.r.constructor(h.r.state,{});h.sockets[1]=socket(1,'Shawn')}
 await push(h,recap);assert.deepEqual(h.db.get('game'),authoritative);
});
for(const ending of ['word','timeout'])for(const ackStart of [false,true])test(`REGRESSION: accepted ${ending} remains counted after rematch refresh, rematchAck=${ackStart}`,async()=>{
 const st=initial();if(ending==='timeout'){st.cocoTimerActive=true;st.timeLeft=1}
 const c=client();c.load(st,online+'CONFIG.rounds=1;buildTrie(["CAT"]);');
 if(ending==='word')submit(c);else{c.fire(c.run('game.timerInterval'));c.fireDelay(800)}
 const closing=c.sent.filter(m=>m.op==='move'&&m.state.over).at(-1);
 c.run('Math.random=()=>0;startRematch()');const start=c.sent.filter(m=>m.op==='newgame').at(-1);
 const h=room(st);for(const m of c.sent.filter(m=>m.type==='__a'))await push(h,m);
 assert.equal(h.db.get('game').id,start.state.id);assert.equal(h.db.get('game').over,false);
 assert.ok(h.sockets[1].messages.some(m=>m.op==='moveok'&&m.q===closing.q),'final was accepted');
 if(ackStart)deliver(c,h.sockets[1].messages.find(m=>m.op==='moveok'&&m.q===start.q));
 const f=client();for(const [k,v]of c.saved)f.saved.set(k,v);f.run(online+'NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))};STATS=lsGet("spellcoco.stats",STATS)');
 await h.r.onHello(h.sockets[1],{name:'Shawn',dev:'b'});deliver(f,h.sockets[1].messages.at(-1));
 for(const m of f.sent.filter(m=>m.type==='__a')){await push(h,m);deliver(f,h.sockets[1].messages.at(-1))}
 assert.equal(f.run('STATS.games'),1,'accepted previous match must not disappear');
 assert.equal(f.run('NET.endingMoves.size'),0);assert.equal(f.run('game.id'),start.state.id);assert.equal(f.run('game.over'),false);
 assert.equal(f.saved.has('spellcoco.endings.ROOM1'),false);
 // Another refresh and duplicate replies must not count it twice.
 const again=client();for(const [k,v]of f.saved)again.saved.set(k,v);again.run(online+'STATS=lsGet("spellcoco.stats",STATS)');
 await h.r.onHello(h.sockets[1],{name:'Shawn',dev:'b'});deliver(again,h.sockets[1].messages.at(-1));
 for(const reply of h.sockets[1].messages)if(reply.op==='reject'||reply.op==='moveok')deliver(f,reply);
 assert.equal(f.run('STATS.games'),1);assert.equal(again.run('STATS.games'),1);
});
for(const reconnect of [false,true])test(`REGRESSION: distinct accepted score survives dismissal of a rejected play, welcome=${reconnect}`,async()=>{
 const st=initial(),c=client(),observer=client();c.load(st,online+'CONFIG.rounds=5;buildTrie(["CAT","CATS"]);');observer.load(st,online+'NET.seat=NET.myIndex=0;NET.myName="Keith";');
 observer.run('clock=10000;Date.now=()=>clock;FX.overlayUntil=FX.loungeUntil=0;document.getElementById("coco-lounge").offsetParent={};document.getElementById("grid").childElementCount=25;');
 submit(c);const score=c.sent.find(m=>m.type==='fx'&&m.toast?.startsWith('CAT '));observer.ctx.fx=score;observer.run('asyncFx(fx);_cocoPump();dismissCocoBubble()');
 const h=room(st);await h.r.onMessage(h.sockets[0],JSON.stringify({type:'__a',op:'coco'}));
 for(const m of c.sent.filter(m=>m.type==='__a'))await push(h,m);for(const reply of h.sockets[1].messages)deliver(c,reply);
 if(reconnect){await h.r.onHello(h.sockets[0],{name:'Keith',dev:'a'});deliver(observer,h.sockets[0].messages.at(-1))}
 const offset=c.sent.length;submit(c,4);for(const m of c.sent.slice(offset).filter(m=>m.type==='__a'))await push(h,m);
 assert.equal(h.db.get('game').players[1].wordsPlayed.at(-1).word,'CATS');
 observer.ctx.fx=c.sent.slice(offset).find(m=>m.type==='fx'&&m.toast?.startsWith('CATS '));observer.run('clock+=5000;FX.overlayUntil=FX.loungeUntil=0;asyncFx(fx);_cocoPump()');
 assert.equal(observer.run('COCO_SAY.showing'),true,'a different accepted play should be visible');
});
for(const act of ['swap','word'])test(`REGRESSION: transient failed start does not finalize a new match after ${act}`,async()=>{
 const c=client(),st=initial(),h=room({...state(),id:'oldmatch01',over:true});
 c.load(st,online+'CONFIG.rounds=5;buildTrie(["CAT"]);');c.run('NET.sendStart()');
 if(act==='swap')c.run('game.swapTargetId=0;game.performSwap("A")');else submit(c);
 const put=h.r.state.storage.put;let once=true;h.r.state.storage.put=async(k,v)=>{if(k==='game'&&once){once=false;throw Error('temporary storage failure')}return put(k,v)};
 for(const m of c.sent.filter(m=>m.type==='__a'))await h.r.webSocketMessage(h.sockets[1],JSON.stringify(m));
 for(const m of h.sockets[1].messages)deliver(c,m);
 await h.r.onHello(h.sockets[1],{name:'Shawn',dev:'b'});const offset=c.sent.length;deliver(c,h.sockets[1].messages.at(-1));
 for(const m of c.sent.slice(offset).filter(m=>m.type==='__a'))await push(h,m);
 assert.equal(h.db.get('game').id,st.id);assert.equal(h.db.get('game').over,false,'unfinished new game must stay live');
});
test('a cached recap cannot replace a rejected malformed closing snapshot',async()=>{
 const c=client(),st=initial();c.load(st,online);c.run('game.endGame()');
 const closing=c.sent.find(m=>m.op==='move');closing.state.sel=[99];
 const recap=c.sent.find(m=>m.op==='gameover');delete recap.base;delete recap.stream;delete recap.closing;
 const h=room(st);await push(h,closing);assert.equal(h.sockets[1].messages.at(-1).reason,'bad-state');
 await push(h,recap);assert.equal(h.db.get('game').over,false);
});
test('an archived ending retry retires a stale pending record without touching the live rematch',async()=>{
 const c=client(),st=initial();c.load(st,online);c.run('game.endGame()');
 const pending=c.saved.get('spellcoco.pending.ROOM1');c.run('Math.random=()=>0;startRematch()');
 const h=room(st);for(const m of c.sent.filter(m=>m.type==='__a'))await push(h,m);
 const f=client();for(const [k,v]of c.saved)f.saved.set(k,v);f.saved.set('spellcoco.pending.ROOM1',pending);
 f.run(online+'NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');
 await h.r.onHello(h.sockets[1],{name:'Shawn',dev:'b'});deliver(f,h.sockets[1].messages.at(-1));
 const live=plain(f.run('game.serialize()'));
 for(const m of f.sent.filter(m=>m.type==='__a')){await push(h,m);deliver(f,h.sockets[1].messages.at(-1))}
 assert.equal(f.run('STATS.games'),1);assert.deepEqual(plain(f.run('game.serialize()')),live);assert.equal(f.run('NET.pendingMove'),null);
});
test('unacknowledged archived endings are retried by the heartbeat after a receipt read error',async()=>{
 const c=client(),st=initial();c.load(st,online);c.run('game.endGame();Math.random=()=>0;startRematch()');
 const h=room(st);for(const m of c.sent.filter(m=>m.type==='__a'))await push(h,m);
 const f=client();for(const [k,v]of c.saved)f.saved.set(k,v);f.run(online+'NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');
 await h.r.onHello(h.sockets[1],{name:'Shawn',dev:'b'});deliver(f,h.sockets[1].messages.at(-1));
 // The first recovery request gets the worker's transient-error envelope.
 deliver(f,{op:'reject',reason:'error',state:null});const offset=f.sent.length;f.run('NET.resendPending()');
 const retry=f.sent.slice(offset).find(m=>m.op==='move'&&m.state.id===st.id);assert.ok(retry);
 await push(h,retry);deliver(f,h.sockets[1].messages.at(-1));assert.equal(f.run('STATS.games'),1);
});
for(const action of ['swap','shuffle','word'])for(const refresh of [false,true])test(`failed start retains ${action} through ${refresh?'refresh':'reordered replies'}`,async()=>{
 const c=client(),st=initial(),h=room({...state(),id:'oldmatch01',over:true});
 c.load(st,online+'CONFIG.rounds=5;buildTrie(["CAT"]);');c.run('NET.sendStart()');
 if(action==='swap')c.run('game.swapTargetId=0;game.performSwap("A")');else if(action==='shuffle')c.run('confirmShuffle()');else submit(c);
 const expected=plain(c.run('game.serialize()')),ops=c.sent.filter(m=>m.type==='__a');
 await push(h,ops.find(m=>m.op==='move')); // the start has not reached storage
 assert.equal(h.sockets[1].messages.at(-1).reason,'wrong-match');
 for(const reply of [...h.sockets[1].messages].reverse())deliver(c,reply);
 assert.equal(c.run('game.over'),false);assert.deepEqual(plain(c.run('game.serialize()')),expected);
 const f=refresh?client():c;if(refresh)for(const [k,v]of c.saved)f.saved.set(k,v);
 f.run(online+'NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');const offset=f.sent.length;
 await h.r.onHello(h.sockets[1],{name:'Shawn',dev:'b'});deliver(f,h.sockets[1].messages.at(-1));
 for(const m of f.sent.slice(offset).filter(m=>m.op==='newgame')){await push(h,m);deliver(f,h.sockets[1].messages.at(-1))}
 f.run('NET.resendPending()');for(const m of f.sent.filter(m=>m.op==='move')){await push(h,m);deliver(f,h.sockets[1].messages.at(-1))}
 f.ctx.expectedPlayers=expected.players;f.ctx.storedPlayers=h.db.get('game').players;
 assert.equal(h.db.get('game').over,false);assert.deepEqual(plain(f.run('cleanPlayers(storedPlayers)')),plain(f.run('cleanPlayers(expectedPlayers)')));assert.deepEqual(h.db.get('game').tiles,expected.tiles);
 assert.equal(f.run('game.over'),false);assert.equal(f.run('NET.pendingMove'),null);
});
test('closing history blocks another same-seat socket but leaves the next match legacy fallback usable',async()=>{
 const st=initial(),c=client();c.load(st,online);c.run('game.endGame()');const h=room(st);
 await h.r.onMessage(h.sockets[0],JSON.stringify({type:'__a',op:'coco'}));await push(h,c.sent.find(m=>m.op==='move'));
 const recap={type:'__a',op:'gameover',gid:st.id,players:st.players};
 const tab=socket(1,'Shawn');await h.r.onMessage(tab,JSON.stringify(recap));assert.equal(tab.messages.at(-1).reason,'ending-pending');assert.equal(h.db.get('game').over,false);
 // A correctly based full closing move still finishes normally.
 const closing=structuredClone(c.sent.find(m=>m.op==='move'));closing.base=1;closing.q++;
 await push(h,closing);assert.equal(h.db.get('game').over,true);
 const next={...state(),id:'nextmatch1',turnIndex:1};await push(h,{type:'__a',op:'newgame',state:next,q:closing.q+1,base:2,stream:closing.stream});
 await push(h,{...recap,gid:next.id});assert.equal(h.db.get('game').over,true,'truly recap-only clients keep their compatibility path in another match');
});
for(const storage of ['quota','unavailable'])test(`same-page ending/rematch acceptance survives client storage ${storage}`,async()=>{
 const c=client(),st=initial();c.load(st,online);c.run('console={...console,warn:()=>{}};localStorage.setItem=()=>{throw Error("quota")}');
 if(storage==='unavailable')c.run('localStorage.getItem=localStorage.removeItem=()=>{throw Error("storage")}');
 c.run('game.endGame();Math.random=()=>0;startRematch()');const id=c.run('game.id'),h=room(st);
 for(const m of c.sent.filter(m=>m.type==='__a'))await push(h,m);
 for(const reply of [...h.sockets[1].messages].reverse())deliver(c,reply);
 assert.equal(c.run('STATS.games'),1);assert.equal(c.run('game.id'),id);assert.equal(c.run('game.over'),false);assert.equal(c.run('NET.endingMoves.size'),0);
});
test('failure to archive a result cannot replace the room; retry preserves paid rematch state',async()=>{
 const c=client(),st=initial();c.load(st,online);c.run('game.endGame();Math.random=()=>0.9;startRematch();game.swapTargetId=0;game.performSwap("A")');
 const expected=plain(c.run('game.serialize()')),h=room(st),put=h.r.state.storage.put;let once=true;
 h.r.state.storage.put=async(k,v)=>{if(k.startsWith('finished.')&&once){once=false;throw Error('archive failed')}return put(k,v)};
 for(const m of c.sent.filter(m=>m.type==='__a'))await h.r.webSocketMessage(h.sockets[1],JSON.stringify(m));
 assert.equal(h.db.get('game').id,st.id);assert.equal(h.db.get('game').over,true);
 for(const reply of h.sockets[1].messages)deliver(c,reply);assert.equal(c.run('game.over'),false);
 const offset=c.sent.length;await h.r.onHello(h.sockets[1],{name:'Shawn',dev:'b'});deliver(c,h.sockets[1].messages.at(-1));
 for(const m of c.sent.slice(offset).filter(m=>m.type==='__a')){await push(h,m);deliver(c,h.sockets[1].messages.at(-1))}
 assert.equal(h.db.get('game').over,false);assert.deepEqual(h.db.get('game').players,expected.players);assert.deepEqual(h.db.get('game').tiles,expected.tiles);
});
test('each resubmission and each tab gets a new score tag while retries and continuations keep the original',()=>{
 const st=initial(),a=client(),b=client();for(const c of [a,b])c.load(st,online+'CONFIG.rounds=5;buildTrie(["CAT"]);');
 // Force identical gameplay RNG: the event identity must come from crypto.
 a.run('Math.random=()=>0.2');b.run('Math.random=()=>0.2');submit(a);submit(b);
 const first=a.sent.find(m=>m.type==='fx'&&m.toast?.startsWith('CAT ')),other=b.sent.find(m=>m.type==='fx'&&m.toast?.startsWith('CAT '));
 assert.notEqual(first.event,other.event);assert.equal(a.run('cleanScoreEvent('+JSON.stringify(first.event)+')'),first.event);
 a.load(st);const offset=a.sent.length;submit(a);const next=a.sent.slice(offset).filter(m=>m.type==='fx'&&m.event);
 assert.notEqual(first.event,next[0].event);assert.equal(new Set(next.map(m=>m.event)).size,1);
 const observer=client();observer.load(st);observer.ctx.fx=first;
 observer.run('FX.overlayUntil=FX.loungeUntil=0;document.getElementById("coco-lounge").offsetParent={};document.getElementById("grid").childElementCount=25;asyncFx(fx);_cocoPump();dismissCocoBubble();asyncFx(fx);_cocoPump()');
 assert.equal(observer.run('COCO_SAY.showing'),false);
});
test('a restored cached-client ending stays durable if a rematch starts before its retry reply',async()=>{
 const original=client(),st=initial();original.load(st,online);original.run('game.endGame()');
 const pending=original.saved.get('spellcoco.pending.ROOM1'),c=client();c.saved.set('spellcoco.pending.ROOM1',pending);
 c.run(online+'NET.restorePending();NET.noteRev(1)');c.load(JSON.parse(pending).m.state);c.run('Math.random=()=>0;startRematch()');
 const h=room(st);await push(h,JSON.parse(pending).m);for(const m of c.sent.filter(m=>m.type==='__a'))await push(h,m);
 const f=client();for(const [k,v]of c.saved)f.saved.set(k,v);f.run(online+'NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');
 await h.r.onHello(h.sockets[1],{name:'Shawn',dev:'b'});deliver(f,h.sockets[1].messages.at(-1));
 for(const m of f.sent.filter(m=>m.type==='__a')){await push(h,m);deliver(f,h.sockets[1].messages.at(-1))}
 assert.equal(f.run('STATS.games'),1);assert.equal(f.run('game.over'),false);
});
