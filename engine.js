/* SpellCoco word engine — v73.
   The dictionary index and the board solvers, split out of index.html so they
   can be tested on their own and built off the main thread.

   The same file runs two ways:
   - as a classic <script> on the page, where it defines `WordEngine`;
   - as a Web Worker (new Worker('engine.js')), where it answers one message
     {text,max} by building the index and transferring its arrays back.

   The index is a first-child / next-sibling trie held in typed arrays: about
   6 MB for the 196k-word NWL list, where one JS object per node took ~84 MB.
   Node 0 is the root; 0 in `first`/`next` means "none" (the root is never a
   child). `flag` is a bit set: 1 = base dictionary word, 2 = added word
   (custom list, local custom words, words the opponent added). A word is
   valid while any bit is set. */
(function (root) {
  'use strict';
  const BASE = 1, EXTRA = 2;
  let uids = 0;   // every index gets its own id, so cached solver results never cross indexes

  class Trie {
    constructor(cap) {
      cap = Math.max(64, cap | 0);
      this.ch = new Uint8Array(cap); this.first = new Int32Array(cap);
      this.next = new Int32Array(cap); this.flag = new Uint8Array(cap);
      this.size = 1; this.words = 0; this.version = 0; this.uid = ++uids;
    }
    static fromData(d) {
      const t = new Trie(1);
      t.ch = d.ch; t.first = d.first; t.next = d.next; t.flag = d.flag;
      t.size = d.size; t.words = d.words;
      return t;
    }
    static fromWords(ws, bit) { const t = new Trie(4096); for (const w of ws) t.insert(w, bit || BASE); return t; }
    // Word lists are one word per line; only A–Z words of 2..max letters are
    // kept (the board has no other tiles). Case and surrounding space are ignored.
    static fromText(text, max) {
      const t = new Trie(1 << 19);
      const lines = String(text).split('\n');
      for (let i = 0; i < lines.length; i++) {
        const w = clean(lines[i], max || 25);
        if (w) t.insert(w, BASE);
      }
      return t;
    }
    grow() {
      const cap = this.ch.length * 2;
      const g = (A, a) => { const b = new A(cap); b.set(a); return b; };
      this.ch = g(Uint8Array, this.ch); this.first = g(Int32Array, this.first);
      this.next = g(Int32Array, this.next); this.flag = g(Uint8Array, this.flag);
    }
    child(n, c) { let k = this.first[n]; while (k && this.ch[k] !== c) k = this.next[k]; return k; }
    // The node a word ends on, or 0 when its path is missing / it isn't A–Z.
    find(w) {
      if (typeof w !== 'string') return 0;
      let n = 0;
      for (let i = 0; i < w.length; i++) {
        const c = w.charCodeAt(i) - 65;
        if (c < 0 || c > 25) return 0;
        n = this.child(n, c); if (!n) return 0;
      }
      return n;
    }
    insert(w, bit) {
      bit = bit || BASE;
      if (typeof w !== 'string' || w.length < 2) return false;
      for (let i = 0; i < w.length; i++) { const c = w.charCodeAt(i); if (c < 65 || c > 90) return false; }
      let n = 0;
      for (let i = 0; i < w.length; i++) {
        const c = w.charCodeAt(i) - 65;
        let k = this.first[n], prev = 0;
        while (k && this.ch[k] !== c) { prev = k; k = this.next[k]; }
        if (!k) {
          if (this.size === this.ch.length) this.grow();
          k = this.size++;
          this.ch[k] = c;
          if (prev) this.next[prev] = k; else this.first[n] = k;   // append: sorted input keeps siblings A→Z
        }
        n = k;
      }
      if (!this.flag[n]) this.words++;
      if ((this.flag[n] & bit) !== bit) { this.flag[n] |= bit; this.version++; }
      return true;
    }
    remove(w, bit) {
      const n = this.find(w);
      if (!n || !(this.flag[n] & bit)) return false;
      this.flag[n] &= ~bit; if (!this.flag[n]) this.words--;
      this.version++;
      return true;
    }
    // Drop one bit from every word (e.g. before re-adding the added-word set).
    clearBit(bit) {
      let words = 0;
      for (let k = 1; k < this.size; k++) { if (this.flag[k] & bit) this.flag[k] &= ~bit; if (this.flag[k]) words++; }
      this.words = words; this.version++;
    }
    hasWord(w) { const n = this.find(w); return !!n && this.flag[n] !== 0; }
    has(w, bit) { const n = this.find(w); return !!n && (this.flag[n] & bit) !== 0; }
    count(bit) { let c = 0; for (let k = 1; k < this.size; k++) if (this.flag[k] & bit) c++; return c; }
    // Trimmed copies of the arrays, for transfer out of a worker.
    data() {
      const s = this.size;
      return { ch: this.ch.slice(0, s), first: this.first.slice(0, s), next: this.next.slice(0, s), flag: this.flag.slice(0, s), size: s, words: this.words };
    }
  }

  function clean(line, max) {
    let a = 0, b = line.length;
    while (a < b && line.charCodeAt(a) <= 32) a++;
    while (b > a && line.charCodeAt(b - 1) <= 32) b--;
    const len = b - a;
    if (len < 2 || len > max) return null;
    let upper = true;
    for (let i = a; i < b; i++) {
      const c = line.charCodeAt(i);
      if (c >= 65 && c <= 90) continue;
      if (c >= 97 && c <= 122) { upper = false; continue; }
      return null;
    }
    const w = line.slice(a, b);
    return upper ? w : w.toUpperCase();
  }
  // Unique A–Z words of 2..max letters, in file order.
  function parseWordList(text, max) {
    max = max || 25;
    const out = [], seen = new Set();
    for (const line of String(text).split('\n')) {
      const w = clean(line, max);
      if (w && !seen.has(w)) { seen.add(w); out.push(w); }
    }
    return out;
  }

  const NEIGHBORS = (() => {
    const n = [];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
      const a = [];
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < 5 && cc >= 0 && cc < 5) a.push(rr * 5 + cc);
      }
      n.push(a);
    }
    return n;
  })();

  // One depth-first walk of the board against the trie, shared by every solver.
  //   tiles:  [{char, baseValue, multiplier}] ×25 (the Game's Tile objects)
  //   values: 26 letter values (index 0 = A), or null for a letter that can't be placed
  //   bonus:  long-word bonus by word length (array, index = length)
  //   swap:   also try replacing ONE tile with any letter (the Swap ability).
  //           The swapped tile scores at the new letter's value and keeps its
  //           DL/TL/2W/3W; ties prefer a result that needs no swap.
  //   collect: also return every word with its best-scoring path, ascending by score.
  // Returns {best, all}; best = {word, score, ids, swap} or null.
  function search(trie, tiles, values, bonus, swap, collect) {
    const ch = trie.ch, first = trie.first, next = trie.next, flag = trie.flag;
    const tc = new Int8Array(25), tv = new Int32Array(25), lm = new Int8Array(25), wm = new Int8Array(25);
    for (let i = 0; i < 25; i++) {
      const t = tiles[i], m = t.multiplier;
      tc[i] = t.char.charCodeAt(0) - 65; tv[i] = t.baseValue;
      lm[i] = m === 'DL' ? 2 : m === 'TL' ? 3 : 1;
      wm[i] = m === '2W' ? 2 : m === '3W' ? 3 : 1;
    }
    const visited = new Uint8Array(25), path = new Int8Array(25), pc = new Int8Array(25);
    const found = collect ? new Map() : null;
    let best = null, sw = null;   // sw: the active substitution {id,from,to}
    const word = len => { let s = ''; for (let k = 0; k < len; k++) s += String.fromCharCode(65 + pc[k]); return s; };
    const ids = len => Array.from(path.subarray(0, len));
    function take(i, k, val, len, sum, mult) {
      visited[i] = 1; path[len] = i; pc[len] = ch[k]; len++;
      sum += val * lm[i]; mult *= wm[i];
      if (flag[k] && len >= 2) {
        const sc = sum * mult + (bonus[len] || 0);
        if (!best || sc > best.score || (sc === best.score && best.swap && !sw))
          best = { word: word(len), score: sc, ids: ids(len), swap: sw ? { id: sw.id, from: sw.from, to: sw.to } : null };
        if (found) {
          const w = word(len), prev = found.get(w);
          if (!prev || sc > prev.score) found.set(w, { word: w, score: sc, ids: ids(len) });
        }
      }
      const nb = NEIGHBORS[i];
      for (let j = 0; j < nb.length; j++) if (!visited[nb[j]]) step(nb[j], k, len, sum, mult);
      visited[i] = 0;
    }
    function step(i, n, len, sum, mult) {
      const c = tc[i];
      let k = first[n];
      if (!swap || sw) {
        while (k && ch[k] !== c) k = next[k];
        if (k) take(i, k, tv[i], len, sum, mult);
        return;
      }
      for (; k; k = next[k]) {
        if (ch[k] === c) { take(i, k, tv[i], len, sum, mult); continue; }
        const v = values[ch[k]];
        if (v == null) continue;
        sw = { id: i, from: tiles[i].char, to: String.fromCharCode(65 + ch[k]) };
        take(i, k, v, len, sum, mult);
        sw = null;
      }
    }
    for (let i = 0; i < 25; i++) step(i, 0, 0, 0, 1);
    return { best, all: found ? [...found.values()].sort((a, b) => a.score - b.score) : null };
  }

  const api = { Trie, BASE, EXTRA, parseWordList, clean, NEIGHBORS, search };
  root.WordEngine = api;

  // Worker mode: build the index for the page and hand the arrays over.
  if (typeof WorkerGlobalScope !== 'undefined' && root instanceof WorkerGlobalScope) {
    root.onmessage = (e) => {
      const d = e.data || {};
      try {
        const t = Trie.fromText(d.text || '', d.max || 25);
        const out = t.data(); out.id = d.id;
        root.postMessage(out, [out.ch.buffer, out.first.buffer, out.next.buffer, out.flag.buffer]);
      } catch (err) { root.postMessage({ id: d.id, error: String(err && err.message || err) }); }
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
