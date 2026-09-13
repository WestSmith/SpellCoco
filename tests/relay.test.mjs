import test from 'node:test';
import assert from 'node:assert/strict';
import { room, state, socket, client, plain } from './helpers.mjs';

test('reserved server messages cannot be relayed by a seated client', async () => {
  const { r, sockets: [a, b], db } = room();
  for (const op of ['state', 'welcome', 'moveok', 'reject', 'roster', 'peer', 'pong', 'pushok', 'unknown']) {
    await r.onMessage(b, JSON.stringify({ type: '__a', op, state: state(1), seat: 1, q: 7 }));
  }
  assert.deepEqual(a.messages, []);
  assert.deepEqual(db.get('game'), state());
});

test('supported side messages relay; malformed, unknown, and seatless messages do not', async () => {
  const { r, sockets: [a, b] } = room();
  const allowed = [{ type: 'customs', words: ['COCO'] }, { type: 'stats', stats: { games: 1 } },
    { type: 'side', host: 'Keith' }, { type: 'fx', toast: 'Hello' },
    ...['wordreq', 'wordok', 'wordno', 'addword'].map(type => ({ type, w: 'COCO' })),
    { type: 'undoreq', from: 'A', to: 'B' }, { type: 'undook' }, { type: 'undono' }];
  for (const m of allowed) await r.onMessage(b, JSON.stringify(m));
  assert.deepEqual(a.messages, allowed);
  a.messages.length = 0;
  for (const m of [{ type: 'state', state: state(1) }, { type: 'start' }, { type: 'customs', words: ["CAN'T"] },
    { type: 'wordreq', w: ['AB'] }, { type: 'stats', stats: [] }, { type: 'undoreq', from: ['A'], to: 'B' }]) {
    await r.onMessage(b, JSON.stringify(m));
  }
  await r.onMessage(socket(null, 'Visitor'), JSON.stringify(allowed[0]));
  assert.deepEqual(a.messages, []);
});

test('valid serialized v70/v71 state remains accepted for moves, rematches and endings', async () => {
  const { r, sockets: [a], db } = room();
  const c = client(); c.run('game=Game.fromState(inputState)');
  const valid = plain(c.run('game.serialize()'));
  await r.onMove(a, { q: 1, state: valid });
  assert.equal(a.messages.at(-1).op, 'moveok');
  await r.onNewGame(a, { q: 2, state: valid });
  assert.equal(a.messages.at(-1).q, 2);
  await r.onGameOver(a, { type: '__a', op: 'gameover', players: valid.players });
  assert.equal(db.get('game').over, true);
  assert.deepEqual(db.get('game').finalPlayers, valid.players);
});

const invalid = {
  'missing player': s => { s.players = [null, null]; },
  'array player': s => { s.players[0] = []; },
  'missing board tile': s => { s.tiles.pop(); },
  'null board tile': s => { s.tiles[0] = null; },
  'unsupported character': s => { s.tiles[0].char = "'"; },
  'invalid multiplier': s => { s.tiles[0].mult = '9W'; },
  'invalid seat': s => { s.turnIndex = 2; },
  'invalid starting seat': s => { s.startIndex = 2; },
  'duplicate selection': s => { s.sel = [1, 1]; },
  'out of bounds selection': s => { s.sel = [25]; },
  'negative timer': s => { s.timeLeft = -1; },
  'negative score': s => { s.players[0].score = -1; },
  'wrong timer type': s => { s.cocoTimerActive = 'false'; },
  'wrong attack seat': s => { s.cocoPendingFor = 3; },
  'invalid recap': s => { s.finalPlayers = [null, null]; },
  'oversized UTF-8 state': s => { s.extra = '🐾'.repeat(140000); }
};
for (const [name, corrupt] of Object.entries(invalid)) test('rejects ' + name + ' without replacing the room', async () => {
  const { r, db, sockets: [a, b] } = room();
  for (const method of ['onMove', 'onNewGame']) {
    const bad = state(); corrupt(bad);
    await r[method](a, { state: bad, q: 44 });
    assert.equal(a.messages.at(-1).reason, 'bad-state');
    assert.equal(a.messages.at(-1).q, 44);
    assert.deepEqual(db.get('game'), state());
  }
  assert.deepEqual(b.messages, []);
});

test('invalid final players cannot poison the stored game through gameover', async () => {
  const { r, db, sockets: [a, b] } = room();
  await r.onGameOver(a, { type: '__a', op: 'gameover', players: [null, null] });
  assert.equal(a.messages.at(-1).reason, 'bad-state');
  assert.deepEqual(db.get('game'), state());
  assert.deepEqual(b.messages, []);
});
