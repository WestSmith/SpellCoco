import test from 'node:test';
import assert from 'node:assert/strict';
import {client,state,room,plain} from './helpers.mjs';

const online='NET.async=true;NET.mode="host";UI_MODE="host";NET.code="ROOM1";NET.myName="Shawn";NET.seat=1;NET.myIndex=1;NET.rev=0;NET.gameCode="ROOM1";NET.caps={livesel:true};';
const initial=()=>{const st={...state(),id:'match00002',turnIndex:1};[...'CAT'].forEach((ch,i)=>st.tiles[i].char=ch);return st};
const deliver=(c,m)=>{c.ctx.reply=plain(m);c.run('asyncOnMessage(reply)')};
const push=(h,m)=>h.r.onMessage(h.sockets[1],JSON.stringify(m));
async function welcome(c,h){await h.r.onHello(h.sockets[1],{name:'Shawn',dev:'b'});deliver(c,h.sockets[1].messages.at(-1))}
function refresh(c){
 const f=client();for(const [k,v]of c.saved)f.saved.set(k,v);
 f.run(online+'STATS=lsGet("spellcoco.stats",STATS)');return f;
}
function result(c){
 const s=plain(c.run('STATS'));assert.equal(s.games,1);assert.equal(s.draws,0);assert.equal(s.wins.Shawn,1);
 assert.deepEqual(s.bestWord,{word:'CAT',score:8,player:'Shawn'});
 assert.deepEqual(s.longestWord,{word:'CAT',player:'Shawn'});
 assert.deepEqual(s.recordedGames,['spellcoco.gover.ROOM1.match00002']);
}

for(const failedWrite of [false,true])test(`accepted cached recap supplies final scores and words, stats failure=${failedWrite}`,async()=>{
 const st=initial(),c=client();c.load(st,online+'CONFIG.rounds=1;buildTrie(["CAT"]);');
 c.run('game.handleTileClick(0);game.handleTileClick(1);game.handleTileClick(2);game.submitWord()');
 const closing=c.sent.find(m=>m.op==='move'&&m.state.over),recap=c.sent.find(m=>m.op==='gameover'),h=room(st);
 // Cached recap-only senders omit the closing operation and ordering fields.
 await push(h,{type:'__a',op:'gameover',gid:st.id,players:recap.players});
 assert.equal(h.db.get('game').finalPlayers[0].score,16);assert.equal(h.db.get('game').players[1].score,0);
 await push(h,closing);const rejection=h.sockets[1].messages.at(-1);assert.equal(rejection.reason,'game-over');
 if(failedWrite)c.run('console={...console,warn:()=>{}};originalSet=localStorage.setItem;localStorage.setItem=(k,v)=>{if(k==="spellcoco.stats")throw Error("quota");return originalSet(k,v)}');
 deliver(c,rejection);
 assert.match(c.els.get('winner-banner').innerText,/Shawn Wins with 16 pts/);
 result(c);
 if(failedWrite){assert.equal(c.run('NET.endingMoves.size'),1);c.run('localStorage.setItem=originalSet;NET.resendEndings()')}
 assert.equal(c.run('NET.endingMoves.size'),0);result(c);
 const f=refresh(c);await welcome(f,h);result(f);deliver(c,rejection);result(c);
});

for(const replacement of ['welcome','fromState'])test(`cached untagged continuation stays dismissed across same-match ${replacement}`,async()=>{
 const st=initial(),c=client();c.load(st,online);
 c.run('clock=10000;Date.now=()=>clock;FX.overlayUntil=FX.loungeUntil=0;document.getElementById("coco-lounge").offsetParent={};document.getElementById("grid").childElementCount=25;asyncFx({type:"fx",toast:"CAT → +8 pts"});_cocoPump();dismissCocoBubble()');
 if(replacement==='welcome')await welcome(c,room(st));else{c.ctx.next=st;c.run('game=Game.fromState(next)')}
 c.run('clock+=100;FX.overlayUntil=FX.loungeUntil=0;asyncFx({type:"fx",toast:"Best possible: CATS"});_cocoPump()');
 assert.equal(c.run('COCO_SAY.showing'),false);assert.equal(c.run('COCO_SAY.q.length'),0);
});

for(const recovery of ['refresh','other-tab','rematch'])test(`cached accepted result survives ${recovery} before receipt retirement`,async()=>{
 const st=initial(),c=client();c.load(st,online+'CONFIG.rounds=1;buildTrie(["CAT"]);');
 c.run('game.handleTileClick(0);game.handleTileClick(1);game.handleTileClick(2);game.submitWord()');
 const closing=c.sent.find(m=>m.op==='move'&&m.state.over),recap=c.sent.find(m=>m.op==='gameover'),h=room(st);
 // Exercise the older wire shape without even a match ID; the worker binds it.
 await push(h,{type:'__a',op:'gameover',players:[...recap.players].reverse()});
 await push(h,closing);const rejection=h.sockets[1].messages.at(-1);
 if(recovery==='rematch'){
  c.run('Math.random=()=>0.9;startRematch();game.swapTargetId=0;game.performSwap("A")');
  const live=plain(c.run('game.serialize()'));deliver(c,rejection);result(c);
  assert.deepEqual(plain(c.run('game.serialize()')),live);assert.equal(c.run('game.over'),false);
  assert.ok(c.run('NET.pendingStart'));assert.ok(c.run('NET.pendingMove'));
 }else{
  c.run('console={...console,warn:()=>{}};originalSet=localStorage.setItem;localStorage.setItem=(k,v)=>{if(k==="spellcoco.stats"||k.startsWith("spellcoco.endings."))throw Error("quota");return originalSet(k,v)}');
  deliver(c,rejection);result(c);assert.equal(c.run('NET.endingMoves.size'),1);
  assert.ok(JSON.parse(c.saved.get('spellcoco.pending.ROOM1')).receipt);
  const f=refresh(c);await welcome(f,h);result(f);assert.equal(f.run('NET.endingMoves.size'),0);
  if(recovery==='other-tab'){
   c.ctx.get=k=>f.saved.get(k)??null;c.ctx.put=(k,v)=>f.saved.set(k,v);c.ctx.del=k=>f.saved.delete(k);
   c.run('localStorage={getItem:get,setItem:put,removeItem:del};NET.resendEndings();NET.resendEndings()');
   result(c);assert.equal(c.run('NET.endingMoves.size'),0);
  }
  const again=refresh(f);await welcome(again,h);result(again);
 }
});

for(const kind of ['word','timeout'])test(`ordinary ${kind} ending without finalPlayers still records once`,async()=>{
 const st=initial();if(kind==='timeout'){st.cocoTimerActive=true;st.timeLeft=1}
 const c=client();c.load(st,online+'CONFIG.rounds=1;buildTrie(["CAT"]);');
 if(kind==='word')c.run('game.handleTileClick(0);game.handleTileClick(1);game.handleTileClick(2);game.submitWord()');
 else{c.fire(c.run('game.timerInterval'));c.fireDelay(800)}
 const closing=c.sent.find(m=>m.op==='move'&&m.state.over),h=room(st);await push(h,closing);
 assert.equal(h.db.get('game').finalPlayers,undefined);deliver(c,h.sockets[1].messages.at(-1));
 await push(h,closing);deliver(c,h.sockets[1].messages.at(-1));
 const f=refresh(c);await welcome(f,h);assert.equal(f.run('STATS.games'),1);
 if(kind==='word')result(f);else{assert.equal(f.run('STATS.draws'),1);assert.equal(f.run('STATS.bestWord'),null)}
});

test('accepted legacy result retries in memory while all storage access is unavailable',async()=>{
 const st=initial(),c=client();c.load(st,online+'CONFIG.rounds=1;buildTrie(["CAT"]);');
 c.run('game.handleTileClick(0);game.handleTileClick(1);game.handleTileClick(2);game.submitWord()');
 const closing=c.sent.find(m=>m.op==='move'&&m.state.over),recap=c.sent.find(m=>m.op==='gameover'),h=room(st);
 await push(h,{type:'__a',op:'gameover',gid:st.id,players:recap.players});await push(h,closing);
 c.run('console={...console,warn:()=>{}};originalStorage=localStorage;localStorage={getItem(){throw Error("unavailable")},setItem(){throw Error("unavailable")},removeItem(){throw Error("unavailable")}}');
 deliver(c,h.sockets[1].messages.at(-1));result(c);c.run('NET.resendEndings()');result(c);
 assert.equal(c.run('NET.endingMoves.size'),1);
 c.run('localStorage=originalStorage;NET.resendEndings()');result(c);assert.equal(c.run('NET.endingMoves.size'),0);
 const f=refresh(c);await welcome(f,h);result(f);
});

for(const replacement of ['welcome','fromState'])for(const elapsed of [899,900,901])test(`legacy dismissal grouping expires at ${elapsed}ms after ${replacement}`,async()=>{
 const st=initial(),c=client();c.load(st,online);
 c.run('clock=10000;Date.now=()=>clock;cocoSay("Score");_cocoPump();dismissCocoBubble();clock+=400');
 if(replacement==='welcome')await welcome(c,room(st));else{c.ctx.next=st;c.run('game=Game.fromState(next)')}
 c.ctx.elapsed=elapsed;c.run('clock=10000+elapsed;FX.overlayUntil=FX.loungeUntil=0;cocoSay("Next line");_cocoPump()');
 assert.equal(c.run('COCO_SAY.showing'),elapsed>=900);assert.equal(c.run('COCO_SAY.q.length'),0);
});

for(const replacement of ['different','idless','new','retire','apply-different'])test(`legacy dismissal clears on ${replacement} game lifecycle`,()=>{
 const st=initial(),c=client();c.load(st,online);
 c.run('clock=10000;Date.now=()=>clock;cocoSay("Score");_cocoPump();dismissCocoBubble();cocoSpeak("Queued old speech")');
 c.ctx.next={...st,id:replacement==='idless'?undefined:'othermatch'};
 if(replacement==='new')c.run('game=new Game()');else if(replacement==='retire')c.run('retireGame()');
 else if(replacement==='apply-different')c.run('game.applyState(next)');else c.run('game=Game.fromState(next)');
 assert.equal(c.run('COCO_SAY.event'),null);assert.equal(c.run('COCO_SAY.dismissed'),null);assert.equal(c.run('COCO_SAY.q.length'),0);
 c.run('clock+=100;FX.overlayUntil=FX.loungeUntil=0;cocoSay("New score");_cocoPump()');assert.equal(c.run('COCO_SAY.showing'),true);
});

test('same-match replacement drops old queues while preserving only the dismissed legacy grouping window',()=>{
 const st=initial(),c=client();c.load(st);
 c.run('clock=10000;Date.now=()=>clock;cocoSay("Score");_cocoPump();for(let i=0;i<6;i++)cocoSay("Continuation "+i);dismissCocoBubble()');
 c.ctx.next=st;c.run('clock+=100;game=Game.fromState(next);cocoSay("Late continuation");_cocoPump()');
 assert.equal(c.run('COCO_SAY.showing'),false);assert.equal(c.run('COCO_SAY.q.length'),0);
 c.run('cocoSpeak("Independent speech");_cocoPump()');assert.equal(c.run('COCO_SAY.showing'),true);
 c.run('cocoSay("Queued other line");game=Game.fromState(next)');
 assert.equal(c.run('COCO_SAY.q.length'),0);assert.equal(c.run('COCO_SAY.showing'),false);
});
