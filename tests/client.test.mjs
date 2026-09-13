import test from 'node:test';
import assert from 'node:assert/strict';
import { client, state, plain, flush } from './helpers.mjs';

test('an active countdown restores its remaining seconds and starts exactly one interval', () => {
  const c = client(), st = state(); st.cocoTimerActive = true; st.timeLeft = 17;
  c.load(st, 'NET.async=true;NET.mode="host";NET.myIndex=0;dictFileLoaded=true;trieBuilt=true');
  assert.equal(c.run('game.cocoTimerActive'), true);
  assert.equal(c.run('game.timeLeft'), 17);
  const interval = c.run('game.timerInterval');
  c.run('game.activate()');
  assert.equal(c.run('game.timerInterval'), interval);
  c.fire(interval);
  assert.equal(c.run('game.timeLeft'), 16);
  assert.equal(c.sent.at(-1).state.timeLeft, 16);
});

for (const [name, setup, runs] of [
  ['local save', 'NET.mode="local"', true],
  ['legacy host', 'NET.mode="host";NET.myIndex=1', true],
  ['legacy guest', 'NET.mode="join";NET.myIndex=0', false],
  ['async observer', 'NET.async=true;NET.mode="host";NET.myIndex=1', false]
]) test('timer authority: ' + name, () => {
  const c = client(), st = state(); st.cocoTimerActive = true; st.timeLeft = 17;
  c.load(st, setup);
  assert.equal(c.run('game.cocoTimerActive'), true);
  assert.equal(!!c.run('game.timerInterval'), runs);
});

test('zero remaining seconds expires without granting another full countdown', () => {
  const c = client(), st = state(); st.cocoTimerActive = true;
  c.load(st);
  assert.equal(c.run('game.timeLeft'), 0);
  assert.equal(c.run('game.timerInterval'), null);
  assert.equal(c.run('game.cocoTimerActive'), false);
  c.fire(c.run('game._expireTimer'));
  assert.equal(c.run('game.turnIndex'), 1);
  assert.equal(c.run('game._expireTimer'), null);
});

test('local ticking persists the latest remaining seconds for a real save/resume', () => {
  const c = client(), st = state(); st.cocoTimerActive = true; st.timeLeft = 17;
  c.load(st); c.fire(c.run('game.timerInterval'));
  assert.equal(JSON.parse(c.saved.get('spellcoco.save')).state.timeLeft, 16);
  c.run('resumeSavedGame()');
  assert.equal(c.run('game.timeLeft'), 16);
  assert.ok(c.run('game.timerInterval'));
});

test('asyncLoadGame installs the seat before arming a pending attack', () => {
  const c = client(); c.ctx.inputState = state(1); c.ctx.inputState.cocoPendingFor = 1;
  c.run('NET.async=true;NET.mode="host";NET.seat=1;NET.myIndex=-1;NET.code="TEST";dictFileLoaded=true;trieBuilt=true;asyncLoadGame(inputState,CONFIG)');
  assert.equal(c.run('NET.myIndex'), 1);
  assert.equal(c.run('game.cocoTimerActive'), true);
});

test('authoritative turn changes and finished states cancel the old countdown and expiry callback', () => {
  const c = client(), st = state(); st.cocoTimerActive = true; st.timeLeft = 1;
  c.load(st); c.fire(c.run('game.timerInterval'));
  const expiry = c.run('game._expireTimer'); assert.ok(c.timers.has(expiry));
  c.ctx.nextState = state(1); c.run('game.applyState(nextState)');
  assert.equal(c.timers.has(expiry), false);
  assert.equal(c.run('game.timerInterval'), null);
  c.load(st); const timer = c.run('game.timerInterval');
  c.ctx.nextState = {...state(), over:true}; c.run('game.applyState(nextState)');
  assert.equal(c.timers.has(timer), false);
});

for (const warm of [true, false]) test(`pending attack arms after installation with ${warm ? 'warm' : 'cold'} dictionary`, () => {
  const c = client(), st = state(); st.cocoPendingFor = 0;
  c.load(st, `NET.async=true;NET.mode="host";NET.myIndex=0;dictFileLoaded=${warm};trieBuilt=${warm}`);
  if (!warm) {
    assert.equal(c.run('game.cocoTimerActive'), false);
    c.run('dictFileLoaded=true;trieBuilt=true'); c.fireDelay(300);
  }
  assert.equal(c.run('game.cocoTimerActive'), true);
  assert.equal(c.run('game.cocoPendingFor'), null);
  assert.equal(c.run('game.timeLeft'), c.run('CONFIG.cocoAttackTime'));
  assert.ok(c.run('game.timerInterval'));
});

test('retired games cannot arm a pending attack', () => {
  const c = client(), st = state(); st.cocoPendingFor = 0;
  c.load(st, 'NET.async=true;NET.myIndex=0');
  c.run('globalThis.oldGame=game;game=Game.fromState({...inputState,cocoPendingFor:null});dictFileLoaded=true;trieBuilt=true');
  c.fireDelay(300); c.run('oldGame.activate()');
  assert.equal(c.run('oldGame.cocoTimerActive'), false);
});

test('restored solo games schedule Coco once after installation', () => {
  const c = client(), st = state(); st.players[0].isCoco = true;
  c.load(st, 'CONFIG.solo={active:true,mood:"cozy"}'); c.run('game.activate()');
  assert.equal(c.run('game.cocoPending'), true);
  assert.equal([...c.timers.values()].filter(t => t.ms === 2100).length, 1);
});

test('hung optional custom words time out, then the full dictionary becomes playable', async () => {
  const c = client(url => url === 'dictionary.txt' ? Promise.resolve({ ok: true, text: async () => 'CAT\nAUDITWORD\n' }) : new Promise(() => {}));
  c.events['window:DOMContentLoaded'].forEach(f => f()); await flush();
  assert.equal(c.run('dictFileLoaded'), false);
  c.fireDelay(20000); await flush(); c.fireDelay(50);
  assert.equal(c.run('dictFileLoaded&&trieBuilt&&isValidWord("AUDITWORD")'), true);
});

test('timeouts include response body reads and preserve locally added words', async () => {
  const c = client(() => Promise.resolve({ ok: true, text: () => new Promise(() => {}) }));
  c.run('localCustomWords=["AUDITWORD"]');
  c.events['window:DOMContentLoaded'].forEach(f => f()); await flush();
  c.fireDelay(20000); await flush(); c.fireDelay(50);
  assert.equal(c.run('dictFileLoaded'), false);
  assert.equal(c.run('trieBuilt&&isValidWord("AUDITWORD")'), true);
});

test('healthy word-list downloads rebuild once and report readiness only after indexing', async () => {
  const c = client(url => Promise.resolve({ ok: true, text: async () => url === 'dictionary.txt' ? 'CAT\nDOG' : 'COCO' }));
  c.events['window:DOMContentLoaded'].forEach(f => f()); await flush();
  assert.equal(c.run('dictFileLoaded'), false);
  assert.equal([...c.timers.values()].filter(t => t.ms === 50).length, 1);
  c.fireDelay(50);
  assert.equal(c.run('dictFileLoaded&&isValidWord("CAT")&&isValidWord("COCO")'), true);
});

test('dictionary imports filter contractions and invalid entries before indexing and solving', () => {
  const c = client(); c.load();
  c.ctx.words = " cat \nCAN'T\nCAT\nICE-CREAM\nA\n" + 'X'.repeat(26);
  c.run('processDictionaryText(words)');
  assert.equal(c.run('dictFileLoaded'), false);
  c.fireDelay(50);
  assert.deepEqual(plain(c.run('[...DICTIONARY].filter(w=>w!=="CAT")')), []);
  assert.equal(c.run('dictFileLoaded&&isValidWord("CAT")'), true);
  c.run('game.tiles[0].char="C";game.tiles[1].char="A";game.tiles[2].char="N"');
  assert.doesNotThrow(() => c.run('findBestWordWithSwap(game.tiles)'));
  assert.equal(c.run('processDictionaryText("---")'), false);
  assert.equal(c.run('isValidWord("CAT")'), true);
});

test('swap solver defensively ignores unsupported trie children', () => {
  const c = client(); c.load();
  c.run('buildTrie(["CAN\'T","CAT"]);game.tiles[0].char="C";game.tiles[1].char="A";game.tiles[2].char="N"');
  assert.doesNotThrow(() => c.run('findBestWordWithSwap(game.tiles)'));
});

function cloudClient(fetcher) {
  const c = client(fetcher), st = state(); st.tiles[0].char = 'Z'; st.tiles[1].char = 'Z';
  c.load(st, 'buildTrie(["CAT"]);document.getElementById("cfg-cloud-assist").checked=true');
  c.run('game.handleTileClick(0);game.handleTileClick(1)');
  return c;
}
test('unknown words can reach cloud assist only when enabled, online and on the player turn', () => {
  const c = cloudClient();
  assert.equal(c.els.get('btn-submit').disabled, false);
  for (const setup of ['navigator.onLine=false', 'navigator.onLine=true;document.getElementById("cfg-cloud-assist").checked=false',
    'document.getElementById("cfg-cloud-assist").checked=true;NET.mode="join";NET.myIndex=1']) {
    c.run(setup + ';game.updateUI()'); assert.equal(c.els.get('btn-submit').disabled, true);
  }
});

test('a successful cloud lookup submits exactly once and clears pending UI', async () => {
  let resolve, calls = 0;
  const c = cloudClient(() => { calls++; return new Promise(r => { resolve = r; }); });
  c.run('game.submitWord();game.submitWord()');
  assert.equal(calls, 1); assert.equal(c.els.get('btn-submit').disabled, true);
  resolve({ ok: true }); await flush();
  assert.equal(c.run('game.players[0].wordsPlayed.length'), 1);
  assert.equal(c.run('game.players[0].wordsPlayed[0].word'), 'ZZ');
  assert.equal(c.run('game.turnIndex'), 1);
  assert.equal(c.run('game.cloudPending'), false);
  assert.equal(c.els.get('btn-submit').innerText, 'Submit');
});

for (const [name, change] of [
  ['selection', 'game.clearSelection()'], ['turn', 'game.endTurn()'],
  ['game', 'game=Game.fromState(inputState)']
]) test('a cloud response cannot submit after the ' + name + ' changes', async () => {
  let resolve;
  const c = cloudClient(() => new Promise(r => { resolve = r; }));
  c.run('game.submitWord();' + change);
  resolve({ ok: true }); await flush();
  assert.equal(c.run('game.players.reduce((n,p)=>n+p.wordsPlayed.length,0)'), 0);
  assert.equal(c.run('isValidWord("ZZ")'), false);
});

test('cloud lookup errors release the pending Submit button', async () => {
  const c = cloudClient(() => Promise.reject(new Error('offline')));
  c.run('game.submitWord()'); await flush();
  assert.equal(c.run('game.cloudPending'), false);
  assert.equal(c.els.get('btn-submit').disabled, false);
});

test('keyboard selection, navigation, deletion and clear retain a single focused board button', () => {
  const c = client(); c.load(); c.run('game.focusTile(0)');
  const buttons = () => c.els.get('grid').children;
  assert.equal(buttons().length, 25);
  assert.equal(buttons().every(b => b.tagName === 'BUTTON' && b.type === 'button'), true);
  assert.equal(buttons().filter(b => b.tabIndex === 0).length, 1);
  assert.equal(c.key('Enter').prevented, true);
  assert.deepEqual(plain(c.run('game.selection')), [0]);
  assert.equal(c.doc.activeElement.getAttribute('aria-pressed'), 'true');
  c.key('ArrowRight'); c.key(' ');
  assert.deepEqual(plain(c.run('game.selection')), [0, 1]);
  assert.equal(Number(c.doc.activeElement.dataset.id), 1);
  c.key('Backspace'); assert.deepEqual(plain(c.run('game.selection')), [0]);
  c.key('Escape'); assert.deepEqual(plain(c.run('game.selection')), []);
  c.key('End'); c.key('ArrowRight'); assert.equal(Number(c.doc.activeElement.dataset.id), 4);
  c.key('ArrowDown'); c.key('Home'); assert.equal(Number(c.doc.activeElement.dataset.id), 5);
  assert.equal(buttons().filter(b => b.tabIndex === 0).length, 1);
});

test('keyboard input respects turn ownership and ignores key-repeat activation', () => {
  const c = client(); c.load(); c.run('game.focusTile(0)');
  c.key('Enter', { repeat: true }); assert.equal(c.run('game.selection.length'), 0);
  c.run('NET.mode="join";NET.myIndex=1');
  c.key('Enter'); assert.equal(c.run('game.selection.length'), 0);
});

test('pointer-generated click is not handled a second time; assistive click can activate', () => {
  const c = client(); c.load();
  const grid = c.els.get('grid');
  for (const f of grid.listeners.click) f({ target: grid.children[0], detail: 1 });
  assert.equal(c.run('game.selection.length'), 0);
  for (const f of grid.listeners.click) f({ target: grid.children[0], detail: 0 });
  assert.deepEqual(plain(c.run('game.selection')), [0]);
});

test('swap letter buttons receive focus and restore board focus after selecting', () => {
  const c = client(); c.load(); c.run('game.pendingSwap=true;game.openSwapModal(0)');
  const choices = c.els.get('swap-options').children;
  assert.equal(choices.length, 26); assert.equal(c.doc.activeElement, choices[0]);
  assert.equal(choices.every(b => b.tagName === 'BUTTON'), true);
  c.run('game._swapModalAt=0;game.performSwap("A")');
  assert.equal(c.run('game.tiles[0].char'), 'A');
  assert.equal(c.run('game.players[0].gems'), 5);
  assert.equal(Number(c.doc.activeElement.dataset.id), 0);
});

test('automatic seat names remain distinct at the maximum length, including an existing suffix', () => {
  const c = client();
  for (const name of ['ABCDEFGHIJKLMN', 'ABCDEFGHIJKL 2', 'ABCDEFGHIJKL 3', 'Keith', 'Shawn', 'Guest']) {
    c.ctx.name = name; const alternative = c.run('openSeatName(name)');
    assert.notEqual(alternative, name); assert.ok(alternative.length <= 14);
  }
});
