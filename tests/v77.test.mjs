import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { client, state, plain } from './helpers.mjs';

// v77: undo swap is free; the replay no longer flashes a board nobody saw.
function catBoard(turnIndex = 0, round = 1) {
  const st = state(turnIndex, round);
  st.tiles = [...'CAT' + 'E'.repeat(22)].map(char => ({ char, mult: null, gem: false }));
  return st;
}
const submitCat = 'game.handleTileClick(0);game.handleTileClick(1);game.handleTileClick(2);game.submitWord()';
const mults = b => [...Array(25).keys()].map(i => b[i * 3 + 1]).join('');

test('a round-ending word on a bonus tile replays straight to the new round board', () => {
  const st = catBoard(1, 2); st.tiles[0].mult = '3W';                          // seat 1 closes round 2
  const c = client(); c.load(st, 'NET.mode="local";buildTrie(["CAT"]);');
  c.run(submitCat);
  const lt = plain(c.run('game.lastTurn')), mid = lt.steps.at(-1).b;
  assert.equal(c.run('game.round'), 3);
  assert.notEqual(mults(mid), mults(lt.end), 'the used 3W was re-placed, then the round re-rolled');
  c.run('openReplay()');
  const frames = plain(c.run('REPLAY.frames'));
  const word = frames.findIndex(f => f.cap.startsWith('✨'));
  assert.equal(frames.length, word + 2, 'one frame after the word, not two');
  const last = frames.at(-1);
  assert.equal(last.b, lt.end);
  assert.equal(last.cap, 'New letters drop into the gaps · ✦ New round — fresh bonus tiles');
  assert.deepEqual(last.fresh, [0, 1, 2]);
  assert.ok(!frames.some(f => f.b === mid && mid !== lt.end), 'the in-between board is never drawn');
});

test('a round-1 treat shift folds into the refill frame too', () => {
  const st = catBoard(0, 1); st.tiles[5].gem = true;
  const c = client(); c.load(st, 'NET.mode="local";buildTrie(["CAT"]);CONFIG.boardGemCount=6;');
  c.run(submitCat);
  const lt = plain(c.run('game.lastTurn'));
  c.run('openReplay()');
  const last = plain(c.run('REPLAY.frames.at(-1)'));
  assert.equal(last.b, lt.end);
  if (lt.steps.at(-1).b !== lt.end) assert.equal(last.cap, 'New letters drop into the gaps · The treats move to new tiles');
  assert.equal(plain(c.run('REPLAY.frames')).filter(f => f.cap.startsWith('New letters')).length, 1);
});

test('a turn with no word still shows the new round as its own step', () => {
  const st = catBoard(1, 2); st.cocoTimerActive = true; st.timeLeft = 1;
  const c = client(); c.load(st, 'NET.mode="local"');
  c.fire(c.run('game.timerInterval')); c.fireDelay(800);
  c.run('openReplay()');
  const caps = plain(c.run('REPLAY.frames')).map(f => f.cap);
  assert.equal(caps.at(-1), '✦ New round — fresh bonus tiles');
  assert.equal(caps.at(-2), '🐾 Time runs out on Shawn');
});

test('undo swap is free: every treat the swap cost comes back', () => {
  const st = catBoard(); st.players[0].gems = 10;
  const c = client(); c.load(st, 'NET.mode="local";CONFIG.maxGems=10;');
  c.run('game.pendingSwap=true;game.openSwapModal(0);game._swapModalAt=0;game.performSwap("B")');
  assert.equal(c.run('game.players[0].gems'), 7);
  const btn = c.els.get('btn-undo-swap');
  assert.equal(btn.classList.contains('hidden'), false);
  c.run('CONFIG.costs.swap=5');                                                // a later cost change can't skew the refund
  assert.equal(c.run('game.applyUndoSwap()'), true);
  assert.equal(c.run('game.players[0].gems'), 10);
  assert.equal(c.run('game.tiles[0].char'), 'C');
  assert.deepEqual(plain(c.run('game.players[0].abilityLog[1]')).gemsSpent, 0);
});

test('the undo button reads as free, not as a price', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="btn-undo-swap"[^>]*>↩ Undo Swap \(free\)</);
  assert.ok(!html.includes('modal-undoreq'), 'the Allow/Refuse dialog is gone');
});

const swapC = 'game.pendingSwap=true;game.openSwapModal(0);game._swapModalAt=0;game.performSwap("B")';

test('pass-and-play: undo is instant, with no Allow/Refuse step', () => {
  const c = client(); c.load(catBoard(), 'NET.mode="local"');
  c.run(swapC);
  c.run('game.requestUndoSwap()');
  assert.equal(c.run('game.tiles[0].char'), 'C');
  assert.equal(c.run('game.players[0].gems'), 8);
  assert.equal(c.run('game.lastSwap'), null);
  assert.equal(c.els.get('btn-undo-swap').classList.contains('hidden'), true);
});

test('online: undo applies at once, even with the opponent away, and the push carries it', () => {
  const c = client();
  c.load(catBoard(), 'NET.async=true;NET.mode="host";UI_MODE="host";NET.code="ROOM1";NET.myIndex=0;NET.oppPresent=false;');
  c.run(swapC);
  c.sent.length = 0;
  c.run('game.requestUndoSwap()');
  assert.equal(c.run('game.tiles[0].char'), 'C');
  assert.equal(c.run('game.players[0].gems'), 8);
  assert.ok(!c.sent.some(m => m.type === 'undoreq'), 'no consent request');
  assert.ok(c.sent.some(m => m.type === 'fx' && m.toast === '↩ Keith undid a letter swap'));
});

test('a v76 opponent asking for an undo gets an instant yes', () => {
  const c = client();
  c.load(catBoard(1), 'NET.async=true;NET.mode="host";UI_MODE="host";NET.code="ROOM1";NET.myIndex=0;');
  c.sent.length = 0;
  c.run('asyncOnData({type:"undoreq",from:"C",to:"B"})');
  assert.deepEqual(plain(c.sent.filter(m => m.type === 'undook')), [{ type: 'undook' }]);
});
