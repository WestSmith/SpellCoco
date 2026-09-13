import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Runs the repository's actual JavaScript with deterministic DOM, timer,
// WebSocket and Durable Object storage doubles. No production requests.
if (!process.argv[2]) throw new Error('Pass a checkout of v70 (106203a4) as the first argument.');
const repo = path.resolve(process.argv[2]);
const html = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
const app = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const workerPath = process.argv[3] ? path.resolve(process.argv[3]) : path.join(repo, 'worker/src/index.js');
const workerSource = fs.readFileSync(workerPath, 'utf8');
globalThis.WebSocketRequestResponsePair = class {};
const { Room } = await import('data:text/javascript;base64,' + Buffer.from(workerSource).toString('base64'));
const copy = x => structuredClone(x);
function state(turnIndex = 0, round = 1) {
  return { round, turnIndex, startIndex: 0, players: ['Keith', 'Shawn'].map((name, id) => ({ id, name, score: 0, gems: 8, wordsPlayed: [], totalGems: 0, abilityLog: {} })), tiles: Array.from({ length: 25 }, () => ({ char: 'E', mult: null, gem: false })), sel: [], over: false, cocoPendingFor: null, cocoTimerActive: false, timeLeft: 0 };
}
function socket(seat, name) {
  let attachment = { seat, name, last: Date.now() };
  return { readyState: 1, messages: [], deserializeAttachment: () => copy(attachment), serializeAttachment: x => { attachment = copy(x); }, send(s) { this.messages.push(JSON.parse(s)); }, close() { this.readyState = 3; } };
}
function room(initial = state()) {
  const db = new Map([['game', copy(initial)], ['config', { cocoAttackCost: 4, cocoAttackEnabled: true }], ['seats', [{ name: 'Keith', dev: 'a' }, { name: 'Shawn', dev: 'b' }]]]);
  const sockets = [socket(0, 'Keith'), socket(1, 'Shawn')];
  const storage = { async get(k) { return copy(db.get(k)); }, async put(k, v) { db.set(k, copy(v)); }, async getAlarm() { return null; }, async setAlarm() {}, async deleteAll() { db.clear(); } };
  return { r: new Room({ storage, getWebSockets: () => sockets, setWebSocketAutoResponse() {} }, {}), db, sockets };
}
function element() {
  const classes = new Set();
  return { children: [], style: {}, dataset: {}, checked: false, value: '', innerHTML: '', innerText: '', textContent: '', listeners: {},
    classList: { add(...x) { x.forEach(s => classes.add(s)); }, remove(...x) { x.forEach(s => classes.delete(s)); }, contains(x) { return classes.has(x); }, toggle(x, on) { const set = on ?? !classes.has(x); set ? classes.add(x) : classes.delete(x); return set; } },
    appendChild(x) { this.children.push(x); }, append() {}, remove() {}, setAttribute() {}, removeAttribute() {},
    addEventListener(k, f) { (this.listeners[k] ||= []).push(f); }, querySelector() { return null; }, querySelectorAll() { return []; }, getBoundingClientRect() { return { width: 400 }; }
  };
}
function client(fetchImpl) {
  const els = new Map(), saved = new Map(), session = new Map(), timers = new Map(), events = {}, sent = [];
  let nextTimer = 1;
  const timer = (f, ms, repeat) => { const id = nextTimer++; timers.set(id, { f, ms, repeat }); return id; };
  const doc = { body: element(), hidden: false, createElement: element, createTextNode: s => s,
    getElementById(id) { if (!els.has(id)) els.set(id, element()); return els.get(id); },
    querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener(k, f) { (events['document:' + k] ||= []).push(f); } };
  const window = { innerWidth: 1000, innerHeight: 800, matchMedia() { return { matches: false, addEventListener() {} }; }, addEventListener(k, f) { (events['window:' + k] ||= []).push(f); } };
  const storage = m => ({ getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) });
  const ctx = vm.createContext({ console, document: doc, window, navigator: { onLine: true }, location: { origin: 'http://localhost', pathname: '/', search: '' },
    localStorage: storage(saved), sessionStorage: storage(session), URL, URLSearchParams, AbortController, Event, TextEncoder, Uint8Array,
    setTimeout: (f, ms) => timer(f, ms, false), clearTimeout: id => timers.delete(id), setInterval: (f, ms) => timer(f, ms, true), clearInterval: id => timers.delete(id), requestAnimationFrame: () => {},
    fetch: fetchImpl || (() => Promise.reject(new Error('Network disabled in audit'))), inputState: state() });
  const run = code => vm.runInContext(code, ctx);
  run(app);
  ctx.sent = sent;
  run("NET.send = m => sent.push(JSON.parse(JSON.stringify(m))); soundEnabled=false;");
  return { ctx, run, els, saved, timers, events, sent };
}
let count = 0;
async function repro(name, fn) {
  const details = await fn(); count++;
  console.log(`REPRODUCED ${count}: ${name}\n  ${JSON.stringify(details)}`);
}

await repro('Retried move rolls back an opponent move once the turn cycles back', async () => {
  const { r, db, sockets: [a, b] } = room();
  const aMove = state(1); aMove.players[0].score = 12;
  await r.onMove(a, { q: 7, state: copy(aMove) });
  const bMove = copy(aMove); bMove.turnIndex = 0; bMove.round = 2; bMove.players[1].score = 20;
  await r.onMove(b, { q: 8, state: bMove });
  await r.onMove(a, { q: 7, state: copy(aMove) });
  assert.equal(db.get('game').round, 1); assert.equal(db.get('game').players[1].score, 0);
  return { roundBeforeReplay: 2, roundAfterReplay: db.get('game').round, opponentScoreBefore: 20, opponentScoreAfter: db.get('game').players[1].score, reply: a.messages.at(-1) };
});
await repro('In-flight selection snapshot erases a server Coco attack', async () => {
  const { r, db, sockets: [a, b] } = room(); const stale = copy(db.get('game'));
  await r.onCoco(b, { cost: 4 }); const afterAttack = copy(db.get('game'));
  stale.sel = [0]; await r.onMove(a, { q: 9, state: stale });
  assert.equal(afterAttack.cocoPendingFor, 0); assert.equal(db.get('game').cocoPendingFor, null);
  assert.equal(db.get('game').players[1].gems, 8);
  return { afterAttack: { pending: afterAttack.cocoPendingFor, gems: afterAttack.players[1].gems }, afterStaleSelection: { pending: db.get('game').cocoPendingFor, gems: db.get('game').players[1].gems } };
});
await repro('Server-only state messages can be forged through the side channel', async () => {
  const { r, db, sockets: [a, b] } = room(); const forged = state(1); forged.players[1].score = 99999;
  await r.onMessage(b, JSON.stringify({ type: '__a', op: 'state', state: forged }));
  assert.equal(a.messages.at(-1).state.players[1].score, 99999); assert.equal(db.get('game').players[1].score, 0);
  return { victimReceivedScore: a.messages.at(-1).state.players[1].score, storedScore: db.get('game').players[1].score };
});
await repro('fromState drops an active Coco countdown', () => {
  const c = client(); const st = state(); st.cocoTimerActive = true; st.timeLeft = 17; c.ctx.inputState = st;
  c.run('NET.async=true; NET.mode="host"; NET.myIndex=0; dictFileLoaded=true; trieBuilt=true; game=Game.fromState(inputState)');
  const result = c.run('({active:game.cocoTimerActive, seconds:game.timeLeft, interval:game.timerInterval})');
  assert.equal(result.active, false); assert.equal(result.interval, null); return result;
});
await repro('Pending offline Coco attack fails to arm when dictionary is already ready', () => {
  const c = client(); const st = state(); st.cocoPendingFor = 0; c.ctx.inputState = st;
  c.run('NET.async=true; NET.mode="host"; NET.myIndex=0; dictFileLoaded=true; trieBuilt=true; game=Game.fromState(inputState)');
  const result = c.run('({active:game.cocoTimerActive, pending:game.cocoPendingFor, interval:game.timerInterval, arming:!!game._cocoArming})');
  assert.equal(result.active, false); assert.equal(result.pending, 0); assert.equal(result.interval, null); assert.equal(result.arming, false); return result;
});
await repro('Cloud assist cannot be reached by the Submit button for an unknown word', () => {
  const c = client(); c.ctx.inputState.tiles[0].char = 'Z'; c.ctx.inputState.tiles[1].char = 'Z';
  c.run('buildTrie(["CAT"]); game=Game.fromState(inputState); game.selection=[0,1]; document.getElementById("cfg-cloud-assist").checked=true; game.updateUI()');
  const result = c.run('({word:game.calculateCurrentScore().word, valid:game.calculateCurrentScore().isValid, cloudAssist:cloudAssistOn(), submitDisabled:document.getElementById("btn-submit").disabled})');
  assert.equal(result.cloudAssist, true); assert.equal(result.valid, false); assert.equal(result.submitDisabled, true); return result;
});
await repro('Hung custom_words request leaves the full dictionary unindexed', async () => {
  const c = client(url => url === 'dictionary.txt' ? Promise.resolve({ ok: true, text: () => Promise.resolve('CAT\nAUDITWORD\n') }) : new Promise(() => {}));
  c.events['window:DOMContentLoaded'].forEach(f => f());
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const result = c.run('({dictionaryFileLoaded:dictFileLoaded, dictionaryHasWord:DICTIONARY.has("AUDITWORD"), trieHasWord:isValidWord("AUDITWORD")})');
  assert.equal(result.dictionaryFileLoaded, true); assert.equal(result.dictionaryHasWord, true); assert.equal(result.trieHasWord, false);
  const timeout = [...c.timers.values()].find(t => t.ms === 20000); timeout.f();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(c.run('isValidWord("AUDITWORD")'), false); return { ...result, recoveredAfter20sTimeout: false };
});
await repro('Rematch missed entirely while offline is not counted in statistics', () => {
  const c = client(); c.run('NET.async=true; NET.code="AUDITROOM"; STATS={games:0,draws:0,wins:{Keith:0,Shawn:0}}; recordStatsOnce([{name:"Keith",score:20,wordsPlayed:[]},{name:"Shawn",score:10,wordsPlayed:[]}]); recordStatsOnce([{name:"Shawn",score:30,wordsPlayed:[]},{name:"Keith",score:10,wordsPlayed:[]}])');
  const result = c.run('STATS'); assert.equal(result.games, 1); assert.equal(result.wins.Shawn, 0); return result;
});
await repro('Normal async welcome never sends local statistics', () => {
  const c = client(); c.run('NET.async=true; NET.mode="host"; UI_MODE="host"; NET.code="AUDITROOM"; NET.myName="Keith"; asyncWelcome({seat:0,names:["Keith","Shawn"],state:null,config:null})');
  assert.equal(c.sent.some(m => m.type === 'stats'), false); return { sentTypes: c.sent.map(m => m.type), statsSent: false };
});
await repro('Online move lost on refresh while disconnected has no durable client copy', () => {
  const c = client(); c.run('NET.async=true; NET.mode="host"; NET.myIndex=0; NET.code="AUDITROOM"; game=Game.fromState(inputState); game.turnIndex=1; game.players[0].score=30; NET.sendMove(game.serialize()); saveGameState()');
  assert.equal(c.run('NET.pendingMove.m.state.players[0].score'), 30); assert.equal(c.saved.has('spellcoco.save'), false);
  return { pendingMoveInMemory: true, persistentSaveExists: c.saved.has('spellcoco.save') };
});
await repro('Long guest name produces an identical automatic alternative', () => {
  const c = client(); const result = c.run('({name:"ABCDEFGHIJKLMN", alternative:openSeatName("ABCDEFGHIJKLMN")})');
  assert.equal(result.name, result.alternative); return result;
});
await repro('Room accepts game state that no client can load', async () => {
  const { r, db, sockets: [a] } = room(); const malformed = state(); malformed.players = [null, null];
  await r.onMove(a, { q: 100, state: malformed });
  const c = client(); c.ctx.inputState = db.get('game'); assert.equal(c.run('Game.fromState(inputState)'), null);
  return { workerReply: a.messages.at(-1), clientLoaded: false };
});
await repro('An imported contraction crashes the swap solver used on every valid submit', () => {
  const c = client(); c.ctx.inputState.tiles[0].char='C'; c.ctx.inputState.tiles[1].char='A'; c.ctx.inputState.tiles[2].char='N';
  c.run('processDictionaryText("CAT\\nCAN\'T"); buildTrie([...DICTIONARY]); game=Game.fromState(inputState)');
  let message;
  try { c.run('findBestWordWithSwap(game.tiles)'); } catch (e) { message=e.message; }
  assert.match(message || '', /val/); return { importedWord: "CAN'T", error: message };
});
console.log(`\n${count} defect scenarios reproduced; no network calls or repository changes.`);
