import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Exercise the shipped source, not copied implementations. All IO and clocks
// are deterministic doubles; these tests never contact rooms or external APIs.
const root = process.env.SPELLCOCO_TEST_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const worker = fs.readFileSync(path.join(root, 'worker/src/index.js'), 'utf8');
globalThis.WebSocketRequestResponsePair = class {};
const { Room } = await import('data:text/javascript;base64,' + Buffer.from(worker).toString('base64'));
export const copy = x => structuredClone(x);
export const plain = x => JSON.parse(JSON.stringify(x));
export async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
export function state(turnIndex = 0, round = 1) {
  return { round, turnIndex, startIndex: 0,
    players: ['Keith', 'Shawn'].map((name, id) => ({ id, name, score: 0, gems: 8, wordsPlayed: [], totalGems: 0, abilityLog: {} })),
    tiles: Array.from({ length: 25 }, () => ({ char: 'E', mult: null, gem: false })),
    sel: [], over: false, cocoPendingFor: null, cocoTimerActive: false, timeLeft: 0 };
}
export function socket(seat, name) {
  let attachment = { seat, name, last: Date.now() };
  return { readyState: 1, messages: [], deserializeAttachment: () => copy(attachment),
    serializeAttachment: x => { attachment = copy(x); },
    send(s) { this.messages.push(JSON.parse(s)); }, close() { this.readyState = 3; } };
}
export function room(initial = state()) {
  const db = new Map([['game', copy(initial)], ['config', { cocoAttackCost: 4, cocoAttackEnabled: true }],
    ['seats', [{ name: 'Keith', dev: 'a' }, { name: 'Shawn', dev: 'b' }]]]);
  const sockets = [socket(0, 'Keith'), socket(1, 'Shawn')];
  const storage = { async get(k) { return copy(db.get(k)); }, async put(k, v) { db.set(k, copy(v)); },
    async getAlarm() { return null; }, async setAlarm() {}, async deleteAll() { db.clear(); } };
  return { r: new Room({ storage, getWebSockets: () => sockets, setWebSocketAutoResponse() {} }, {}), db, sockets };
}

function element(tag, doc) {
  const classes = new Set(), attrs = new Map();
  const el = { tagName: String(tag || 'div').toUpperCase(), children: [], style: {}, dataset: {},
    checked: false, value: '', innerText: '', textContent: '', listeners: {},
    classList: { add(...x) { x.forEach(s => classes.add(s)); }, remove(...x) { x.forEach(s => classes.delete(s)); },
      contains(x) { return classes.has(x); }, toggle(x, on) { const add = on ?? !classes.has(x); add ? classes.add(x) : classes.delete(x); return add; } },
    appendChild(x) { if (typeof x === 'object') x.parentElement = this; this.children.push(x); return x; },
    append(...xs) { xs.forEach(x => this.appendChild(x)); }, remove() {},
    setAttribute(k, v) { attrs.set(k, String(v)); }, getAttribute(k) { return attrs.get(k) ?? null; }, removeAttribute(k) { attrs.delete(k); },
    addEventListener(k, f) { (this.listeners[k] ||= []).push(f); },
    contains(x) { return x === this || this.children.some(c => typeof c === 'object' && c.contains(x)); },
    closest(selector) { if (selector === '.tile' && classes.has('tile')) return this; return this.parentElement?.closest(selector) || null; },
    querySelectorAll(selector) {
      const matches = x => selector === 'button' ? x.tagName === 'BUTTON'
        : selector === '.tile' ? x.classList.contains('tile')
        : selector.startsWith('[data-id=') ? String(x.dataset.id) === selector.match(/"(\d+)"/)[1] : false;
      return this.children.flatMap(c => typeof c === 'object' ? [...(matches(c) ? [c] : []), ...c.querySelectorAll(selector)] : []);
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    focus() { doc.activeElement = this; }, getBoundingClientRect() { return { width: 400 }; }
  };
  Object.defineProperty(el, 'className', { get() { return [...classes].join(' '); }, set(v) { classes.clear(); v.split(/\s+/).forEach(c => classes.add(c)); } });
  let markup = '';
  Object.defineProperty(el, 'innerHTML', { get() { return markup; }, set(v) { markup = v; el.children = []; } });
  return el;
}
export function client(fetchImpl) {
  const els = new Map(), saved = new Map(), session = new Map(), timers = new Map(), events = {}, sent = [];
  let nextTimer = 1;
  const timer = (f, ms, repeat) => { const id = nextTimer++; timers.set(id, { f, ms, repeat }); return id; };
  const doc = { hidden: false, activeElement: null, createElement: tag => element(tag, doc), createTextNode: s => s,
    getElementById(id) { if (!els.has(id)) els.set(id, element('div', doc)); return els.get(id); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener(k, f) { (events['document:' + k] ||= []).push(f); } };
  doc.body = element('body', doc);
  const window = { innerWidth: 1000, innerHeight: 800, matchMedia() { return { matches: false, addEventListener() {} }; },
    addEventListener(k, f) { (events['window:' + k] ||= []).push(f); } };
  const storage = m => ({ getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) });
  const ctx = vm.createContext({ console, document: doc, window, navigator: { onLine: true },
    location: { origin: 'http://localhost', pathname: '/', search: '' },
    localStorage: storage(saved), sessionStorage: storage(session), URL, URLSearchParams, AbortController, Event, TextEncoder, Uint8Array,
    setTimeout: (f, ms) => timer(f, ms, false), clearTimeout: id => timers.delete(id),
    setInterval: (f, ms) => timer(f, ms, true), clearInterval: id => timers.delete(id), requestAnimationFrame: () => {},
    fetch: fetchImpl || (() => Promise.reject(new Error('Network disabled in tests'))), inputState: state() });
  const run = code => vm.runInContext(code, ctx);
  run(app); ctx.sent = sent;
  run('NET.send = m => sent.push(JSON.parse(JSON.stringify(m))); soundEnabled=false;');
  const fire = id => { const t = timers.get(id); if (!t) throw new Error('No timer ' + id); if (!t.repeat) timers.delete(id); t.f(); };
  const fireDelay = ms => { for (const [id, t] of [...timers]) if (t.ms === ms) fire(id); };
  return { ctx, run, els, saved, timers, events, sent, doc, fire, fireDelay,
    load(st = state(), setup = '') { ctx.inputState = copy(st); run(setup + ';game=Game.fromState(inputState);game.activate();'); },
    key(key, extra = {}) { const e = { target: doc.activeElement, key, preventDefault() { this.prevented = true; }, ...extra }; ctx.keyEvent = e; run('game.handleGridKey(keyEvent)'); return e; }
  };
}
