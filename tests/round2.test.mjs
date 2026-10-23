import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { client, state, plain, room } from './helpers.mjs';

const online='NET.async=true;NET.mode="host";UI_MODE="host";NET.code="ROOM1";NET.myName="Keith";NET.seat=0;NET.myIndex=0;NET.rev=0;';
const initial=()=>({...state(),id:'match00002'});
const push=(r,ws,m)=>r.onMessage(ws,JSON.stringify(m));
const moves=c=>c.sent.filter(m=>m.op==='move');
const swap=(c,ch)=>c.run(`game.swapTargetId=0;game.performSwap("${ch}")`);
function deliver(c,m){c.ctx.reply=m;c.run('asyncOnMessage(reply)')}
function welcome(c,st,rev=0){c.ctx.welcome={seat:0,names:['Keith','Shawn'],state:st,rev};c.run('asyncWelcome(welcome)')}
function board(c,ch,gems){assert.equal(c.run('game.tiles[0].char'),ch);assert.equal(c.run('game.players[0].gems'),gems)}

// Deliver ALL responses in order: the retry's rejection predates the newer Swap.
test('an old retry rejection cannot roll back a newer pending Swap or refund its next Shuffle',async()=>{
  const c=client();c.load(initial(),online);swap(c,'A');
  c.run('NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))};NET.resendPending()');swap(c,'B');
  const {r,db,sockets:[a]}=room(initial());
  for(const m of moves(c))await push(r,a,m);
  assert.deepEqual(a.messages.map(m=>[m.op,m.q]),[['moveok',1],['reject',1],['moveok',2]]);
  for(const reply of a.messages){deliver(c,reply);board(c,'B',2)}
  assert.equal(c.run('NET.pendingMove'),null);
  c.run('confirmShuffle()');await push(r,a,moves(c).at(-1));deliver(c,a.messages.at(-1));
  assert.equal(c.run('game.players[0].gems'),1);assert.equal(db.get('game').players[0].gems,1);
});

test('same-page reconnect preserves an offline same-turn Swap before and after its retry ack',async()=>{
  const c=client();c.load(initial(),online);swap(c,'A');
  c.run('NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');welcome(c,initial());
  const {r,db,sockets:[a]}=room(initial());await push(r,a,moves(c).at(-1));deliver(c,a.messages.at(-1));
  board(c,'A',5);assert.equal(c.run('NET.pendingMove'),null);assert.equal(c.saved.has('spellcoco.pending.ROOM1'),false);
  c.run('confirmShuffle()');await push(r,a,moves(c).at(-1));deliver(c,a.messages.at(-1));
  assert.equal(c.run('game.players[0].gems'),4);assert.equal(db.get('game').players[0].gems,4);
});

test('a start retry acknowledgement cannot erase a newer untracked Shuffle',async()=>{
  const c=client();c.load(initial(),online);c.run('NET.sendStart()');const start=c.sent.find(m=>m.op==='newgame');
  const {r,db,sockets:[a]}=room({...state(),id:'match00001',over:true});await push(r,a,start); // lost first ack
  await push(r,a,start);const retryAck=a.messages.at(-1);
  c.run('confirmShuffle()');assert.equal(c.run('NET.pendingMove'),null);
  const shuffled=plain(c.run('game.serialize()'));deliver(c,retryAck);
  assert.deepEqual(plain(c.run('game.serialize()')),shuffled);
  await push(r,a,moves(c).at(-1));deliver(c,a.messages.at(-1));
  assert.equal(c.run('game.players[0].gems'),7);assert.equal(db.get('game').players[0].gems,7);
});

for(const ending of ['word','timeout'])test(`a client-generated final ${ending} notifies the opponent exactly once`,async()=>{
  const st={...initial(),turnIndex:1,round:1};st.tiles[0].char='C';st.tiles[1].char='A';st.tiles[2].char='T';
  if(ending==='timeout'){st.cocoTimerActive=true;st.timeLeft=1}
  const c=client();c.load(st,online+'NET.seat=1;NET.myIndex=1;NET.myName="Shawn";CONFIG.rounds=1;buildTrie(["CAT"]);');
  const {r,db,sockets:[,b]}=room(st),notifications=[];
  r.notifySeat=async(seat,message)=>{notifications.push({seat,message})};
  if(ending==='word')c.run('game.handleTileClick(0);game.handleTileClick(1);game.handleTileClick(2);game.submitWord()');
  else {c.fire(c.run('game.timerInterval'));c.fireDelay(800)}
  const emitted=c.sent.filter(m=>m.type==='__a');for(const m of emitted)await push(r,b,m);
  assert.equal(db.get('game').over,true);assert.deepEqual(db.get('game').players,plain(c.run('game.serialize().players')));
  assert.deepEqual(notifications.filter(n=>n.message.startsWith('Game over')),[{seat:0,message:'Game over — open SpellCoco for the recap 🏆'}]);
  const finished=structuredClone(db.get('game')),rev=await r.rev();
  for(const m of emitted)await push(r,b,m);
  assert.deepEqual(db.get('game'),finished);assert.equal(await r.rev(),rev);
  assert.equal(notifications.filter(n=>n.message.startsWith('Game over')).length,1);
});

for(const order of [[0,2,1],[2,1,0],[1,0,2]])test(`Swap replies delivered in order ${order} preserve the newest local operation`,async()=>{
  const c=client();c.load(initial(),online);swap(c,'A');const first=moves(c).at(-1);swap(c,'B');
  const {r,sockets:[a]}=room(initial());for(const m of [first,first,moves(c).at(-1)])await push(r,a,m);
  for(const i of order){deliver(c,a.messages[i]);board(c,'B',2)}
  assert.equal(c.run('NET.pendingMove'),null);
});

test('obsolete replies cannot roll back an untracked action after the newer Swap ack',async()=>{
  const c=client();c.load(initial(),online);swap(c,'A');const first=moves(c).at(-1);swap(c,'B');
  const {r,db,sockets:[a]}=room(initial());for(const m of [first,first,moves(c).at(-1)])await push(r,a,m);
  deliver(c,a.messages[2]);c.run('confirmShuffle()');const shuffled=plain(c.run('game.serialize()'));
  deliver(c,a.messages[1]);deliver(c,a.messages[0]);assert.deepEqual(plain(c.run('game.serialize()')),shuffled);
  await push(r,a,moves(c).at(-1));deliver(c,a.messages.at(-1));assert.equal(db.get('game').players[0].gems,1);
});

test('the latest rejection still reconciles a pending Swap after a foreign Coco Attack',async()=>{
  const c=client();c.load(initial(),online);swap(c,'A');
  const {r,db,sockets:[a,b]}=room(initial());await push(r,a,moves(c).at(-1));
  await push(r,b,{type:'__a',op:'coco'});c.run('game.applyUndoSwap()');await push(r,a,moves(c).at(-1));
  deliver(c,a.messages.at(-1));board(c,'A',5);assert.equal(c.run('NET.pendingMove'),null);
  assert.equal(c.run('game.cocoPendingFor'),0);assert.equal(db.get('game').players[1].gems,4);
});

test('older ack and reject snapshots cannot undo an already adopted newer room revision',async()=>{
  const c=client();c.load(initial(),online);c.run('NET.sendStart()');
  const {r,sockets:[a,b]}=room({...state(),id:'match00001',over:true});const start=c.sent.find(m=>m.op==='newgame');
  await push(r,a,start);await push(r,a,start);const ack=a.messages.at(-1);
  swap(c,'A');const move=moves(c).at(-1);await push(r,a,move);await push(r,a,move);const reject=a.messages.at(-1);
  await push(r,b,{type:'__a',op:'coco'});deliver(c,a.messages.at(-1));const attacked=plain(c.run('game.serialize()'));
  deliver(c,ack);deliver(c,reject);assert.deepEqual(plain(c.run('game.serialize()')),attacked);
  assert.equal(c.run('NET.pendingMove'),null);
});

for(const fresh of [false,true])test(`${fresh?'refreshed':'same-page'} pending Swap is the basis for an action made before the reconnect ack`,async()=>{
  const original=client();original.load(initial(),online+'NET.gameCode="ROOM1";');swap(original,'A');
  const c=fresh?client():original;
  if(fresh){for(const [k,v]of original.saved)c.saved.set(k,v);c.run(online)}
  c.run('NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');welcome(c,initial());board(c,'A',5);
  const retry=moves(c).at(-1);c.run('confirmShuffle()');assert.equal(c.run('game.players[0].gems'),4);
  const {r,db,sockets:[a]}=room(initial());
  // Process the follow-up first: it too must contain the paid Swap.
  await push(r,a,moves(c).at(-1));deliver(c,a.messages.at(-1));
  await push(r,a,retry);deliver(c,a.messages.at(-1));
  assert.equal(db.get('game').players[0].gems,4);assert.equal(c.run('game.players[0].gems'),4);
  assert.deepEqual(plain(c.run('game.serialize()')),db.get('game'));assert.equal(c.run('NET.pendingMove'),null);
});

test('same-page reconnect and ack preserve an active countdown and its elapsed seconds',async()=>{
  const st=initial();st.cocoTimerActive=true;st.timeLeft=17;
  const c=client();c.load(st,online+'NET.gameCode="ROOM1";dictFileLoaded=true;trieBuilt=true;');swap(c,'A');
  const interval=c.run('game.timerInterval');c.fire(interval);assert.equal(c.run('game.timeLeft'),16);
  c.run('NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');welcome(c,st);
  assert.equal(c.run('game.timerInterval'),interval);assert.equal(c.run('game.timeLeft'),16);
  const {r,sockets:[a]}=room(st);await push(r,a,moves(c).at(-1));deliver(c,a.messages.at(-1));
  assert.equal(c.run('game.timerInterval'),interval);c.fire(interval);assert.equal(c.run('game.timeLeft'),15);
});

test('a stale disk snapshot cannot gain a current base from an ignored retry and refund newer accepted treats',async()=>{
  const original=client();original.load(initial(),online);swap(original,'A');
  const saved=original.saved.get('spellcoco.pending.ROOM1');
  const {r,db,sockets:[a]}=room(initial());await push(r,a,moves(original).at(-1));
  swap(original,'B');await push(r,a,moves(original).at(-1));
  const fresh=client();fresh.saved.set('spellcoco.pending.ROOM1',saved);fresh.run(online+'NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');
  welcome(fresh,db.get('game'),2);const retry=moves(fresh).at(-1);
  fresh.run('confirmShuffle()');await push(r,a,retry);deliver(fresh,a.messages.at(-1));
  assert.equal(fresh.run('NET.rev'),0,'ignoring a snapshot must not adopt its revision');
  fresh.run('confirmShuffle()');await push(r,a,moves(fresh).at(-1));assert.equal(a.messages.at(-1).reason,'stale');
  deliver(fresh,a.messages.at(-1));board(fresh,'B',2);assert.equal(db.get('game').players[0].gems,2);
});

for(const failure of ['setItem','all'])test(`same-page offline retry works with storage failure: ${failure}`,async()=>{
  const c=client();c.load(initial(),online+'NET.gameCode="ROOM1";');
  c.run('console={...console,warn:()=>{}};localStorage.setItem=()=>{throw Error("quota")}');
  if(failure==='all')c.run('localStorage.getItem=localStorage.removeItem=()=>{throw Error("unavailable")}');
  swap(c,'A');c.run('NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');welcome(c,initial());board(c,'A',5);
  const {r,db,sockets:[a]}=room(initial());await push(r,a,moves(c).at(-1));deliver(c,a.messages.at(-1));
  board(c,'A',5);assert.equal(db.get('game').players[0].gems,5);assert.equal(c.run('NET.pendingMove'),null);
});

test('legacy pending records without match, stream or base still retry and display their paid state',async()=>{
  const st=state(),paid=state();paid.tiles[0].char='A';paid.players[0].gems=5;
  const c=client();c.saved.set('spellcoco.pending.ROOM1',JSON.stringify({m:{type:'__a',op:'move',state:paid,q:7},q:7}));
  c.run(online+'NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');welcome(c,st);
  const {r,sockets:[a]}=room(st);await push(r,a,moves(c).at(-1));deliver(c,a.messages.at(-1));board(c,'A',5);
  assert.equal(c.run('NET.pendingMove'),null);
  // An older relay can omit both ordering fields on a rejection.
  c.ctx.legacy=st;c.run('asyncOnMessage({op:"reject",reason:"not-your-turn",state:legacy})');board(c,'E',8);
});

for(const mode of ['move','gameover'])test(`finished ${mode} notification deduplication survives worker recreation and a rematch can notify again`,async()=>{
  const h=room(initial()),[a]=h.sockets,notifications=[];
  const watch=r=>{r.notifySeat=async(seat,message)=>{notifications.push({seat,message})}};watch(h.r);
  const final={type:'__a',op:mode,q:1,base:0,gid:initial().id,players:state().players,state:{...initial(),over:true}};
  await push(h.r,a,final);assert.equal(notifications.length,1);assert.equal(notifications[0].seat,1);
  const finished=structuredClone(h.db.get('game')),rev=await h.r.rev(),restarted=new h.r.constructor(h.r.state,{});watch(restarted);
  await push(restarted,a,final);assert.equal(notifications.length,1);assert.deepEqual(h.db.get('game'),finished);assert.equal(await restarted.rev(),rev);
  const next={...initial(),id:'match00003'};await push(restarted,a,{type:'__a',op:'newgame',q:2,base:rev,state:next});
  await push(restarted,a,{...final,q:3,base:await restarted.rev(),gid:next.id,state:{...next,over:true}});
  assert.equal(notifications.filter(n=>n.message.startsWith('Game over')).length,2);
});

test('normal non-final word end still advances and notifies the next seat with the paid Swap intact',async()=>{
  const st=initial();st.tiles[1].char='A';st.tiles[2].char='T';
  const c=client();c.load(st,online+'CONFIG.rounds=5;buildTrie(["CAT"]);');swap(c,'C');
  c.run('game.handleTileClick(0);game.handleTileClick(1);game.handleTileClick(2);game.submitWord()');
  const {r,db,sockets:[a]}=room(st),notifications=[];r.notifySeat=async(seat,message)=>{notifications.push({seat,message})};
  for(const m of moves(c)){await push(r,a,m);deliver(c,a.messages.at(-1))}
  assert.deepEqual(db.get('game'),plain(c.run('game.serialize()')));assert.equal(c.run('game.turnIndex'),1);
  assert.ok(notifications.some(n=>n.seat===1&&n.message==='Keith played — your move!'));
  assert.equal(notifications.filter(n=>n.message.startsWith('Game over')).length,0);
});

test('a restored operation still reconciles when another room previously used a higher sequence',async()=>{
  const old=client();old.load(initial(),online);swap(old,'A');const saved=old.saved.get('spellcoco.pending.ROOM1');
  const {r,db,sockets:[a]}=room(initial());await push(r,a,moves(old).at(-1));swap(old,'B');await push(r,a,moves(old).at(-1));
  const c=client();c.saved.set('spellcoco.pending.ROOM1',saved);
  c.run(online+'NET.moveSeq=90;NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');welcome(c,db.get('game'),2);
  await push(r,a,moves(c).at(-1));deliver(c,a.messages.at(-1));board(c,'B',2);assert.equal(c.run('NET.pendingMove'),null);
});

for(const accepted of [1,2])test(`a refreshed pending Swap continues safely when welcome already includes ${accepted} accepted Swaps`,async()=>{
  const original=client();original.load(initial(),online);swap(original,'A');const saved=original.saved.get('spellcoco.pending.ROOM1');
  const {r,db,sockets:[a]}=room(initial());await push(r,a,moves(original).at(-1));
  if(accepted===2){swap(original,'B');await push(r,a,moves(original).at(-1))}
  const c=client();c.saved.set('spellcoco.pending.ROOM1',saved);c.run(online+'NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');
  await r.onHello(a,{name:'Keith',dev:'a'});deliver(c,a.messages.at(-1));board(c,accepted===1?'A':'B',accepted===1?5:2);
  const retry=moves(c).at(-1);c.run('confirmShuffle()');const shuffle=moves(c).at(-1);
  // A retry processed first must not make the follow-up unnecessarily stale.
  await push(r,a,retry);deliver(c,a.messages.at(-1));await push(r,a,shuffle);assert.equal(a.messages.at(-1).op,'moveok');deliver(c,a.messages.at(-1));
  assert.equal(db.get('game').players[0].gems,accepted===1?4:1);assert.deepEqual(plain(c.run('game.serialize()')),db.get('game'));
});

test('a restored newer Swap can continue its proven stream before the retry ack',async()=>{
  const original=client();original.load(initial(),online);swap(original,'A');
  const {r,db,sockets:[a]}=room(initial());await push(r,a,moves(original).at(-1));swap(original,'B');
  const c=client();for(const [k,v]of original.saved)c.saved.set(k,v);c.run(online+'NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');
  await r.onHello(a,{name:'Keith',dev:'a'});deliver(c,a.messages.at(-1));board(c,'B',2);
  const retry=moves(c).at(-1);c.run('confirmShuffle()');const shuffle=moves(c).at(-1);
  for(const m of [retry,shuffle]){await push(r,a,m);assert.equal(a.messages.at(-1).op,'moveok');deliver(c,a.messages.at(-1))}
  assert.equal(db.get('game').players[0].gems,1);assert.deepEqual(plain(c.run('game.serialize()')),db.get('game'));
});

// Copy coverage only; the gameplay tests already exercise multiplier relocation.
test('Zoomies copy in the confirmation and README says multiplier positions change',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const readme=readFileSync(new URL('../README.md',import.meta.url),'utf8');
  const modal=html.match(/id="modal-zoomies-confirm"[^]*?<p[^>]*>([^]*?)<\/p>/)[1];
  assert.match(modal,/multiplier types survive in new spots/);
  assert.match(readme,/Zoomies[^\n]*multiplier types survive in new positions/);
  const changelog=readFileSync(new URL('../CHANGELOG.md',import.meta.url),'utf8');
  assert.equal(changelog.match(/SPELLCOCO (v\d+)/)[1],html.match(/const APP_VERSION='(v\d+)'/)[1]);
});

for(const mood of ['sleepy','cozy','zoomies'])test(`Solo ${mood} completes a human and Coco turn without online operation tracking`,()=>{
  const st=initial();st.players[1].isCoco=true;st.players[1].mood=mood;
  st.tiles[1].char='A';st.tiles[2].char='T';
  const c=client();c.load(st,`NET.mode="local";CONFIG.solo={active:true,mood:"${mood}"};CONFIG.rounds=5;buildTrie(["CAT"]);`);
  swap(c,'C');c.run('game.applyUndoSwap()');board(c,'E',8);swap(c,'C');
  c.run('game.handleTileClick(0);game.handleTileClick(1);game.handleTileClick(2);game.submitWord()');
  assert.equal(c.run('game.turnIndex'),1);c.fireDelay(2100);
  for(let i=0;i<100&&c.run('game.turnIndex')===1;i++){
    const ids=plain(c.run('[...(game._aiTimers||[])]'));
    assert.ok(ids.length,'Coco has a scheduled continuation');
    const id=ids.sort((a,b)=>c.timers.get(a).ms-c.timers.get(b).ms)[0];c.fire(id);
  }
  assert.equal(c.run('game.turnIndex'),0);assert.equal(c.run('game.round'),2);
  assert.equal(moves(c).length,0);assert.equal(c.run('NET.pendingMove'),null);assert.equal(c.run('NET.localSeq'),0);
});

for(const broken of [{},{...state(),players:[state().players[0]]}])test('an unplayable durable record cannot replace a valid welcome board',()=>{
  const c=client();c.saved.set('spellcoco.pending.ROOM1',JSON.stringify({m:{type:'__a',op:'move',state:broken,q:1},q:1}));
  c.run(online);welcome(c,initial());board(c,'E',8);assert.equal(c.run('game.id'),initial().id);assert.equal(c.run('NET.pendingMove'),null);
});
