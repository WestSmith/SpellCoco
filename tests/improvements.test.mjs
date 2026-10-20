import test from 'node:test';
import assert from 'node:assert/strict';
import { client, state, plain, room, socket } from './helpers.mjs';
const online='NET.async=true;NET.mode="host";UI_MODE="host";NET.code="ROOM1";NET.myName="Keith";NET.seat=0;NET.myIndex=0;';

test('swap and undo snapshots survive refresh and clear only on acknowledgement', () => {
  const c=client(); c.load(state(),online);
  c.run('game.swapTargetId=0;game.performSwap("A")');
  const p=JSON.parse(c.saved.get('spellcoco.pending.ROOM1'));
  assert.equal(p.m.state.tiles[0].char,'A'); assert.equal(p.m.state.turnIndex,0);
  c.run('NET.pendingMove=null;NET.restorePending()');
  assert.equal(c.run('NET.pendingMove.restored'),true);
  c.run('game.applyUndoSwap()');
  assert.equal(JSON.parse(c.saved.get('spellcoco.pending.ROOM1')).m.state.tiles[0].char,'E');
  c.run('asyncOnMessage({op:"moveok",q:NET.pendingMove.q})');
  assert.equal(c.saved.has('spellcoco.pending.ROOM1'),false);
});

test('new match start survives a fresh client and retries ahead of moves', () => {
  const c=client(); c.load(state(),online); c.run('NET.sendStart()');
  const saved=c.saved.get('spellcoco.start.ROOM1'); assert.ok(saved);
  const fresh=client(); fresh.saved.set('spellcoco.start.ROOM1',saved);
  fresh.run(online+'NET.restoreStart();NET.resendPending()');
  assert.equal(fresh.sent.at(-1).op,'newgame'); assert.equal(fresh.run('game.round'),1);
  fresh.run('asyncOnMessage({op:"moveok",q:NET.pendingStart.q})');
  assert.equal(fresh.saved.has('spellcoco.start.ROOM1'),false);
});

test('failed storage writes return failure and warn', () => {
  const c=client(); c.run('warns=[];console={...console,warn:(...a)=>warns.push(a)};localStorage.setItem=()=>{throw Error("quota")}');
  assert.equal(c.run('lsSet("spellcoco.pending.ROOM1",{})'),false);
  assert.match(c.run('warns[0][0]'),/could not save/);
});

test('retiring Coco cancels pass and grid listeners; even an already queued callback is harmless', () => {
  const c=client(), st=state(); st.players[0].isCoco=true;
  c.load(st,'CONFIG.solo={active:true,mood:"sleepy"};buildTrie(["ZZ"])');
  c.run('cocoTakeTurn()');
  const pass=[...c.timers.entries()].find(([,t])=>t.ms===1400); assert.ok(pass);
  const callback=pass[1].f;
  c.load(state(),'CONFIG.solo=null');
  assert.equal(c.timers.has(pass[0]),false);
  const before=plain(c.run('game.serialize()')); callback();
  assert.deepEqual(plain(c.run('game.serialize()')),before);
  for(const handlers of Object.values(c.els.get('grid').listeners)) assert.equal(handlers.length,1);
});

test('AI steps from an earlier turn cannot run even on the same game', () => {
  const c=client(); c.load();
  c.run('calls=0;game.aiLater(()=>calls++,25);game.round++'); c.fireDelay(25);
  assert.equal(c.run('calls'),0);
});

test('worker rejects wrong-match, wrong-seat and repeated endings without writes', async () => {
  const initial=state(); initial.id='match00001';
  const {r,db,sockets:[a,b]}=room(initial);
  for(const [ws,m,reason] of [
    [a,{op:'gameover',gid:'match00002',players:initial.players},'wrong-match'],
    [b,{op:'gameover',gid:initial.id,players:initial.players},'not-your-turn'],
    [a,{op:'move',state:{...initial,id:'match00002',over:true},q:1},'wrong-match']
  ]) {
    await r.onMessage(ws,JSON.stringify({type:'__a',...m}));
    assert.equal(ws.messages.at(-1).reason,reason); assert.deepEqual(db.get('game'),initial);
  }
  await r.onGameOver(a,{type:'__a',op:'gameover',gid:initial.id,players:initial.players});
  assert.equal(db.get('game').over,true); const rev=await r.rev();
  await r.onGameOver(a,{type:'__a',op:'gameover',gid:initial.id,players:initial.players});
  assert.equal(a.messages.at(-1).reason,'game-over'); assert.equal(await r.rev(),rev);
  await r.onMove(a,{state:{...initial,over:true},q:2});
  assert.equal(a.messages.at(-1).reason,'game-over'); assert.equal(await r.rev(),rev);
});

test('worker refuses live-match replacement, acks identical start retries, allows finished rematches', async () => {
  const initial={...state(),id:'match00001'}, next={...state(),id:'match00002'};
  const {r,db,sockets:[a]}=room(initial);
  await r.onNewGame(a,{state:next,q:1}); assert.equal(a.messages.at(-1).reason,'match-active');
  await r.onNewGame(a,{state:{...initial,round:9},q:2});
  assert.equal(a.messages.at(-1).op,'moveok'); assert.deepEqual(db.get('game'),initial);
  db.set('game',{...initial,over:true}); await r.onNewGame(a,{state:next,q:3});
  assert.deepEqual(db.get('game'),next);
});

test('legacy id-less endings retain active-seat checks', async () => {
  const {r,db,sockets:[a]}=room();
  await r.onGameOver(a,{type:'__a',op:'gameover',players:state().players});
  assert.equal(db.get('game').over,true);
});

test('room codes use cryptographic random bytes with the original alphabet and length', () => {
  const c=client(); c.run('n=0;crypto={getRandomValues:a=>{a[0]=[255,0,1,2,3][n++];return a}};Math.random=()=>{throw Error("insecure")}');
  assert.equal(c.run('genCode()'),'ABCD'); assert.equal(c.run('n'),5);
});

test('unseated and rejected third sockets receive no game or broadcasts', async () => {
  const {r,sockets,db}=room(); const third=socket(null,'Third'); sockets.push(third);
  await r.onHello(third,{name:'Third',dev:'c'});
  const welcome=third.messages.at(-1); assert.equal(welcome.seat,-1);
  assert.equal(welcome.state,null); assert.equal(welcome.config,null);
  const peek=socket(null,null); sockets.push(peek); third.messages.length=0;
  await r.onMove(sockets[0],{state:state(1),q:1});
  assert.equal(third.messages.length,0); assert.equal(peek.messages.length,0);
  assert.equal(sockets[1].messages.at(-1).op,'state');
});

test('dictionary checker renders markup input as literal text', () => {
  const c=client(); const input=c.doc.getElementById('dict-check-input');
  for(const text of ['<B>CAT</B>','<IMG SRC=X ONERROR=ALERT(1)>','<','"&']) {
    input.value=text; c.run('checkDictWord()');
    const html=c.doc.getElementById('dict-check-result').innerHTML;
    assert.ok(!html.includes('<B>')&&!html.includes('<IMG'));
    assert.ok(html.includes(c.run('escHtml(document.getElementById("dict-check-input").value)')));
  }
});

test('word requests and remembered room names escape user strings', () => {
  const c=client(); c.run('NET.oppName="<img src=x>";showWordRequest("CAT")');
  assert.match(c.doc.getElementById('wordreq-text').innerHTML,/&lt;img src=x&gt;/);
  const before=c.doc.getElementById('wordreq-text').innerHTML;
  c.run('showWordRequest("<B>CAT</B>")'); assert.equal(c.doc.getElementById('wordreq-text').innerHTML,before);
  c.saved.set('spellcoco.games',JSON.stringify({ROOM1:{opp:'<svg onload=x>',turn:'them'}})); c.run('renderMyGames()');
  assert.ok(!c.doc.getElementById('my-games').innerHTML.includes('<svg'));
});

test('recap efficiency explicitly describes played words only', () => {
  const c=client(); c.load();
  c.run('game.players[0].wordsPlayed=[{word:"EE",score:2,round:1,gemCount:0,longBonus:0,wordMult:1,tiles:[],best:{word:"EEE",score:3}}];game.renderRecap(game.players)');
  assert.match(c.doc.getElementById('recap-section').innerHTML,/Played-word efficiency: <strong>67%/);
});

test('dismissed Coco messages stay hidden for their event; new messages still show', () => {
  const c=client(); c.load(); c.run('FX.overlayUntil=0;FX.loungeUntil=0;cocoSay("Score");_cocoPump()');
  assert.equal(c.run('COCO_SAY.showing'),true);
  c.run('dismissCocoBubble();cocoSay("Late best-score line");_cocoPump()');
  assert.equal(c.run('COCO_SAY.showing'),false); assert.equal(c.run('COCO_SAY.q.length'),0);
  c.run('cocoSpeak("New personality event");_cocoPump()');
  assert.equal(c.run('COCO_SAY.showing'),true);
  assert.match(c.doc.getElementById('coco-bubble').innerHTML,/New personality event/);
});

test('Escape dismisses Coco and cancels its hide timer', () => {
  const c=client(); c.load(); c.run('FX.overlayUntil=0;cocoSpeak("Hello");_cocoPump()');
  const id=c.run('COCO_SAY.hideTimer'); let prevented=false,stopped=false;
  for(const f of c.events['document:keydown'])f({key:'Escape',preventDefault(){prevented=true},stopPropagation(){stopped=true}});
  assert.equal(c.run('COCO_SAY.showing'),false); assert.equal(c.timers.has(id),false);
  assert.equal(prevented&&stopped,true);
});

test('delayed speech still follows a completed turn, but cannot speak into a replacement game', () => {
  const c=client(); c.load();
  c.run('game.aiLater(()=>cocoSpeak("Turn reaction"),42,false);game.turnIndex=1'); c.fireDelay(42);
  assert.equal(c.run('COCO_SAY.q[0].lines[0]'),'Turn reaction');
  c.run('game.aiLater(()=>cocoSpeak("Old reaction"),43,false)');
  const callback=[...c.timers.values()].find(t=>t.ms===43).f;
  c.load(); callback(); assert.equal(c.run('COCO_SAY.q.length'),0);
});

test('refresh retries a stored new start against the old recap, even if the new match ended offline', () => {
  const c=client(); c.load({...state(),id:'match00001'},online); c.run('NET.sendStart();game.over=true;NET.sendMove(game.serialize())');
  const fresh=client();for(const [k,v] of c.saved)fresh.saved.set(k,v);
  const old={...state(),id:'match00000',over:true};fresh.ctx.old=old;
  fresh.run(online+'asyncWelcome({seat:0,names:["Keith","Shawn"],state:old,rev:0})');
  const replay=fresh.sent.find(m=>m.op==='newgame'); assert.ok(replay);
  assert.equal(replay.state.id,'match00001'); assert.equal(replay.state.over,true);
  assert.ok(fresh.saved.has('spellcoco.start.ROOM1'));
});

test('dismissal preserves queued new utterances and subsequent event messages', () => {
  const c=client();c.load();
  c.run('FX.overlayUntil=0;cocoSpeak("First");_cocoPump();cocoSpeak("Second");dismissCocoBubble()');c.fireDelay(280);
  assert.equal(c.run('COCO_SAY.showing'),true); assert.match(c.doc.getElementById('coco-bubble').innerHTML,/Second/);
  c.run('dismissCocoBubble();cocoSay("A new score event");_cocoPump()');
  assert.match(c.doc.getElementById('coco-bubble').innerHTML,/A new score event/);
});
