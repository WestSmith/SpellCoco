import test from 'node:test';
import assert from 'node:assert/strict';
import { client, state, room, plain } from './helpers.mjs';

// v74: turn replay — the per-turn log, its sanitizer, sync, and the viewer.
const online = 'NET.async=true;NET.mode="host";UI_MODE="host";NET.code="ROOM1";';
const code = (chars, extra = {}) => [...chars].map((ch, i) => ch + (extra[i] || '..')).join('');
const E25 = code('E'.repeat(25));
function catBoard() {
  const st = state();
  st.tiles = [...'CAT' + 'E'.repeat(22)].map(char => ({ char, mult: null, gem: false }));
  return st;
}
function playSwapThenWord(c) {
  c.run('game.pendingSwap=true;game.openSwapModal(0);game._swapModalAt=0;game.performSwap("B")');
  c.run('game.handleTileClick(0);game.handleTileClick(1);game.handleTileClick(2);game.submitWord()');
}

test('a finished turn is sealed with its start board, each step, and the board it left', () => {
  const c = client(); c.load(catBoard(), 'NET.mode="local";buildTrie(["BAT","CAT"]);');
  const start = c.run('boardCode(game.tiles)');
  assert.equal(start.slice(0, 9), 'C..A..T..');
  playSwapThenWord(c);
  const lt = plain(c.run('game.lastTurn'));
  assert.equal(lt.by, 0); assert.equal(lt.round, 1); assert.equal(lt.start, start);
  assert.deepEqual(lt.steps.map(s => s.k), ['swap', 'word']);
  assert.deepEqual({ ...lt.steps[0], b: undefined }, { k: 'swap', id: 0, from: 'C', to: 'B', b: undefined });
  assert.equal(lt.steps[0].b.slice(0, 9), 'B..A..T..');
  assert.deepEqual(lt.steps[1].ids, [0, 1, 2]); assert.equal(lt.steps[1].word, 'BAT');
  assert.equal(lt.end, c.run('boardCode(game.tiles)'));
  // the next turn's log starts fresh on the board it was dealt
  assert.deepEqual(plain(c.run('game.turnLog')), { by: 1, round: 1, start: lt.end, steps: [] });
  assert.deepEqual(plain(c.run('game.serialize().lastTurn')), lt);
  const btn = c.els.get('btn-replay');
  assert.equal(btn.classList.contains('hidden'), false);
  assert.equal(btn.textContent, "▶ Replay Keith's turn");
  assert.equal(btn.classList.contains('fresh'), false);                       // pass-and-play: both were at the board
});

test('shuffle, zoomies, hint, +15s and undo are logged in order', () => {
  const c = client(), st = catBoard(); st.players[0].gems = 20; st.cocoTimerActive = true; st.timeLeft = 20;
  c.load(st, 'NET.mode="local";buildTrie(["EE"]);');
  c.run('game.doHint();confirmShuffle();confirmZoomies();game.useAbility("time")');
  c.run('game.pendingSwap=true;game.openSwapModal(4);game._swapModalAt=0;game.performSwap("Q");game.applyUndoSwap("ok")');
  const steps = plain(c.run('game.turnLog.steps'));
  assert.deepEqual(steps.map(s => s.k), ['hint', 'shuffle', 'zoomies', 'time', 'swap', 'undo']);
  assert.equal(steps[5].from, 'Q'); assert.equal(steps[5].to, steps[4].from);
  assert.equal(steps[5].b, steps[2].b);                                       // undo puts the zoomies board back
});

test('a Coco Attack timeout leaves a step', () => {
  const c = client(), st = state(); st.cocoTimerActive = true; st.timeLeft = 1;
  c.load(st, 'NET.mode="local"');
  c.fire(c.run('game.timerInterval')); c.fireDelay(800);
  assert.deepEqual(plain(c.run('game.lastTurn.steps')), [{ k: 'timeout' }]);
});

test('logs are capped and always keep room for the word', () => {
  const c = client(); c.load(catBoard(), 'NET.mode="local";buildTrie(["CAT"]);');
  c.run('for(let i=0;i<60;i++)game.logStep({k:"hint"})');
  assert.equal(c.run('game.turnLog.steps.length'), 39);
  c.run('game.handleTileClick(0);game.handleTileClick(1);game.handleTileClick(2);game.submitWord()');
  assert.equal(c.run('game.lastTurn.steps.length'), 40);
  assert.equal(c.run('game.lastTurn.steps.at(-1).k'), 'word');
  assert.equal(plain(c.run('sanitizeNetState(game.serialize()).lastTurn')).steps.at(-1).k, 'word');
});

test('remote replay logs are rebuilt from validated pieces', () => {
  const c = client(), st = state();
  st.lastTurn = { by: 0, round: 3, start: E25, end: E25, extra: '<x>', steps: [
    { k: 'word', ids: [0, 1, 2], word: 'EEE', score: 3, gems: 0, b: E25 },
    { k: 'word', ids: [0, 1], word: '<img src=x>', score: 3, b: E25 },            // not a word
    { k: 'word', ids: [0, 0, 1], word: 'EEE', score: 3, b: E25 },                  // duplicate tile
    { k: 'swap', id: 99, from: 'E', to: 'Q', b: E25 },                             // off the board
    { k: 'swap', id: 3, from: '<', to: 'Q', b: E25, onclick: 'x' },
    { k: 'shuffle', b: 'E..'.repeat(24) }, { k: 'evil' }, null, 'hint',
    ...Array.from({ length: 50 }, () => ({ k: 'hint' }))] };
  st.tl = { by: 7, round: 1, start: E25, steps: [] };
  c.load(st);
  const lt = plain(c.run('game.lastTurn'));
  assert.deepEqual(lt.steps.slice(0, 3), [
    { k: 'word', ids: [0, 1, 2], word: 'EEE', score: 3, gems: 0, b: E25 },
    { k: 'swap', id: 3, from: 'E', to: 'Q', b: E25 }, { k: 'hint' }]);
  assert.ok(lt.steps.length <= 40); assert.equal(lt.extra, undefined);
  assert.equal(c.run('game.turnLog.by'), 0);                                   // the bad tl was replaced, not adopted
  for (const bad of [{ ...st.lastTurn, by: 2 }, { ...st.lastTurn, end: null }, { ...st.lastTurn, start: 'Q' }])
    assert.equal(c.run(`cleanTurnLog(${JSON.stringify(bad)},true)`), null);
});

test("online: the opponent's turn arrives with the state and the button glows until watched", () => {
  const c = client(), st = state(1);
  st.lastTurn = { by: 0, round: 1, start: E25, end: E25, steps: [{ k: 'word', ids: [0, 1], word: 'EE', score: 2, gems: 0, b: E25 }] };
  c.load(st, online + 'NET.myName="Shawn";NET.seat=1;NET.myIndex=1;');
  const btn = c.els.get('btn-replay');
  assert.equal(btn.textContent, "▶ Replay Keith's turn"); assert.equal(btn.classList.contains('fresh'), true);
  c.run('openReplay()');
  assert.equal(btn.classList.contains('fresh'), false);
  c.run('closeReplay()');
  // the next opponent turn (round 2) glows again; my own sealed turn never does
  c.ctx.next = { ...plain(c.run('game.serialize()')), round: 2, lastTurn: { ...st.lastTurn, round: 2 } };
  c.run('game.applyState(next)');
  assert.equal(btn.classList.contains('fresh'), true);
  c.ctx.next = { ...plain(c.run('game.serialize()')), lastTurn: { ...st.lastTurn, by: 1, round: 2 } };
  c.run('game.applyState(next)');
  assert.equal(btn.textContent, '▶ Replay your turn'); assert.equal(btn.classList.contains('fresh'), false);
});

test('a same-turn push (Coco Attack landing) keeps the log of the turn in progress', () => {
  const c = client(); c.load(catBoard(), online + 'NET.myName="Keith";NET.seat=0;NET.myIndex=0;');
  c.run('game.pendingSwap=true;game.openSwapModal(5);game._swapModalAt=0;game.performSwap("Z")');
  c.ctx.next = { ...plain(c.run('game.serialize()')), tl: null, cocoPendingFor: 0 };
  c.run('game.applyState(next)');
  assert.deepEqual(plain(c.run('game.turnLog.steps.map(s=>s.k)')), ['swap']);
  // a new turn from the room adopts the room's log for it
  const tl = { by: 1, round: 1, start: E25, steps: [{ k: 'hint' }] };
  c.ctx.next = { ...state(1), tl };
  c.run('game.applyState(next)');
  assert.deepEqual(plain(c.run('game.turnLog')), tl);
});

test('the replay viewer plays the turn on a copy of the board and steps over spelled letters', () => {
  const c = client(); c.load(catBoard(), 'NET.mode="local";buildTrie(["BAT","CAT"]);');
  playSwapThenWord(c);
  const live = c.run('boardCode(game.tiles)');
  c.run('openReplay()');
  assert.equal(c.els.get('modal-replay').classList.contains('hidden'), false);
  assert.equal(c.els.get('replay-heading').textContent, "Replay — Keith's turn");
  const grid = c.els.get('replay-grid'), cap = () => c.els.get('replay-caption').textContent;
  assert.equal(grid.children.length, 25);
  assert.equal(cap(), "Keith's turn starts on this board");
  assert.equal(grid.children[0].innerHTML.includes('<span>C</span>'), true);
  c.fire(c.run('REPLAY.timer'));                                              // autoplay → the swap
  assert.equal(cap(), '🔄 Keith swaps C → B');
  assert.equal(grid.children[0].classList.contains('replay-mark'), true);
  c.fire(c.run('REPLAY.timer'));                                              // the first letter of the path
  assert.equal(cap(), 'B…'); assert.equal(grid.children[0].classList.contains('selected'), true);
  c.run('replayStep(1)');                                                     // ▶ skips the letters
  assert.equal(cap(), '✨ BAT for ' + c.run('game.lastTurn.steps[1].score') + ' points');
  assert.equal(grid.children[0].classList.contains('path-tile'), true);
  assert.equal(grid.children[2].classList.contains('selected'), true);
  assert.equal(c.run('REPLAY.playing||REPLAY.timer!==null'), false);
  c.run('replayStep(-1)'); assert.equal(cap(), '🔄 Keith swaps C → B');
  c.run('closeReplay()');
  assert.equal(c.els.get('modal-replay').classList.contains('hidden'), true);
  assert.equal(c.run('boardCode(game.tiles)'), live);                        // the live board was never touched
});

test('the relay stores and forwards a state carrying a full replay log', async () => {
  const { r, sockets: [a, b], db } = room();
  const c = client(); c.load(catBoard(), 'NET.mode="local";buildTrie(["CAT"]);');
  c.run('for(let i=0;i<39;i++)game.logStep({k:"swap",id:0,from:"C",to:"C",b:boardCode(game.tiles)})');
  c.run('game.handleTileClick(0);game.handleTileClick(1);game.handleTileClick(2);game.submitWord()');
  const st = plain(c.run('game.serialize()'));
  st.turnIndex = 0;                                                           // the room still expects seat 0
  await r.onMove(a, { q: 1, state: st });
  assert.equal(a.messages.at(-1).op, 'moveok');
  assert.deepEqual(db.get('game').lastTurn, st.lastTurn);
  assert.deepEqual(b.messages.at(-1).state.lastTurn, st.lastTurn);
});
