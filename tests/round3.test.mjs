import test from 'node:test';
import assert from 'node:assert/strict';
import {client,state,room,socket,plain} from './helpers.mjs';
const online='NET.async=true;NET.mode="host";UI_MODE="host";NET.code="ROOM1";NET.myName="Keith";NET.seat=0;NET.myIndex=0;NET.rev=0;NET.gameCode="ROOM1";NET.caps={livesel:true};';
const initial=()=>({...state(),id:'match00002'});
const push=(r,s,m)=>r.onMessage(s,JSON.stringify(m));
const deliver=(c,m)=>{c.ctx.reply=plain(m);c.run('asyncOnMessage(reply)')};
const swap=(c,ch)=>c.run(`game.swapTargetId=0;game.performSwap('${ch}')`);
const moves=c=>c.sent.filter(m=>m.op==='move');
const board=(c,ch,gems)=>{assert.equal(c.run('game.tiles[0].char'),ch);assert.equal(c.run('game.players[0].gems'),gems)};
for(const ending of ['word','timeout'])test(''+ending+' then real Rematch before replies remains live',async()=>{
 const st={...initial(),turnIndex:1};st.tiles[0].char='C';st.tiles[1].char='A';st.tiles[2].char='T';if(ending==='timeout'){st.cocoTimerActive=true;st.timeLeft=1}
 const c=client();c.load(st,online+'NET.seat=NET.myIndex=1;NET.myName="Shawn";CONFIG.rounds=1;buildTrie(["CAT"]);');
 if(ending==='word')c.run('game.handleTileClick(0);game.handleTileClick(1);game.handleTileClick(2);game.submitWord()');else{c.fire(c.run('game.timerInterval'));c.fireDelay(800)}
 c.run('startRematch()');const id=c.run('game.id');const h=room(st);for(const m of c.sent.filter(m=>m.type==='__a'))await push(h.r,h.sockets[1],m);for(const reply of h.sockets[1].messages)deliver(c,reply);
 assert.equal(h.db.get('game').id,id);assert.equal(h.db.get('game').over,false);assert.equal(c.run('game.over'),false);assert.equal(c.run('STATS.games'),1);
});
for(const savedSwap of [false,true])test('refreshed durable start allows a newer Swap, prior Swap='+savedSwap,async()=>{
 const original=client();original.load(initial(),online);original.run('NET.sendStart()');if(savedSwap)swap(original,'A');const c=client();for(const [k,v]of original.saved)c.saved.set(k,v);c.run(online+'NET.rev=null;NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');
 const h=room({...state(),over:true,id:'oldmatch01'});await h.r.onHello(h.sockets[0],{name:'Keith',dev:'a'});deliver(c,h.sockets[0].messages.at(-1));swap(c,'B');for(const m of c.sent.filter(m=>m.type==='__a'&&['newgame','move'].includes(m.op))){await push(h.r,h.sockets[0],m);deliver(c,h.sockets[0].messages.at(-1));}
 board(c,'B',savedSwap?2:5);assert.equal(h.db.get('game').tiles[0].char,'B');
});
for(const queued of [false,true])test('a delayed continuation of one real score event stays dismissed, already queued='+queued,()=>{
 const st=initial();[...'CATS'].forEach((ch,i)=>st.tiles[i].char=ch);
 const sender=client();sender.load(st,online+'CONFIG.rounds=5;buildTrie(["CAT","CATS"]);');sender.run('game.handleTileClick(0);game.handleTileClick(1);game.handleTileClick(2);game.submitWord()');
 const toast=sender.sent.filter(m=>m.type==='fx'&&m.toast);assert.match(toast[0].toast,/CAT/);assert.match(toast[1].toast,/Best possible/);
 const c=client();c.load(st,online+'NET.myIndex=NET.seat=1;');c.run('clock=10000;Date.now=()=>clock;FX.overlayUntil=FX.loungeUntil=0;document.getElementById("coco-lounge").offsetParent={};document.getElementById("grid").childElementCount=25;');
 c.ctx.first=plain(toast[0]);c.ctx.second=plain(toast[1]);c.run('asyncFx(first);_cocoPump()');
 if(queued)c.run('clock+=901;asyncFx(second);dismissCocoBubble()');else c.run('dismissCocoBubble();clock+=901;asyncFx(second)');
 if(queued)c.fireDelay(280);else c.run('_cocoPump()');
 assert.equal(c.run('COCO_SAY.showing'),false);assert.equal(c.run('COCO_SAY.q.length'),0);
});
for(const reversed of [false,true])test('duplicate current Swap replies preserve Undo, reverse='+reversed,async()=>{
 const c=client();c.load(initial(),online);swap(c,'A');c.run('NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))};NET.resendPending()');const h=room(initial());for(const m of moves(c))await push(h.r,h.sockets[0],m);
 for(const reply of reversed?[...h.sockets[0].messages].reverse():h.sockets[0].messages)deliver(c,reply);
 assert.equal(c.run('game.applyUndoSwap()'),true);board(c,'E',8);
});
test('reconnect after accepted Swap with lost acknowledgement preserves Undo',async()=>{
 const c=client();c.load(initial(),online);swap(c,'A');const h=room(initial());await push(h.r,h.sockets[0],moves(c).at(-1));c.run('NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');await h.r.onHello(h.sockets[0],{name:'Keith',dev:'a'});deliver(c,h.sockets[0].messages.at(-1));assert.ok(c.run('game.lastSwap'));await push(h.r,h.sockets[0],moves(c).at(-1));deliver(c,h.sockets[0].messages.at(-1));assert.equal(c.run('game.applyUndoSwap()'),true);board(c,'E',8);
});

for(const order of [[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]])test(`ending replies cannot finish a rematch in order ${order}`,async()=>{
 const st={...initial(),turnIndex:1};const c=client();c.load(st,online+'NET.seat=NET.myIndex=1;NET.myName="Shawn";');
 c.run('game.endGame();startRematch()');const id=c.run('game.id');
 const h=room(st),b=h.sockets[1];for(const m of c.sent.filter(m=>m.type==='__a'))await push(h.r,b,m);
 assert.deepEqual(b.messages.map(m=>m.op),['moveok','reject','moveok']);
 assert.equal(b.messages[1].gid,st.id);assert.equal(b.messages[1].q,b.messages[0].q);
 for(const i of order){deliver(c,b.messages[i]);assert.equal(c.run('game.over'),false);assert.equal(c.run('game.id'),id)}
 assert.equal(c.run('STATS.games'),1);assert.equal(c.run('NET.pendingStart'),null);
});

test('cached-worker ending replies and delayed final broadcasts cannot close a pending rematch',()=>{
 const old={...initial(),over:true};const c=client();c.load(old,online);c.run('startRematch()');const id=c.run('game.id');
 deliver(c,{op:'reject',reason:'game-over',state:old,rev:1});
 deliver(c,{op:'state',state:old,rev:1});
 deliver(c,{op:'gameover',gid:old.id,players:old.players,rev:1});
 assert.equal(c.run('game.over'),false);assert.equal(c.run('game.id'),id);assert.ok(c.run('NET.pendingStart'));
});

test('cached clients without ending identity still finish the current room after worker recreation',async()=>{
 const h=room(initial()),a=h.sockets[0];await push(h.r,a,{type:'__a',op:'gameover',players:state().players});
 const end=h.sockets[1].messages.at(-1);assert.equal(end.gid,initial().id);
 const c=client();c.load(initial(),online);deliver(c,end);assert.equal(c.run('game.over'),true);assert.equal(c.run('STATS.games'),1);
 const restarted=new h.r.constructor(h.r.state,{});await push(restarted,a,{type:'__a',op:'gameover',players:state().players});
 deliver(c,a.messages.at(-1));assert.equal(c.run('STATS.games'),1);assert.equal(h.db.get('game').over,true);
});

for(const legacy of [false,true])test(`restored start successors preserve their paid board at a nonzero base, legacy=${legacy}`,async()=>{
 const original=client();original.load(initial(),online+'NET.rev=6;');original.run('NET.sendStart()');swap(original,'A');
 const c=client();for(const [k,v]of original.saved){
  const p=JSON.parse(v);if(legacy&&k.includes('.start.')){delete p.m.stream;delete p.m.base}c.saved.set(k,JSON.stringify(p));
 }
 c.run(online+'NET.rev=null;NET.moveSeq=90;NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');
 const h=room({...initial(),id:'oldmatch01',over:true});h.db.set('rev',6);
 await h.r.onHello(h.sockets[0],{name:'Keith',dev:'a'});deliver(c,h.sockets[0].messages.at(-1));board(c,'A',5);
 const start=c.sent.find(m=>m.op==='newgame');swap(c,'B');const next=moves(c).at(-1);
 assert.equal(next.stream,start.stream);assert.ok(next.q>start.q);
 // Both operations reach storage before either reply is delivered.
 for(const m of [start,next])await push(h.r,h.sockets[0],m);
 for(const m of h.sockets[0].messages.filter(m=>m.op==='moveok'))deliver(c,m);
 board(c,'B',2);assert.equal(h.db.get('game').players[0].gems,2);assert.equal(c.run('NET.pendingMove'),null);
 c.run('confirmShuffle()');await push(h.r,h.sockets[0],moves(c).at(-1));deliver(c,h.sockets[0].messages.at(-1));board(c,c.run('game.tiles[0].char'),1);
});

test('a restored start cannot replace another tab’s accepted live match',async()=>{
 const original=client();original.load(initial(),online);original.run('NET.sendStart()');
 const c=client();for(const [k,v]of original.saved)c.saved.set(k,v);c.run(online);
 const winner={...initial(),id:'winning001'};winner.players[0].gems=3;
 const h=room(winner);h.db.set('rev',2);h.db.set('fr',[2,2]);
 await h.r.onHello(h.sockets[0],{name:'Keith',dev:'a'});deliver(c,h.sockets[0].messages.at(-1));
 assert.equal(c.run('game.id'),winner.id);assert.equal(c.run('game.players[0].gems'),3);assert.equal(c.run('NET.pendingStart'),null);
});

for(const failure of ['quota','unavailable'])test(`same-page pending starts and successors survive storage ${failure}`,async()=>{
 const c=client();c.load(initial(),online);c.run('console={...console,warn:()=>{}};localStorage.setItem=()=>{throw Error("quota")}');
 if(failure==='unavailable')c.run('localStorage.getItem=localStorage.removeItem=()=>{throw Error("storage")}');
 c.run('NET.sendStart()');swap(c,'A');
 const h=room({...initial(),id:'oldmatch01',over:true});await h.r.onHello(h.sockets[0],{name:'Keith',dev:'a'});deliver(c,h.sockets[0].messages.at(-1));
 const retry=c.sent.filter(m=>m.op==='newgame').at(-1);swap(c,'B');
 for(const m of [retry,moves(c).at(-1)]){await push(h.r,h.sockets[0],m);deliver(c,h.sockets[0].messages.at(-1))}
 board(c,'B',2);assert.equal(h.db.get('game').players[0].gems,2);
});

test('duplicate Swap replies preserve elapsed countdown, selection and an Undo that the worker accepts',async()=>{
 const st=initial();st.cocoTimerActive=true;st.timeLeft=17;
 const c=client();c.load(st,online+'dictFileLoaded=true;trieBuilt=true;');swap(c,'A');const move=moves(c).at(-1);
 const h=room(st);await push(h.r,h.sockets[0],move);await push(h.r,h.sockets[0],move);
 const timer=c.run('game.timerInterval');c.fire(timer);c.run('game.handleTileClick(0)');
 for(const m of h.sockets[0].messages)deliver(c,m);
 assert.equal(c.run('game.timerInterval'),timer);assert.equal(c.run('game.timeLeft'),16);assert.deepEqual(plain(c.run('game.selection')),[0]);
 assert.equal(c.run('game.applyUndoSwap()'),true);board(c,'E',8);
 await push(h.r,h.sockets[0],moves(c).at(-1));deliver(c,h.sockets[0].messages.at(-1));assert.equal(h.db.get('game').players[0].gems,8);
});

for(const change of ['board','treats','turn','match','attack'])test(`a genuinely changed ${change} snapshot still closes Undo`,async()=>{
 const c=client();c.load(initial(),online);swap(c,'A');const move=moves(c).at(-1),h=room(initial());await push(h.r,h.sockets[0],move);
 if(change==='attack')await push(h.r,h.sockets[1],{type:'__a',op:'coco'});
 else{
  const st=structuredClone(h.db.get('game'));
  if(change==='board')st.tiles[1].char='Z';if(change==='treats')st.players[0].gems--;if(change==='turn')st.turnIndex=1;if(change==='match')st.id='othermatch';
  // A second tab writes at the current base, with an independent stream.
  const tab=socket(0,'Keith');
  if(change==='match'){
   await push(h.r,tab,{type:'__a',op:'gameover',gid:initial().id,players:st.players});
   await push(h.r,tab,{type:'__a',op:'newgame',state:st,base:2,q:2,stream:'z'.repeat(24)});
  }else await push(h.r,tab,{type:'__a',op:'move',state:st,base:1,q:1,stream:'z'.repeat(24)});
 }
 await push(h.r,h.sockets[0],move);deliver(c,h.sockets[0].messages.at(-1));
 assert.equal(c.run('game.lastSwap'),null);assert.equal(c.run('game.applyUndoSwap()'),false);
});

for(const receive of ['asyncFx','guestOnData'])test(`${receive} keeps distinct score events and standalone speech after dismissal`,()=>{
 const c=client();c.load(initial(),online);c.run('FX.overlayUntil=FX.loungeUntil=0;clock=10000;Date.now=()=>clock;document.getElementById("coco-lounge").offsetParent={};document.getElementById("grid").childElementCount=25;');
 c.run(`${receive}({type:'fx',toast:'First score',event:'score:match00002:1:0'});_cocoPump();dismissCocoBubble();clock+=901;
 ${receive}({type:'fx',toast:'Second score',event:'score:match00002:1:1'});_cocoPump();dismissCocoBubble();clock+=901;
 ${receive}({type:'fx',toast:'Late first best',event:'score:match00002:1:0'});
 ${receive}({type:'fx',toast:'Late second best',event:'score:match00002:1:1'});_cocoPump();`);
 assert.equal(c.run('COCO_SAY.showing'),false);assert.equal(c.run('COCO_SAY.q.length'),0);
 c.run('cocoSay("Unrelated event");_cocoPump()');assert.equal(c.run('COCO_SAY.showing'),true);
 c.run('dismissCocoBubble();cocoSpeak("Independent speech");_cocoPump()');assert.equal(c.run('COCO_SAY.showing'),true);
 c.run('cocoSayReset()');assert.equal(c.run('COCO_SAY.dismissedEvents.size'),0);
});

test('all score continuations, long bonus and treat shift share one event without changing their text',()=>{
 const st=initial();[...'CATX'].forEach((ch,i)=>st.tiles[i].char=ch);
 const c=client();c.load(st,online+'CONFIG.rounds=5;CONFIG.longWordTiers=[{len:3,bonus:5}];buildTrie(["CAT","CATS"]);');
 c.run('game.handleTileClick(0);game.handleTileClick(1);game.handleTileClick(2);game.submitWord()');
 const fx=c.sent.filter(m=>m.type==='fx'&&m.toast);
 assert.match(fx[0].toast,/CAT → \+13 pts/);assert.equal(fx[0].celebrate,'Long word! +5 bonus included');
 assert.ok(fx.some(m=>m.toast.includes('Treats shifted')));assert.ok(fx.some(m=>m.toast.includes('best word')));assert.ok(fx.some(m=>m.toast.includes('With a swap')));
 assert.deepEqual([...new Set(fx.map(m=>m.event))],['score:match00002:1:0']);
});

test('an authoritative shorter countdown still reconciles after another tab advances it',async()=>{
 const st=initial();st.cocoTimerActive=true;st.timeLeft=17;
 const c=client();c.load(st,online);swap(c,'A');const h=room(st),move=moves(c).at(-1);await push(h.r,h.sockets[0],move);
 const advanced=structuredClone(h.db.get('game'));advanced.timeLeft=10;
 const tab=socket(0,'Keith');await push(h.r,tab,{type:'__a',op:'move',state:advanced,q:1,base:1,stream:'z'.repeat(24)});
 await push(h.r,h.sockets[0],move);deliver(c,h.sockets[0].messages.at(-1));assert.equal(c.run('game.timeLeft'),10);
});

test('a legacy restored start keeps socket ordering through an ack between two successor actions',async()=>{
 const original=client();original.load(initial(),online+'NET.rev=4;');original.run('NET.sendStart()');
 const p=JSON.parse(original.saved.get('spellcoco.start.ROOM1'));delete p.m.stream;
 const c=client();c.saved.set('spellcoco.start.ROOM1',JSON.stringify(p));c.run(online);
 const h=room({...initial(),id:'oldmatch01',over:true});h.db.set('rev',4);
 await h.r.onHello(h.sockets[0],{name:'Keith',dev:'a'});deliver(c,h.sockets[0].messages.at(-1));
 const start=c.sent.find(m=>m.op==='newgame');swap(c,'A');const first=moves(c).at(-1);
 await push(h.r,h.sockets[0],start);const ack=h.sockets[0].messages.at(-1);
 await push(h.r,h.sockets[0],first);deliver(c,ack);swap(c,'B');await push(h.r,h.sockets[0],moves(c).at(-1));deliver(c,h.sockets[0].messages.at(-1));
 board(c,'B',2);assert.equal(h.db.get('game').players[0].gems,2);
 c.run('NET.cleanup();NET.async=true;NET.code="ROOM2";NET.sendMove(game.serialize())');assert.match(moves(c).at(-1).stream,/^[a-z0-9]{24}$/);
});
