import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { room, state, client, plain } from './helpers.mjs';

// v73: compact word engine, memoized solvers, selection-only sync, SW caching.
const root = process.env.SPELLCOCO_TEST_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineCtx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root, 'engine.js'), 'utf8'), engineCtx);
const E = engineCtx.WordEngine;
const board = (chars, mults = {}) => [...chars].map((char, id) => ({ id, char, baseValue: 1, multiplier: mults[id] || null }));
const flat = Array.from({ length: 26 }, () => 1), noBonus = Array(26).fill(0);

// ---- engine ----
test('engine: word lists keep only A–Z words of 2..max letters, case-insensitively', () => {
  const t = E.Trie.fromText(" cat \r\nCAN'T\nCAT\nice-cream\nA\nDog\n" + 'X'.repeat(26) + '\n', 25);
  assert.equal(t.words, 2);
  assert.equal(t.hasWord('CAT'), true); assert.equal(t.hasWord('DOG'), true);
  for (const w of ["CAN'T", 'ICECREAM', 'A', 'CA', 'CATS', 'cat', '', null]) assert.equal(t.hasWord(w), false, String(w));
  assert.deepEqual(plain(E.parseWordList('b\nAB\nab\nabc', 2)), ['AB']);
});

test('engine: added words can be removed or re-derived without touching base words', () => {
  const t = E.Trie.fromWords(['CAT', 'CATS']);
  assert.equal(t.insert('CATNIP', E.EXTRA), true); assert.equal(t.insert("CAN'T", E.EXTRA), false);
  t.insert('CAT', E.EXTRA);
  assert.equal(t.words, 3);
  assert.equal(t.remove('CAT', E.EXTRA), true); assert.equal(t.hasWord('CAT'), true);   // still a base word
  t.clearBit(E.EXTRA);
  assert.equal(t.hasWord('CATNIP'), false); assert.equal(t.words, 2);
  const v = t.version; t.insert('COCO', E.EXTRA); assert.ok(t.version > v);
});

test('engine: worker hand-off round-trips the index', () => {
  const t = E.Trie.fromText('CAT\nDOG\nDOGE', 25), c = E.Trie.fromData(t.data());
  assert.equal(c.words, 3); assert.equal(c.hasWord('DOGE'), true); assert.notEqual(c.uid, t.uid);
});

test('engine: search finds the best path, every word, and a strictly better swap', () => {
  const t = E.Trie.fromWords(['CAT', 'CAB', 'TAB', 'ZAT']);
  const tiles = board('CATXX' + 'BXXXX' + 'XXXXX' + 'XXXXX' + 'XXXXX', { 1: 'DL' });
  const r = E.search(t, tiles, flat, noBonus, false, true);
  assert.equal(r.best.word, 'CAT'); assert.equal(r.best.score, 4); assert.equal(r.best.swap, null);   // C·A(DL)·T
  assert.deepEqual(plain(r.best.ids), [0, 1, 2]);
  assert.deepEqual(plain(r.all.map(w => w.word).sort()), ['CAB', 'CAT', 'TAB']);
  const vals = flat.slice(); vals[25] = 10;                                    // Z is worth 10
  const s = E.search(t, tiles, vals, noBonus, true, false).best;
  assert.equal(s.word, 'ZAT'); assert.equal(s.score, 13); assert.deepEqual(plain(s.swap), { id: 0, from: 'C', to: 'Z' });
  const tie = E.search(t, tiles, flat, noBonus, true, false).best;             // ZAT would also score 4: no swap wins
  assert.equal(tie.swap, null);
});

// ---- page: dictionary + solvers ----
test('removing a custom word drops just that word, without a rebuild', () => {
  const c = client(); c.load();
  c.run('buildTrie(["CAT"]);addCustomWord("COCOA");mergeRemoteWords(["ZAX"])');
  assert.equal(c.run('isValidWord("COCOA")&&isValidWord("ZAX")'), true);
  const timers = c.timers.size;
  c.run('removeCustomWord("COCOA")');
  assert.equal(c.timers.size, timers);
  assert.equal(c.run('isValidWord("COCOA")'), false); assert.equal(c.run('isValidWord("ZAX")&&isValidWord("CAT")'), true);
});

test('a new full list keeps words added while it was indexing', () => {
  const c = client(); c.load();
  c.run('processDictionaryText("DOG\\nCAT");addCustomWord("COCOA");mergeRemoteWords(["ZAX"])');
  c.fireDelay(50);
  assert.equal(c.run('dictFileLoaded&&isValidWord("DOG")&&isValidWord("COCOA")&&isValidWord("ZAX")'), true);
  assert.equal(c.run('baseWordCount'), 2);
});

test('the board is solved once per board and dictionary; a changed board or word list re-solves', () => {
  const c = client(); c.load();
  c.run('buildTrie(["EE","EEE"]);globalThis.calls=0;const s=WordEngine.search;WordEngine.search=(...a)=>{calls++;return s(...a)}');
  c.run('findBestWord(game.tiles);findWordCandidates(game.tiles);findBestWord(game.tiles)');
  assert.equal(c.run('calls'), 1);
  c.run('findBestWordWithSwap(game.tiles);findBestWordWithSwap(game.tiles)');
  assert.equal(c.run('calls'), 2);
  c.run('addCustomWord("EEEE");findBestWord(game.tiles)');
  assert.equal(c.run('calls'), 3); assert.equal(c.run('findBestWord(game.tiles).word'), 'EEEE');
  c.run('game.tiles[0].multiplier="3W";findBestWord(game.tiles)');
  assert.equal(c.run('calls'), 4);
  c.run('findBestWord(game.tiles).ids.push(99)');                              // callers get copies
  assert.equal(c.run('findBestWord(game.tiles).ids.includes(99)'), false);
});

test('board changes prewarm the solver in idle time once the full list is ready', () => {
  const c = client(); c.load(state(), 'buildTrie(["EE"]);dictFileLoaded=true');
  c.run('game.updateUI()');
  const warm = [...c.timers.entries()].filter(([, t]) => t.ms === 400);
  assert.equal(warm.length, 1);
  c.fire(warm[0][0]);
  assert.equal(c.run('_solve.swap!==null&&_solve.plain!==null'), true);
});

// ---- page: selection-only sync ----
const online = 'NET.async=true;NET.mode="host";UI_MODE="host";NET.code="ROOM1";NET.myName="Keith";NET.seat=0;NET.myIndex=0;';

test('with a livesel relay, spelling sends tiny previews and no full states', () => {
  const c = client(); c.load(state(), online + 'NET.caps={livesel:true};');
  c.sent.length = 0;
  c.run('game.handleTileClick(0);game.handleTileClick(1);game.handleTileClick(1);game.clearSelection()');
  assert.deepEqual(plain(c.sent), [
    { type: 'livesel', ids: [0], r: 1, t: 0 }, { type: 'livesel', ids: [0, 1], r: 1, t: 0 },
    { type: 'livesel', ids: [0], r: 1, t: 0 }, { type: 'livesel', ids: [], r: 1, t: 0 }]);
  c.run('game.updateUI()');                                                    // a real change still pushes the board
  assert.equal(c.sent.at(-1).op, 'move');
});

test('without the capability (an older relay) selections still push full states', () => {
  const c = client(); c.load(state(), online);
  c.sent.length = 0; c.run('game.handleTileClick(3)');
  assert.equal(c.sent.length, 1); assert.equal(c.sent[0].op, 'move'); assert.deepEqual(plain(c.sent[0].state.sel), [3]);
});

test('the welcome decides the capability', () => {
  const c = client();
  c.run(online + 'asyncWelcome({seat:0,names:["Keith","Shawn"],state:null,config:null,rev:0,caps:["livesel"]})');
  assert.equal(c.run('NET.caps.livesel'), true);
  c.run('asyncWelcome({seat:0,names:["Keith","Shawn"],state:null,config:null,rev:0})');
  assert.equal(c.run('NET.caps'), null);
  c.run('NET.caps={livesel:true};NET.cleanup()'); assert.equal(c.run('NET.caps'), null);
});

test('local games do not save on every letter', () => {
  const c = client(); c.load(state(), 'NET.mode="local"');
  c.run('game.updateUI()'); const saved = c.saved.get('spellcoco.save');
  c.run('game.handleTileClick(0);game.handleTileClick(1)');
  assert.equal(c.saved.get('spellcoco.save'), saved);
});

test('the watcher shows the opponent\'s live selection only for the current turn', () => {
  const c = client(); c.load(state(1), online);
  c.sent.length = 0;
  c.run('asyncOnData({type:"livesel",ids:[2,3],r:1,t:1})');
  assert.deepEqual(plain(c.run('game.selection')), [2, 3]); assert.equal(c.sent.length, 0);
  for (const bad of ['{type:"livesel",ids:[4],r:2,t:1}', '{type:"livesel",ids:[4],r:1,t:0}', '{type:"livesel",ids:"x",r:1,t:1}']) c.run(`asyncOnData(${bad})`);
  assert.deepEqual(plain(c.run('game.selection')), []);                         // the malformed one clears; the stale ones are ignored
  c.load(state(0), online);                                                    // our own turn: never overwritten by the wire
  c.run('game.handleTileClick(0);asyncOnData({type:"livesel",ids:[9],r:1,t:0})');
  assert.deepEqual(plain(c.run('game.selection')), [0]);
});

test('a same-turn state push (Coco Attack) keeps the word being spelled', () => {
  const c = client(); c.load(state(), online + 'NET.caps={livesel:true};');
  c.run('game.handleTileClick(0);game.handleTileClick(1)');
  const atk = state(); atk.cocoPendingFor = 0; atk.players[1].gems = 4; c.ctx.atk = atk;
  c.run('asyncOnMessage({op:"state",state:atk,rev:2})');
  assert.equal(c.run('game.cocoPendingFor'), 0);
  assert.deepEqual(plain(c.run('game.selection')), [0, 1]);
  const next = state(1); c.ctx.next = next;                                    // a turn change still resets it
  c.run('asyncOnMessage({op:"state",state:next,rev:3})');
  assert.deepEqual(plain(c.run('game.selection')), []);
});

test('selection repaints rebuild only the tiles that changed', () => {
  const c = client(); c.load(state(), 'NET.mode="local"');
  const grid = c.els.get('grid'), before = [...grid.children];
  c.run('game.handleTileClick(0)');
  const after = [...grid.children];
  assert.equal(after.length, 25);
  assert.notEqual(after[0], before[0]);
  assert.equal(after.slice(1).every((el, i) => el === before[i + 1]), true);
  c.run('game.handleTileClick(1)');                                            // tile 0 turns from "last" to "path"
  assert.notEqual(grid.children[0], after[0]); assert.equal(grid.children[2], after[2]);
});

// ---- relay ----
test('relay: welcome advertises livesel; valid previews relay unstored, bad ones drop', async () => {
  const { r, sockets: [a, b], db } = room();
  await r.onHello(a, { name: 'Keith', dev: 'a' });
  assert.deepEqual(a.messages.at(-1).caps, ['livesel']);
  const before = JSON.stringify([...db.entries()]); b.messages.length = 0;
  await r.onMessage(a, JSON.stringify({ type: 'livesel', ids: [0, 6, 12], r: 1, t: 0, extra: 'x' }));
  assert.deepEqual(b.messages, [{ type: 'livesel', ids: [0, 6, 12], r: 1, t: 0 }]);
  assert.equal(JSON.stringify([...db.entries()]), before);                   // nothing stored, no revision bump
  b.messages.length = 0;
  for (const m of [{ ids: [25], r: 1, t: 0 }, { ids: [1, 1], r: 1, t: 0 }, { ids: [1], r: 1, t: 2 }, { ids: '1', r: 1, t: 0 },
    { ids: Array.from({ length: 26 }, (_, i) => i % 25), r: 1, t: 0 }, { ids: [1], r: -1, t: 0 }])
    await r.onMessage(a, JSON.stringify({ type: 'livesel', ...m }));
  assert.deepEqual(b.messages, []);
});

// ---- service worker ----
function sw(network) {
  const store = new Map(), listeners = {};
  const caches = {
    async open() { return { put: async (k, res) => { store.set(k, res); }, keys: async () => [...store.keys()].map(url => ({ url })), delete: async r => store.delete(r.url) }; },
    async match(k) { return store.get(typeof k === 'string' ? k : k.url); },
    async keys() { return ['spellcoco-rt-1', 'spellcoco-old']; }, async delete() { return true; }
  };
  const self = { location: { href: 'https://x.test/SpellCoco/sw.js', origin: 'https://x.test' }, addEventListener: (k, f) => { listeners[k] = f; }, skipWaiting() {}, clients: { claim: async () => {} }, registration: {} };
  const Response = { error: () => ({ error: true }) };
  vm.runInContext(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), vm.createContext({ self, caches, fetch: network, URL, Response, clients: {}, Promise }));
  async function get(url, mode = 'cors') {
    let reply, waits = [];
    const e = { request: { url, method: 'GET', mode, headers: { has: () => false } }, respondWith(p) { reply = p; }, waitUntil(p) { waits.push(p); } };
    listeners.fetch(e);
    const out = reply ? await reply : undefined;
    for (let i = 0; i < waits.length; i++) await waits[i];
    return out;
  }
  return { get, store };
}

test('service worker: dictionary is served from cache and refreshed behind', async () => {
  let n = 0; const s = sw(async () => ({ ok: true, type: 'basic', body: 'v' + (++n), clone() { return this; } }));
  const url = 'https://x.test/SpellCoco/dictionary.txt';
  assert.equal((await s.get(url)).body, 'v1');
  assert.equal((await s.get(url)).body, 'v1');                                // cached answer; v2 fetched behind it
  assert.equal((await s.get(url)).body, 'v2');
});

test('service worker: other files are network-first with an offline fallback; foreign hosts untouched', async () => {
  let online = true; const s = sw(async req => { if (!online) throw new Error('offline'); return { ok: true, type: 'basic', body: req.url, clone() { return this; } }; });
  assert.equal((await s.get('https://x.test/SpellCoco/?join=AB12', 'navigate')).body, 'https://x.test/SpellCoco/?join=AB12');
  await s.get('https://x.test/SpellCoco/engine.js?v=v72'); await s.get('https://x.test/SpellCoco/engine.js?v=v73');
  assert.deepEqual([...s.store.keys()].sort(), ['https://x.test/SpellCoco/', 'https://x.test/SpellCoco/engine.js?v=v73']);
  online = false;
  assert.equal((await s.get('https://x.test/SpellCoco/?join=ZZ99', 'navigate')).body, 'https://x.test/SpellCoco/?join=AB12');
  assert.equal((await s.get('https://x.test/SpellCoco/index.html', 'navigate')).body, 'https://x.test/SpellCoco/?join=AB12');
  assert.deepEqual(await s.get('https://x.test/SpellCoco/icon-192.png'), { error: true });
  assert.equal(await s.get('https://spellcoco-async.spellcoco.workers.dev/health'), undefined);
});
