import test from 'node:test';
import assert from 'node:assert/strict';
import {client,state,room,socket,plain} from './helpers.mjs';
const online='NET.async=true;NET.mode="host";UI_MODE="host";NET.code="ROOM1";NET.myName="Keith";NET.seat=0;NET.myIndex=0;NET.rev=0;NET.gameCode="ROOM1";';
const initial=()=>({...state(),id:'match00002'});
const push=(r,s,m)=>r.onMessage(s,JSON.stringify(m));
const deliver=(c,m)=>{c.ctx.reply=plain(m);c.run('asyncOnMessage(reply)')};
const swap=(c,ch)=>c.run(`game.swapTargetId=0;game.performSwap('${ch}')`);
const moves=c=>c.sent.filter(m=>m.op==='move');
const board=(c,ch,gems)=>{assert.equal(c.run('game.tiles[0].char'),ch);assert.equal(c.run('game.players[0].gems'),gems)};
const submit=c=>c.run('game.handleTileClick(0);game.handleTileClick(1);game.handleTileClick(2);game.submitWord()');
// Advance all callbacks in deadline order, including timers created by callbacks.
function chronological(c){
 let now=0;const due=new Map();
 for(const key of ['setTimeout','setInterval']){const original=c.ctx[key];c.ctx[key]=(f,ms)=>{const id=original(f,ms);due.set(id,now+ms);return id}}
 return until=>{for(;;){const next=[...due].filter(([id,t])=>c.timers.has(id)&&t<=until).sort((a,b)=>a[1]-b[1]||a[0]-b[0])[0];if(!next)break;
  const [id,t]=next,entry=c.timers.get(id);now=t;due.delete(id);if(entry.repeat)due.set(id,now+entry.ms);c.fire(id);
 }now=until};
}
for(const seconds of [0,1])test(`Solo resumed at ${seconds}s retires its expired pending turn and plays the next round`,()=>{
 const st=initial();st.players[0].isCoco=true;st.players[0].mood='sleepy';st.cocoTimerActive=true;st.timeLeft=seconds;
 [...'CAT'].forEach((ch,i)=>st.tiles[i].char=ch);
 const c=client(),advance=chronological(c);c.load(st,'NET.mode="local";CONFIG.solo={active:true,mood:"sleepy"};CONFIG.rounds=5;buildTrie(["CAT"]);');
 advance(2100);assert.equal(c.run('game.turnIndex'),1);assert.equal(c.run('game.cocoPending'),false);
 submit(c);assert.equal(c.run('game.turnIndex'),0);assert.equal(c.run('game.round'),2);
 assert.equal(c.run('game.cocoPending'),true);assert.ok(c.run('game._aiTimers.size')>0);
 advance(100000);assert.equal(c.run('game.turnIndex'),1,'Coco must finish his next turn');
});
for(const ending of ['word','timeout'])test(`a rejected closing ${ending} cannot finish via the redundant ending envelope`,async()=>{
 const st={...initial(),turnIndex:1};[...'CAT'].forEach((ch,i)=>st.tiles[i].char=ch);
 if(ending==='timeout'){st.cocoTimerActive=true;st.timeLeft=1}
 const c=client();c.load(st,online+'NET.seat=NET.myIndex=1;NET.myName="Shawn";CONFIG.rounds=1;buildTrie(["CAT"]);');
 if(ending==='word')submit(c);else {c.fire(c.run('game.timerInterval'));c.fireDelay(800)}
 const h=room(st),[a,b]=h.sockets;
 if(ending==='word')await push(h.r,a,{type:'__a',op:'coco'});
 else{const other=client();other.load(st,online+'NET.seat=NET.myIndex=1;');swap(other,'A');await push(h.r,socket(1,'Shawn'),moves(other).at(-1))}
 const authoritative=structuredClone(h.db.get('game'));
 const emitted=c.sent.filter(m=>m.type==='__a');for(const m of emitted)await push(h.r,b,m);
 assert.equal(b.messages.find(m=>m.op==='reject').reason,'stale');assert.ok(['stale','ending-pending'].includes(b.messages.at(-1).reason));
 assert.deepEqual(h.db.get('game'),authoritative);assert.equal(h.db.get('game').players[ending==='word'?0:1].gems,ending==='word'?4:5);
 for(const reply of b.messages)deliver(c,reply);
 assert.equal(c.run('game.over'),false,'rejected ending must return to the authoritative live turn');
 assert.equal(c.run('game.players[0].gems'),authoritative.players[0].gems);assert.equal(c.run('NET.pendingMove'),null);assert.equal(c.run('STATS.games'),0);
});
for(const failure of ['start-only','quota'])for(const followup of [false,true])test(`partial ${failure} write restores the paid Swap, next Swap=${followup}`,async()=>{
 const original=client();original.load(initial(),online);original.run('NET.sendStart()');
 original.ctx.durable=original.saved;
 original.run(`console={...console,warn:()=>{}};localStorage.setItem=(k,v)=>{
  if(${failure==='quota'?'[...durable].reduce((n,[key,value])=>n+key.length+value.length,0)-(durable.has(k)?k.length+durable.get(k).length:0)+k.length+v.length>quota':'k.includes(".start.")'})throw Error("quota");durable.set(k,v)
 }`);
 if(failure==='quota'){
  // Leave enough room for the pending write, but not the subsequent larger start.
  const trial=client();trial.load(initial(),online);trial.run('NET.sendStart()');swap(trial,'A');
  const pending=trial.saved.get('spellcoco.pending.ROOM1');
  original.ctx.quota=[...original.saved].reduce((n,[k,v])=>n+k.length+v.length,0)+'spellcoco.pending.ROOM1'.length+pending.length+1;
 }
 swap(original,'A');assert.ok(original.saved.has('spellcoco.pending.ROOM1'));assert.equal(JSON.parse(original.saved.get('spellcoco.start.ROOM1')).m.state.tiles[0].char,'E');
 const c=client();for(const [k,v]of original.saved)c.saved.set(k,v);c.run(online+'NET.rev=null;NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');
 const h=room({...initial(),id:'oldmatch01',over:true});await h.r.onHello(h.sockets[0],{name:'Keith',dev:'a'});deliver(c,h.sockets[0].messages.at(-1));
 board(c,'A',5);if(followup)swap(c,'B');
 for(const m of c.sent.filter(m=>m.type==='__a'&&['newgame','move'].includes(m.op))){await push(h.r,h.sockets[0],m);deliver(c,h.sockets[0].messages.at(-1))}
 // Start acknowledgement releases the successor on the next retry.
 c.run('NET.resendPending()');for(const m of moves(c).slice(followup?1:0)){await push(h.r,h.sockets[0],m);deliver(c,h.sockets[0].messages.at(-1))}
 board(c,followup?'B':'A',followup?2:5);assert.equal(h.db.get('game').players[0].gems,followup?2:5);assert.equal(c.run('NET.pendingMove'),null);
});
test('same-match welcome preserves dismissal of actual delayed score continuations',async()=>{
 const st=initial();[...'CATS'].forEach((ch,i)=>st.tiles[i].char=ch);
 const sender=client();sender.load(st,online+'CONFIG.rounds=5;buildTrie(["CAT","CATS"]);');submit(sender);
 const fx=sender.sent.filter(m=>m.type==='fx'&&m.toast);assert.match(fx[1].toast,/Best possible/);
 const c=client();c.load(st,online+'NET.myIndex=NET.seat=1;NET.myName="Shawn";');
 c.run('clock=10000;Date.now=()=>clock;FX.overlayUntil=FX.loungeUntil=0;document.getElementById("coco-lounge").offsetParent={};document.getElementById("grid").childElementCount=25;');
 c.ctx.first=fx[0];c.ctx.second=fx[1];c.run('asyncFx(first);_cocoPump();dismissCocoBubble()');
 assert.equal(c.run('COCO_SAY.dismissedEvents.size'),1);
 const h=room(st);await h.r.onHello(h.sockets[1],{name:'Shawn',dev:'b'});deliver(c,h.sockets[1].messages.at(-1));
 assert.equal(c.run('COCO_SAY.dismissedEvents.size'),1);c.run('clock+=901;asyncFx(second);_cocoPump()');
 assert.equal(c.run('COCO_SAY.showing'),false);assert.equal(c.run('COCO_SAY.q.length'),0);
});

for(const seconds of [0,1])test(`an obsolete ${seconds}s Solo callback cannot clear the next turn's scheduler`,()=>{
 const st=initial();st.players[0].isCoco=true;st.cocoTimerActive=true;st.timeLeft=seconds;[...'CAT'].forEach((ch,i)=>st.tiles[i].char=ch);
 const c=client(),advance=chronological(c);c.load(st,'CONFIG.solo={active:true,mood:"sleepy"};CONFIG.rounds=5;buildTrie(["CAT"]);');
 advance(seconds*1000+800);assert.equal(c.run('game.turnIndex'),1);submit(c);
 const owner=c.run('game._cocoPendingTurn');advance(2100);
 assert.equal(c.run('game.cocoPending'),true);assert.equal(c.run('game._cocoPendingTurn'),owner);
 const size=c.run('game._aiTimers.size');c.run('game.activate();game.maybeCoco()');assert.equal(c.run('game._aiTimers.size'),size,'activation must not schedule duplicates');
 advance(100000);assert.equal(c.run('game.turnIndex'),1);
});
test('a retired Solo callback cannot play or repaint a replacement game',()=>{
 const st=initial();st.players[0].isCoco=true;const c=client(),advance=chronological(c);c.load(st,'CONFIG.solo={active:true,mood:"cozy"}');
 const ids=[...c.run('game._aiTimers')];c.load({...initial(),id:'othermatch'});const before=plain(c.run('game.serialize()'));
 assert.ok(ids.every(id=>!c.timers.has(id)));advance(10000);assert.deepEqual(plain(c.run('game.serialize()')),before);
});
for(const streamless of [false,true])test(`a recap received before its closing move waits for acceptance, streamless=${streamless}`,async()=>{
 const st={...initial(),turnIndex:1};[...'CAT'].forEach((ch,i)=>st.tiles[i].char=ch);
 const c=client();c.load(st,online+'NET.myIndex=NET.seat=1;NET.myName="Shawn";CONFIG.rounds=1;NET.moveStream='+(streamless?'false':'null')+';buildTrie(["CAT"]);');submit(c);
 const ending=c.sent.find(m=>m.op==='gameover'),closing=moves(c).find(m=>m.state.over);
 assert.equal(ending.base,closing.base);assert.equal(ending.stream,closing.stream);assert.equal(ending.q,closing.q);
 const h=room(st),b=h.sockets[1],notes=[];h.r.notifySeat=async(...args)=>notes.push(args);
 await push(h.r,b,ending);assert.equal(b.messages.at(-1).reason,'ending-pending');deliver(c,b.messages.at(-1));
 assert.ok(c.run('NET.pendingMove'));assert.equal(h.db.get('game').over,false);
 await push(h.r,b,closing);deliver(c,b.messages.at(-1));assert.equal(h.db.get('game').over,true);assert.equal(c.run('NET.pendingMove'),null);
 const restarted=new h.r.constructor(h.r.state,{});restarted.notifySeat=h.r.notifySeat;
 for(const m of [ending,closing])await push(restarted,b,m);
 assert.equal(notes.length,1);assert.deepEqual(h.db.get('game').players,plain(closing.state.players));assert.equal(c.run('STATS.games'),1);
});
for(const first of ['move','recap'])test(`same-seat supersession rejects an obsolete closing operation, first=${first}`,async()=>{
 const c=client();c.load(initial(),online);c.run('game.endGame()');
 const closing=moves(c).find(m=>m.state.over),recap=c.sent.find(m=>m.op==='gameover');
 const other=client();other.load(initial(),online);swap(other,'A');
 const h=room(initial()),tab=socket(0,'Keith');await push(h.r,tab,moves(other).at(-1));
 for(const m of first==='move'?[closing,recap]:[recap,closing])await push(h.r,h.sockets[0],m);
 for(const reply of h.sockets[0].messages)deliver(c,reply);
 assert.equal(h.db.get('game').over,false);assert.equal(h.db.get('game').tiles[0].char,'A');board(c,'A',5);assert.equal(c.run('game.over'),false);
});
for(const failure of ['move-all','move-latest'])test(`a newer saved start survives failed ${failure} persistence`,async()=>{
 const original=client();original.load(initial(),online);original.run('NET.sendStart()');
 if(failure==='move-latest')swap(original,'A');
 original.ctx.durable=original.saved;original.run('console={...console,warn:()=>{}};localStorage.setItem=(k,v)=>{if(k.includes(".pending."))throw Error("quota");durable.set(k,v)}');
 swap(original,failure==='move-all'?'A':'B');const expected=failure==='move-all'?5:2;
 const c=client();for(const [k,v]of original.saved)c.saved.set(k,v);c.run(online+'NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');
 const h=room({...initial(),id:'oldmatch01',over:true});await h.r.onHello(h.sockets[0],{name:'Keith',dev:'a'});deliver(c,h.sockets[0].messages.at(-1));
 board(c,failure==='move-all'?'A':'B',expected);
 for(const m of c.sent.filter(m=>m.op==='newgame')){await push(h.r,h.sockets[0],m);deliver(c,h.sockets[0].messages.at(-1))}
 c.run('NET.resendPending()');await push(h.r,h.sockets[0],moves(c).at(-1));deliver(c,h.sockets[0].messages.at(-1));
 assert.equal(h.db.get('game').players[0].gems,expected);assert.equal(c.run('NET.pendingMove'),null);
});
for(const legacy of [false,true])test(`reconciliation of divergent start records retains countdown, ordering and paid successors, legacy=${legacy}`,async()=>{
 const original=client(),st=initial();st.cocoTimerActive=true;st.timeLeft=17;original.load(st,online+'NET.rev=6;');original.run('NET.sendStart()');
 const old=original.saved.get('spellcoco.start.ROOM1');swap(original,'A');original.saved.set('spellcoco.start.ROOM1',old);
 const c=client();for(const [k,v]of original.saved){const p=JSON.parse(v);if(legacy&&p.m){delete p.m.stream;delete p.m.base;delete p.stateQ;delete p.stateBase}c.saved.set(k,JSON.stringify(p))}
 c.run(online+'NET.rev=null;NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');const h=room({...initial(),id:'oldmatch01',over:true});h.db.set('rev',6);
 await h.r.onHello(h.sockets[0],{name:'Keith',dev:'a'});deliver(c,h.sockets[0].messages.at(-1));board(c,'A',5);assert.equal(c.run('game.timeLeft'),17);
 const start=c.sent.find(m=>m.op==='newgame');swap(c,'B');const move=moves(c).at(-1);assert.ok(move.q>start.q);assert.equal(move.stream,start.stream);
 for(const m of [start,move]){await push(h.r,h.sockets[0],m);deliver(c,h.sockets[0].messages.at(-1))}
 board(c,'B',2);assert.equal(h.db.get('game').players[0].gems,2);
});
for(const mismatch of ['match','stream'])test(`restored start does not borrow an unrelated ${mismatch} snapshot`,()=>{
 const original=client();original.load(initial(),online);original.run('NET.sendStart()');const old=original.saved.get('spellcoco.start.ROOM1');swap(original,'A');original.saved.set('spellcoco.start.ROOM1',old);
 const c=client();for(const [k,v]of original.saved){const p=JSON.parse(v);if(k.includes('.pending.')){if(mismatch==='match')p.m.state.id='othermatch';else p.m.stream='z'.repeat(24)}c.saved.set(k,JSON.stringify(p))}
 c.run(online+'NET.restoreStart()');board(c,'E',8);
});
for(const replacement of ['same','different','apply-same','apply-different','new','retire'])test(`bubble dismissal lifecycle on ${replacement} replacement`,()=>{
 const c=client();c.load(initial());c.run('FX.overlayUntil=FX.loungeUntil=0;cocoSay("Score",false,"score:match00002:1:0");_cocoPump();dismissCocoBubble();cocoSpeak("Queued")');
 c.ctx.next={...initial(),id:replacement.includes('different')?'othermatch':initial().id};
 if(replacement==='retire')c.run('retireGame()');else if(replacement==='new')c.run('game=new Game()');else if(replacement.startsWith('apply'))c.run('game.applyState(next)');else c.run('game=Game.fromState(next)');
 assert.equal(c.run('COCO_SAY.dismissedEvents.size'),['same','apply-same'].includes(replacement)?1:0);
 if(replacement!=='apply-same')assert.equal(c.run('COCO_SAY.q.length'),0);
 if(['same','apply-same'].includes(replacement)){c.run('cocoSay("Late",false,"score:match00002:1:0")');assert.equal(c.run('COCO_SAY.q.some(b=>b.lines.includes("Late"))'),false)}
});

test('replaying a rejected final word records only the accepted result, with the authoritative treat bonus',async()=>{
 const st={...initial(),turnIndex:1};st.players[0].score=10;[...'CAT'].forEach((ch,i)=>st.tiles[i].char=ch);
 const c=client();c.load(st,online+'NET.myIndex=NET.seat=1;NET.myName="Shawn";CONFIG.rounds=1;buildTrie(["CAT"]);');submit(c);
 assert.equal(c.run('STATS.games'),0);const h=room(st);await push(h.r,h.sockets[0],{type:'__a',op:'coco'});
 for(const m of c.sent.filter(m=>m.type==='__a'))await push(h.r,h.sockets[1],m);
 for(const reply of h.sockets[1].messages)deliver(c,reply);
 assert.equal(c.run('game.over'),false);assert.equal(c.run('STATS.games'),0);
 const offset=c.sent.length;submit(c);
 for(const m of c.sent.slice(offset).filter(m=>m.type==='__a'))await push(h.r,h.sockets[1],m);
 for(const reply of h.sockets[1].messages)deliver(c,reply);
 assert.equal(h.db.get('game').over,true);assert.equal(h.db.get('game').players[0].score,14);
 assert.equal(c.run('STATS.games'),1);assert.equal(c.run('STATS.wins.Shawn'),1);assert.equal(c.run('STATS.wins.Keith'),0);
});
test('closing acknowledgements in reverse match order remain counted once after another refresh',async()=>{
 const c=client();c.load(initial(),online);c.run('game.endGame();Math.random=()=>0;startRematch();game.endGame()');
 const finals=moves(c).filter(m=>m.state.over),h=room(initial());assert.equal(finals.length,2);
 for(const m of c.sent.filter(m=>m.type==='__a'))await push(h.r,h.sockets[0],m);
 for(const final of [...finals].reverse())deliver(c,h.sockets[0].messages.find(m=>m.op==='moveok'&&m.q===final.q));
 for(const reply of h.sockets[0].messages)deliver(c,reply);
 assert.equal(c.run('STATS.games'),2);
 const fresh=client();for(const [k,v]of c.saved)fresh.saved.set(k,v);
 fresh.run(online+'STATS=lsGet("spellcoco.stats",null);');
 await h.r.onHello(h.sockets[0],{name:'Keith',dev:'a'});deliver(fresh,h.sockets[0].messages.at(-1));
 assert.equal(fresh.run('STATS.games'),2);
});
test('a refreshed unaccepted final snapshot waits for its retry acknowledgement before recording',async()=>{
 const original=client();original.load(initial(),online);original.run('game.endGame()');
 const c=client();for(const [k,v]of original.saved)c.saved.set(k,v);c.run(online+'NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');
 const h=room(initial());await h.r.onHello(h.sockets[0],{name:'Keith',dev:'a'});deliver(c,h.sockets[0].messages.at(-1));
 assert.equal(c.run('STATS.games'),0);assert.equal(c.run('game.over'),true);
 await push(h.r,h.sockets[0],moves(c).at(-1));deliver(c,h.sockets[0].messages.at(-1));
 assert.equal(c.run('STATS.games'),1);assert.equal(c.run('NET.pendingMove'),null);
});
