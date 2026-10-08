import test from 'node:test';
import assert from 'node:assert/strict';
import { client, state, plain } from './helpers.mjs';

// v75: every finished turn is kept, and the play history / recap replay any round.
const E25 = 'E..'.repeat(25);
const turn = (by, round, steps = [{ k: 'hint' }]) => ({ by, round, start: E25, end: E25, steps });
function playTimeouts(c, n) {
  for (let i = 0; i < n; i++) c.run('game.logStep({k:"timeout"});game.endTurn()');
}

test('every finished turn is kept, in order, and rides the state', () => {
  const c = client(); c.load(state(), 'NET.mode="local"');
  playTimeouts(c, 5);                                                         // R1 Keith, R1 Shawn, R2 Keith, R2 Shawn, R3 Keith
  const turns = plain(c.run('game.turns'));
  assert.deepEqual(turns.map(t => [t.by, t.round]), [[0, 1], [1, 1], [0, 2], [1, 2], [0, 3]]);
  assert.deepEqual(plain(c.run('game.lastTurn')), turns.at(-1));
  assert.deepEqual(plain(c.run('game.serialize().turns')), turns);
  assert.equal(c.run('game.turnIndexFor(1,2)'), 3); assert.equal(c.run('game.turnIndexFor(1,3)'), -1);
  // a reload (local save / room state) brings them all back
  c.ctx.saved = plain(c.run('game.serialize()')); c.run('game=Game.fromState(saved)');
  assert.deepEqual(plain(c.run('game.turns')), turns);
});

test('a v74 state (lastTurn only) still works, and a v74 peer adds its turn to ours', () => {
  const c = client(), st = state(1); st.lastTurn = turn(0, 1);
  c.load(st, 'NET.async=true;NET.mode="host";NET.code="R";NET.seat=1;NET.myIndex=1;');
  assert.deepEqual(plain(c.run('game.turns')), [turn(0, 1)]);
  c.ctx.next = { ...state(1, 2), lastTurn: turn(0, 2) };                     // no `turns` field
  c.run('game.applyState(next)');
  assert.deepEqual(plain(c.run('game.turns.map(t=>t.round)')), [1, 2]);
  c.run('game.applyState(next)');                                             // the same turn again isn't duplicated
  assert.equal(c.run('game.turns.length'), 2);
  c.ctx.next = { ...state(1, 3), lastTurn: turn(0, 3), turns: [turn(1, 2), turn(0, 3)] };
  c.run('game.applyState(next)');                                             // a v75 room's list is authoritative
  assert.deepEqual(plain(c.run('game.turns.map(t=>[t.by,t.round])')), [[1, 2], [0, 3]]);
});

test('turn lists are rebuilt from validated pieces and capped', () => {
  const c = client(), st = state();
  st.turns = [turn(0, 1), { ...turn(1, 1), by: 5 }, { ...turn(0, 2), end: 'nope' }, 'x', null,
    ...Array.from({ length: 150 }, (_, i) => turn(i % 2, 3))];
  c.load(st);
  const turns = plain(c.run('game.turns'));
  assert.equal(turns.length, 100);
  assert.ok(turns.every(t => (t.by === 0 || t.by === 1) && t.end === E25));
});

test('past the byte budget the oldest turns drop out, never the newest', () => {
  const c = client(); c.load(state(), 'NET.mode="local";CONFIG.rounds=50;');
  c.run('const s=boardCode(game.tiles);for(let n=0;n<60;n++){for(let i=0;i<39;i++)game.logStep({k:"swap",id:0,from:"E",to:"E",b:s});game.logStep({k:"timeout"});game.endTurn()}');
  const size = c.run('JSON.stringify(game.turns).length'), n = c.run('game.turns.length');
  assert.ok(size <= 150000, String(size)); assert.ok(n < 60 && n > 1);
  assert.deepEqual(plain(c.run('[game.turns.at(-1).by,game.turns.at(-1).round]')), [1, 30]);
});

test('the play history has a ▶ Replay for each round that player played, timeouts included', () => {
  const c = client(), st = catBoardWords();
  c.load(st, 'NET.mode="local";buildTrie(["CAT"]);');
  c.run('game.handleTileClick(0);game.handleTileClick(1);game.handleTileClick(2);game.submitWord()');   // R1 Keith: CAT
  playTimeouts(c, 2);                                                         // R1 Shawn, R2 Keith (timeout, no word)
  c.run('game.showPlayerHistory(0)');
  const html = c.els.get('history-body').innerHTML;
  assert.match(html, /Round 1 — .*openReplayTurn\(0\)/s);
  assert.match(html, /Round 2 — 0 pts.*openReplayTurn\(2\)/s);                // a round with no word still gets its replay
  assert.equal((html.match(/openReplayTurn/g) || []).length, 2);
  c.run('openReplayTurn(2)');
  assert.equal(c.els.get('replay-sub').textContent, 'Round 2');
  assert.equal(c.els.get('replay-heading').textContent, "Replay — Keith's turn");
  c.run('game.showPlayerHistory(1)');
  assert.match(c.els.get('history-body').innerHTML, /openReplayTurn\(1\)/);   // Shawn's timeout round
});

test('the game-over recap has a ▶ Replay per round, found by seat even in ranked order', () => {
  const c = client(), st = state(); st.players[1].score = 50;                 // Shawn ranks first
  c.load(st, 'NET.mode="local";CONFIG.rounds=1;');
  playTimeouts(c, 2);
  const html = c.els.get('recap-section').innerHTML;
  const shawn = html.indexOf('recap-name">Shawn'), keith = html.indexOf('recap-name">Keith');
  assert.ok(shawn >= 0 && shawn < keith);
  assert.match(html.slice(shawn, keith), /openReplayTurn\(1\)/);             // Shawn's round 1 is turns[1]
  assert.match(html.slice(keith), /openReplayTurn\(0\)/);
  assert.match(html, /event\.preventDefault\(\);event\.stopPropagation\(\)/); // doesn't fold the round
});

test('legacy game-over messages and reject endings carry the whole list', () => {
  const host = client(), st = state(1); st.startIndex = 0;
  host.load({ ...st, turns: [turn(0, 1)], lastTurn: turn(0, 1) }, 'NET.mode="host";NET.myIndex=1;CONFIG.rounds=1;');
  host.run('game.logStep({k:"timeout"});game.endTurn()');
  const over = host.sent.find(m => m.type === 'gameover');
  assert.deepEqual(plain(over.turns).map(t => [t.by, t.round]), [[0, 1], [1, 1]]);
  const guest = client(); guest.load(state(1), 'NET.mode="join";NET.myIndex=0;');
  guest.ctx.over = over; guest.run('guestOnData(over)');
  assert.equal(guest.run('game.turns.length'), 2);
  const a = client(); a.load({ ...state(0), turns: [turn(0, 1)] }, 'NET.async=true;NET.mode="host";NET.code="R";NET.seat=0;NET.myIndex=0;');
  a.ctx.m = { op: 'reject', reason: 'game-over', state: { ...state(0, 2), over: true, lastTurn: turn(1, 1), turns: [turn(0, 1), turn(1, 1)] } };
  a.run('asyncOnMessage(m)');
  assert.deepEqual(plain(a.run('game.turns.map(t=>[t.by,t.round])')), [[0, 1], [1, 1]]);
});

function catBoardWords() {
  const st = state();
  st.tiles = [...'CAT' + 'E'.repeat(22)].map(char => ({ char, mult: null, gem: false }));
  return st;
}
