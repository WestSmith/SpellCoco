import test from 'node:test';
import assert from 'node:assert/strict';
import { room, state, client, plain } from './helpers.mjs';

// v71: room revisions (audit finding 1), durable pending moves (2), statistics
// over the async relay (9) and per-match recap dedup (10).

const move = (seat, base, st, q) => ({ type: '__a', op: 'move', state: st, q, base });

test('a replayed move after a lost ack cannot roll back the opponent\'s turn', async () => {
  const { r, sockets: [a, b], db } = room();
  const aMove = state(1); aMove.players[0].score = 10;
  await r.onMessage(a, JSON.stringify(move(0, 0, aMove, 1)));           // A plays; ack (rev 1) is lost on the way back
  assert.deepEqual(a.messages.at(-1), { type: '__a', op: 'moveok', q: 1, rev: 1 });
  assert.equal(b.messages.at(-1).rev, 1);
  const bMove = state(0, 2); bMove.players[0].score = 10; bMove.players[1].score = 20;
  await r.onMessage(b, JSON.stringify(move(1, 1, bMove, 1)));           // B answers
  assert.equal(b.messages.at(-1).rev, 2);
  await r.onMessage(a, JSON.stringify(move(0, 0, aMove, 1)));           // A reconnects and re-pushes the old snapshot
  const rej = a.messages.at(-1);
  assert.equal(rej.op, 'reject'); assert.equal(rej.reason, 'stale'); assert.equal(rej.q, 1); assert.equal(rej.rev, 2);
  assert.deepEqual(rej.state, bMove);
  assert.deepEqual(db.get('game'), bMove);                                // round 2 and B's 20 points survive
});

test('a selection sync in flight cannot erase a Coco Attack that just landed', async () => {
  const { r, sockets: [a, b], db } = room();
  await r.onMessage(a, JSON.stringify(move(0, 0, state(), 1)));         // A's first selection sync: rev 1
  await r.onMessage(b, JSON.stringify({ type: '__a', op: 'coco' }));    // B attacks: rev 2, foreign to A
  assert.equal(db.get('game').cocoPendingFor, 0); assert.equal(db.get('game').players[1].gems, 4);
  assert.equal(a.messages.at(-1).op, 'state'); assert.equal(a.messages.at(-1).rev, 2);
  const sel = state(); sel.sel = [0, 1];
  await r.onMessage(a, JSON.stringify(move(0, 1, sel, 2)));             // A's next sync was built on rev 1
  assert.equal(a.messages.at(-1).reason, 'stale');
  assert.equal(db.get('game').cocoPendingFor, 0); assert.equal(db.get('game').players[1].gems, 4);
  const sel2 = state(); sel2.sel = [0, 1]; sel2.cocoPendingFor = 0; sel2.players[1].gems = 4;
  await r.onMessage(a, JSON.stringify(move(0, 2, sel2, 3)));            // rebuilt on rev 2 → accepted
  assert.equal(a.messages.at(-1).op, 'moveok'); assert.equal(a.messages.at(-1).rev, 3);
});

test('a seat\'s own rapid pushes never trip the stale check; clients without base are accepted', async () => {
  const { r, sockets: [a] } = room();
  for (const q of [1, 2, 3]) await r.onMessage(a, JSON.stringify(move(0, 0, state(), q)));   // base lags own acks
  assert.deepEqual(a.messages.map(m => m.op), ['moveok', 'moveok', 'moveok']);
  await r.onMessage(a, JSON.stringify({ type: '__a', op: 'move', state: state(), q: 4 }));     // pre-v71 client
  assert.equal(a.messages.at(-1).op, 'moveok'); assert.equal(a.messages.at(-1).rev, 4);
});

test('a rematch pushed from a board that predates the opponent\'s rematch is refused', async () => {
  const { r, sockets: [a, b], db } = room();
  const over = state(); over.over = true;
  await r.onMessage(a, JSON.stringify(move(0, 0, over, 1)));            // rev 1: the ending
  await r.onMessage(a, JSON.stringify({ type: '__a', op: 'newgame', state: state(1), q: 2, base: 1 }));   // rev 2
  assert.equal(b.messages.at(-1).op, 'newgame'); assert.equal(b.messages.at(-1).rev, 2);
  const theirs = state(0); theirs.players[0].name = 'Shawn'; theirs.players[1].name = 'Keith';
  await r.onMessage(b, JSON.stringify({ type: '__a', op: 'newgame', state: theirs, q: 9, base: 1 }));   // B still looked at rev 1
  assert.equal(b.messages.at(-1).reason, 'stale'); assert.equal(b.messages.at(-1).q, 9);
  assert.deepEqual(db.get('game'), state(1));
  assert.equal(await r.rev(), 2);
});

test('gameover and welcome carry the room revision', async () => {
  const { r, sockets: [a, b] } = room();
  await r.onGameOver(a, { type: '__a', op: 'gameover', players: state().players, gid: 'abc123def0' });
  assert.equal(b.messages.at(-1).rev, 1); assert.equal(b.messages.at(-1).gid, 'abc123def0');
  await r.onHello(a, { name: 'Keith', dev: 'a' });
  assert.equal(a.messages.at(-1).op, 'welcome'); assert.equal(a.messages.at(-1).rev, 1);
});

// ---- client ----
const online = 'NET.async=true;NET.mode="host";UI_MODE="host";NET.code="ROOM1";NET.myName="Keith";NET.seat=0;NET.myIndex=0;';

test('a turn-completing move is stored durably and carries the base revision', () => {
  const c = client();
  c.run(online + 'NET.rev=5;game=Game.fromState(inputState);game.turnIndex=1;game.players[0].score=30;NET.sendMove(game.serialize())');
  assert.equal(c.sent.at(-1).base, 5);
  const p = JSON.parse(c.saved.get('spellcoco.pending.ROOM1'));
  assert.equal(p.m.state.players[0].score, 30); assert.equal(p.m.base, 5); assert.equal(p.q, 1);
  c.run('asyncOnMessage({op:"moveok",q:1,rev:6})');
  assert.equal(c.run('NET.pendingMove'), null); assert.equal(c.saved.has('spellcoco.pending.ROOM1'), false);
  assert.equal(c.run('NET.rev'), 6);
});

test('a fresh page load re-pushes the stored move and shows it once the room accepts it', () => {
  const c = client();
  const st = state(1); st.players[0].score = 30;
  c.saved.set('spellcoco.pending.ROOM1', JSON.stringify({ m: { type: '__a', op: 'move', state: st, q: 7, base: 5 }, q: 7, at: 1 }));
  c.run(online + 'dictFileLoaded=true;trieBuilt=true;NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))};asyncWelcome({seat:0,names:["Keith","Shawn"],state:inputState,config:null,rev:5})');
  const replay = c.sent.find(m => m.op === 'move');
  assert.equal(replay.q, 7); assert.equal(replay.base, 5); assert.equal(replay.state.players[0].score, 30);
  assert.equal(c.run('NET.moveSeq'), 7);
  assert.equal(c.run('game.turnIndex'), 0);                              // the welcome loaded the room's pre-move board
  c.run('asyncOnMessage({op:"moveok",q:7,rev:6})');
  assert.equal(c.run('game.turnIndex'), 1); assert.equal(c.run('game.players[0].score'), 30);
  assert.equal(c.saved.has('spellcoco.pending.ROOM1'), false); assert.equal(c.run('NET.rev'), 6);
});

test('a stale reject drops the stored move, adopts the room and tells the player', () => {
  const c = client();
  c.run(online + 'NET.rev=5;game=Game.fromState(inputState);game.note=m=>{noted=m};noted=null;game.turnIndex=1;game.players[0].score=30;NET.sendMove(game.serialize())');
  const theirs = state(0, 2); theirs.players[1].score = 20;
  c.ctx.theirs = theirs;
  c.run('asyncOnMessage({op:"reject",reason:"stale",q:1,state:theirs,rev:8})');
  assert.equal(c.run('NET.pendingMove'), null); assert.equal(c.saved.has('spellcoco.pending.ROOM1'), false);
  assert.equal(c.run('game.round'), 2); assert.equal(c.run('game.players[1].score'), 20); assert.equal(c.run('NET.rev'), 8);
  assert.match(c.run('noted'), /didn’t land/);
});

test('a stale selection sync is adopted without a scolding note', () => {
  const c = client();
  c.run(online + 'NET.rev=1;game=Game.fromState(inputState);game.note=m=>{noted=m};noted=null;NET.sendMove(game.serialize())');
  assert.equal(c.run('NET.pendingMove'), null);                          // selection syncs are untracked
  const atk = state(); atk.cocoPendingFor = 0; c.ctx.atk = atk;
  c.run('asyncOnMessage({op:"reject",reason:"stale",q:1,state:atk,rev:2})');
  assert.equal(c.run('game.cocoPendingFor'), 0); assert.equal(c.run('noted'), null); assert.equal(c.run('NET.rev'), 2);
});

test('the all-time record is sent on every async welcome and when the opponent arrives', () => {
  const c = client();
  c.run(online + 'STATS.games=3;asyncWelcome({seat:0,names:["Keith","Shawn"],state:null,config:null,rev:0})');
  assert.equal(c.sent.filter(m => m.type === 'stats').length, 1); assert.equal(c.sent.find(m => m.type === 'stats').stats.games, 3);
  c.run('asyncOnMessage({op:"peer",seat:1,name:"Shawn",present:true})');
  assert.equal(c.sent.filter(m => m.type === 'stats').length, 2);
});

test('two different matches in one room both count; the same match counts once', () => {
  const c = client();
  const keith = [{ name: 'Keith', score: 20, wordsPlayed: [] }, { name: 'Shawn', score: 10, wordsPlayed: [] }];
  const shawn = [{ name: 'Shawn', score: 30, wordsPlayed: [] }, { name: 'Keith', score: 10, wordsPlayed: [] }];
  c.ctx.keith = keith; c.ctx.shawn = shawn;
  c.run(online + 'STATS={games:0,draws:0,wins:{Keith:0,Shawn:0}};recordStatsOnce(keith,"match00001");recordStatsOnce(keith,"match00001");recordStatsOnce(shawn,"match00002")');
  assert.deepEqual(plain(c.run('({g:STATS.games,k:STATS.wins.Keith,s:STATS.wins.Shawn})')), { g: 2, k: 1, s: 1 });
  c.run('recordStatsOnce(shawn,null);recordStatsOnce(keith,"match00003");recordStatsOnce(keith,null)');   // legacy (id-less) endings keep the room-level rule
  assert.deepEqual(plain(c.run('({g:STATS.games,k:STATS.wins.Keith,s:STATS.wins.Shawn})')), { g: 3, k: 2, s: 1 });
});

test('the match id rides serialize(), survives a round trip, and reaches the gameover op', () => {
  const c = client();
  c.run(online + 'game=new Game({names:["Keith","Shawn"]})');
  const id = c.run('game.id'); assert.match(id, /^[a-z0-9]{10}$/);
  const st = plain(c.run('game.serialize()')); assert.equal(st.id, id);
  c.ctx.st = st; c.run('game=Game.fromState(st)'); assert.equal(c.run('game.id'), id);
  c.run('game.round=99;game.endGame()');
  assert.equal(c.sent.find(m => m.op === 'gameover').gid, id);
  assert.equal(c.saved.get('spellcoco.gover.ROOM1'), JSON.stringify(id));
});
