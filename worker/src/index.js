// SpellCoco async relay — Cloudflare Worker + one Durable Object per room.
//
// v69 (2026-09-12): hardening + hibernation.
//   - WebSocket Hibernation API: the room no longer stays resident (and billed)
//     while idle sockets sit open. The client's 20s ping is answered by the
//     runtime's auto-response without waking the object.
//   - newgame requires a seat (a seatless/peek socket could wipe a live game).
//   - states are validated (object, 2 players, 25 tiles, <=512 KB) before
//     they're stored; storage errors answer with a reject instead of silence.
//   - Coco Attack cost/enabled come from the stored config, and the attacker
//     must be the non-active seat.
//   - only seated players may relay side-channel messages (stats, customs, fx).
//     v71: and only the allow-listed async side messages (customs, stats, side,
//     fx, wordreq/wordok/wordno/addword, undoreq/undook/undono). The dormant
//     host-authoritative relay protocol (start/state/timer/act/sel/gameover as
//     plain `type`) is NOT relayed any more — it is unreachable while the client
//     hard-codes useAsync=true, and re-opening it would re-open the forgery hole.
//   - newgame is acked with moveok {q} like a move.
//   - rooms idle for 90 days are wiped by an alarm.
//
// v71 (2026-09-13): revisions. Every accepted write bumps a room-wide `rev`,
//   and the room remembers, per seat, the newest rev that seat did NOT author
//   (`fr`). A move/newgame carrying `base` (the rev the client's board was built
//   on) is rejected as `stale` when base < fr[seat]: the opponent moved, a Coco
//   Attack landed, or a rematch started since the client last looked, so the
//   snapshot would roll that back. A client's own successive pushes (selection
//   syncs) never trip it. Clients without `base` (pre-v71) are accepted as before.
//   welcome/moveok/state/newgame/reject/gameover all carry the current rev.
//
// Wire protocol (v62 envelope + v71 rev/base): every game message is {type:'__a', op}.
//   client → server: hello, peek, ping, move, newgame, gameover, coco, push, pushoff
//   server → client: welcome, roster, pong, moveok, reject, state, newgame,
//                    gameover, peer, pushok

const PING = '{"type":"__a","op":"ping"}';
const PONG = '{"type":"__a","op":"pong"}';
const LIVE_MS = 45e3;              // a seat with no traffic for this long counts as gone
const MAX_STATE_BYTES = 512 * 1024;
const IDLE_WIPE_MS = 90 * 864e5;   // rooms untouched this long are deleted
const OPEN = 1;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "r" && parts[1]) {
      if (request.headers.get("Upgrade") !== "websocket")
        return new Response("Expected WebSocket", { status: 426 });
      const code = parts[1].toUpperCase().slice(0, 64);
      const id = env.ROOMS.idFromName(code);
      return env.ROOMS.get(id).fetch(request);
    }
    if (parts.length === 0 || parts[0] === "health")
      return new Response("SpellCoco relay OK", { status: 200, headers: { "content-type": "text/plain" } });
    return new Response("Not found", { status: 404 });
  }
};

const record = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
const seatIndex = (v) => v === 0 || v === 1;
const word = (v) => typeof v === "string" && /^[A-Z]{2,15}$/.test(v);
function validPlayer(p) {
  return record(p) && typeof p.name === "string" && p.name.length > 0 && p.name.length <= 24
    && integer(p.score, Number.MAX_SAFE_INTEGER) && integer(p.gems, 9999)
    && (p.wordsPlayed == null || Array.isArray(p.wordsPlayed));
}
function validState(s) {
  if (!record(s)) return false;
  if (!Array.isArray(s.players) || s.players.length !== 2 || !s.players.every(validPlayer)) return false;
  if (!seatIndex(s.turnIndex) || !seatIndex(s.startIndex) || !integer(s.round, 99) || s.round < 1) return false;
  if (!Array.isArray(s.tiles) || s.tiles.length !== 25 || !s.tiles.every((t) =>
    record(t) && typeof t.char === "string" && /^[A-Z]$/.test(t.char)
    && [null, "DL", "TL", "2W", "3W"].includes(t.mult) && typeof t.gem === "boolean")) return false;
  if (!Array.isArray(s.sel) || s.sel.some((id) => !integer(id, 24)) || new Set(s.sel).size !== s.sel.length) return false;
  if (typeof s.over !== "boolean" || typeof s.cocoTimerActive !== "boolean" || !integer(s.timeLeft, Number.MAX_SAFE_INTEGER)) return false;
  if (s.cocoPendingFor != null && !seatIndex(s.cocoPendingFor)) return false;
  if (s.finalPlayers != null && (!Array.isArray(s.finalPlayers) || s.finalPlayers.length !== 2 || !s.finalPlayers.every(validPlayer))) return false;
  try { if (new TextEncoder().encode(JSON.stringify(s)).byteLength > MAX_STATE_BYTES) return false; } catch { return false; }
  return true;
}
function validSideMessage(m) {
  switch (m.type) {
    case "customs": return Array.isArray(m.words) && m.words.every(word);
    case "stats": return record(m.stats);
    case "side": return typeof m.host === "string" || typeof m.guest === "string";
    case "fx": return true; // The client sanitizes each supported effect field.
    case "wordreq": case "wordok": case "wordno": case "addword": return word(m.w);
    case "undoreq": return typeof m.from === "string" && typeof m.to === "string" && /^[A-Z]$/.test(m.from) && /^[A-Z]$/.test(m.to);
    case "undook": case "undono": return true;
    default: return false;
  }
}
function seated(info) { return !!info && info.seat != null && info.seat !== -1; }
const revOf = (v) => (Number.isInteger(v) && v >= 0) ? v : null;

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Heartbeats are answered by the runtime while we sleep. Exact-string match
    // on what the client's JSON.stringify produces.
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  // ---- socket bookkeeping (attachments survive hibernation) ----
  info(ws) { try { return ws.deserializeAttachment() || null; } catch { return null; } }
  setInfo(ws, obj) { try { ws.serializeAttachment(obj); } catch {} }
  lastSeen(ws, info) {
    let t = (info && info.last) || 0;
    try { const a = this.state.getWebSocketAutoResponseTimestamp(ws); if (a) t = Math.max(t, a.getTime()); } catch {}
    return t;
  }
  sockets() { try { return this.state.getWebSockets(); } catch { return []; } }

  async fetch(request) {
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.state.acceptWebSocket(server);
    this.setInfo(server, { seat: null, name: null, last: Date.now() });
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, data) {
    try { await this.onMessage(ws, data); }
    catch (e) {
      console.error("room handler failed", e && e.message);
      // No q on purpose: the client treats a reject echoing its q as an ack.
      this.send(ws, { type: "__a", op: "reject", reason: "error", state: null });
    }
  }
  async webSocketClose(ws) { this.drop(ws); }
  async webSocketError(ws) { this.drop(ws); }
  drop(ws) {
    const me = this.info(ws);
    try { ws.close(); } catch {}
    if (seated(me)) this.toOthers(ws, { type: "__a", op: "peer", seat: me.seat, present: false });
  }

  async onMessage(ws, data) {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== "object") return;
    const inf = this.info(ws);
    if (inf) { inf.last = Date.now(); this.setInfo(ws, inf); }
    if (m.type === "__a") {
      if (m.op === "hello") return this.onHello(ws, m);
      if (m.op === "peek") return this.onPeek(ws, m);
      if (m.op === "ping") return this.send(ws, { type: "__a", op: "pong" });
      if (m.op === "move") return this.onMove(ws, m);
      if (m.op === "newgame") return this.onNewGame(ws, m);
      if (m.op === "gameover") return this.onGameOver(ws, m);
      if (m.op === "coco") return this.onCoco(ws, m);
      if (m.op === "push") return this.onPush(ws, m);
      if (m.op === "pushoff") return this.onPushOff(ws, m);
      return; // Reserved protocol: never forward client-forged server messages.
    }
    // Side channel (customs, stats, fx, word/undo requests): seated players only.
    if (!seated(inf) || !validSideMessage(m)) return;
    this.toOthers(ws, m);
  }

  // ---- v71 revisions ----
  async rev() { return (await this.state.storage.get("rev")) || 0; }
  // Is `base` (the rev the client's snapshot was built on) older than the last
  // write somebody ELSE made? Missing/invalid base ⇒ legacy client ⇒ no check.
  async stale(seat, base) {
    base = revOf(base);
    if (base == null) return false;
    const fr = (await this.state.storage.get("fr")) || [0, 0];
    return base < (fr[seat] || 0);
  }
  // Record an accepted write by `by` (a seat, or -1 for a server-side change
  // such as Coco Attack): bump rev, and mark it foreign to every other seat.
  async bump(by) {
    const r = (await this.rev()) + 1;
    const fr = (await this.state.storage.get("fr")) || [0, 0];
    for (const s of [0, 1]) if (s !== by) fr[s] = r;
    await this.state.storage.put("rev", r);
    await this.state.storage.put("fr", fr);
    return r;
  }

  // A player announces who they are; assign/restore their seat by NAME so the
  // same person keeps their seat across devices and reopens. The dev nonce
  // guards the seat while it's LIVE, and lets a device rename itself.
  async onHello(ws, m) {
    const name = String(m.name || "Player").replace(/[^A-Za-z0-9 '\-]/g, "").slice(0, 24) || "Player";
    const dev = typeof m.dev === "string" && m.dev ? m.dev.slice(0, 40) : null;
    let seats = await this.state.storage.get("seats") || [];
    let seat = seats.findIndex((s) => s && s.name === name);
    if (seat === -1 && dev) {
      const mine = seats.findIndex((s) => s && s.dev === dev);
      if (mine !== -1) { seat = mine; seats[mine].name = name; await this.state.storage.put("seats", seats); }
    }
    if (seat === -1) {
      if (seats.length < 2) { seat = seats.length; seats.push({ name, dev }); await this.state.storage.put("seats", seats); }
    } else {
      let liveOther = false;
      const now = Date.now();
      for (const s of this.sockets()) {
        if (s === ws) continue;
        const info = this.info(s);
        if (!info || info.seat !== seat) continue;
        if (this.lastSeen(s, info) > now - LIVE_MS) liveOther = true;
        else { try { s.close(1000, "stale"); } catch {} }
      }
      if (liveOther && !(dev && seats[seat].dev && seats[seat].dev === dev)) {
        const prev = this.info(ws);
        this.send(ws, { type: "__a", op: "welcome", seat: seated(prev) ? prev.seat : -1, busy: true, full: false,
          names: seats.map((s) => s ? s.name : null), state: null, config: null });
        return;
      }
      if (dev && seats[seat].dev !== dev) { seats[seat].dev = dev; await this.state.storage.put("seats", seats); }
      if (liveOther) {
        for (const s of this.sockets()) {
          if (s === ws) continue;
          const info = this.info(s);
          if (info && info.seat === seat) { try { s.close(1000, "superseded"); } catch {} }
        }
      }
    }
    this.setInfo(ws, { seat, name, last: Date.now() });
    const game = await this.state.storage.get("game") || null;
    const config = await this.state.storage.get("config") || null;
    this.send(ws, { type: "__a", op: "welcome", seat, full: seat === -1, names: seats.map((s) => s ? s.name : null), state: game, config, rev: await this.rev() });
    if (seat !== -1) this.toOthers(ws, { type: "__a", op: "peer", seat, name, present: true });
    await this.touch();
  }

  // Read-only: report who holds seats WITHOUT assigning one.
  async onPeek(ws) {
    const seats = await this.state.storage.get("seats") || [];
    this.send(ws, { type: "__a", op: "roster", names: seats.map((s) => s ? s.name : null), full: seats.length >= 2 });
  }

  async onMove(ws, m) {
    const me = this.info(ws);
    if (!seated(me)) { this.send(ws, { type: "__a", op: "reject", reason: "no-seat", q: m.q, state: null }); return; }
    // Echo q: a bad state can't be fixed by re-pushing, so let the client retire it.
    if (!validState(m.state)) { this.send(ws, { type: "__a", op: "reject", reason: "bad-state", q: m.q, state: null }); return; }
    const game = await this.state.storage.get("game");
    const rev = await this.rev();
    if (game && game.over && !m.state.over) { this.send(ws, { type: "__a", op: "reject", reason: "game-over", q: m.q, state: game, rev }); return; }
    // v71: the snapshot was built before somebody else's write landed — storing it
    // would roll that write back (the READING-style replay after a lost ack, or a
    // selection sync racing a Coco Attack). The client adopts the state we return.
    if (game && await this.stale(me.seat, m.base)) { this.send(ws, { type: "__a", op: "reject", reason: "stale", q: m.q, state: game, rev }); return; }
    if (game && typeof game.turnIndex === "number" && game.turnIndex !== me.seat) {
      this.send(ws, { type: "__a", op: "reject", reason: "not-your-turn", q: m.q, state: game, rev }); return;
    }
    if (game && game.over) {
      m.state.over = true;
      if (game.finalPlayers && !m.state.finalPlayers) m.state.finalPlayers = game.finalPlayers;
    }
    await this.state.storage.put("game", m.state);
    if (m.config && typeof m.config === "object") await this.state.storage.put("config", m.config);
    const nrev = await this.bump(me.seat);
    this.send(ws, { type: "__a", op: "moveok", q: m.q, rev: nrev });
    this.toOthers(ws, { type: "__a", op: "state", state: m.state, rev: nrev });
    await this.touch();
    if (!m.state.over && typeof m.state.turnIndex === "number")
      this.notifySeat(m.state.turnIndex, `${me.name || "Your opponent"} played — your move!`).catch(() => {});
  }

  // The game ended — mark the stored game finished and keep the final ranked
  // recap, so a player who rejoins later sees the ending (not a live board).
  async onGameOver(ws, m) {
    const me = this.info(ws);
    if (!seated(me)) { this.send(ws, { type: "__a", op: "reject", reason: "no-seat", state: null }); return; }
    if (!Array.isArray(m.players) || m.players.length !== 2 || !m.players.every(validPlayer)) {
      this.send(ws, { type: "__a", op: "reject", reason: "bad-state", state: null }); return;
    }
    const game = await this.state.storage.get("game");
    if (game && typeof game === "object") {
      game.over = true;
      if (Array.isArray(m.players)) game.finalPlayers = m.players.slice(0, 2);
      if (!validState(game)) { this.send(ws, { type: "__a", op: "reject", reason: "bad-state", state: null }); return; }
      await this.state.storage.put("game", game);
    }
    m.rev = await this.bump(me.seat);
    this.toOthers(ws, m);
    await this.touch();
    this.notifySeat(1 - me.seat, "Game over — open SpellCoco for the recap \u{1F3C6}").catch(() => {});
  }

  async onNewGame(ws, m) {
    const me = this.info(ws);
    if (!seated(me)) { this.send(ws, { type: "__a", op: "reject", reason: "no-seat", q: m.q, state: null }); return; }
    if (!validState(m.state)) { this.send(ws, { type: "__a", op: "reject", reason: "bad-state", q: m.q, state: null }); return; }
    // v71: a rematch pushed from a board that predates the opponent's own rematch
    // (both tapped Rematch while apart) would wipe theirs — same stale rule as moves.
    const game = await this.state.storage.get("game");
    if (game && await this.stale(me.seat, m.base)) { this.send(ws, { type: "__a", op: "reject", reason: "stale", q: m.q, state: game, rev: await this.rev() }); return; }
    await this.state.storage.put("game", m.state);
    if (m.config && typeof m.config === "object") await this.state.storage.put("config", m.config);
    const nrev = await this.bump(me.seat);
    if (m.q != null) this.send(ws, { type: "__a", op: "moveok", q: m.q, rev: nrev });
    this.toOthers(ws, { type: "__a", op: "newgame", state: m.state, config: m.config || null, rev: nrev });
    await this.touch();
    this.notifySeat(1 - me.seat, `${me.name || "Your opponent"} started a new game — come play!`).catch(() => {});
  }

  // Coco Attack: the attacker (non-active player) spends treats to mark the
  // opponent's turn. Applied server-side (bypassing the turn check) so it works
  // even when the victim is offline; the victim's client starts the timer when
  // it's their turn. Ignored if a mark/timer is already up or treats are short.
  async onCoco(ws, m) {
    const me = this.info(ws);
    if (!seated(me)) return;
    const game = await this.state.storage.get("game");
    if (!game || typeof game !== "object" || !Array.isArray(game.players) || game.players.length < 2 || game.over) return;
    if (typeof game.turnIndex === "number" && game.turnIndex === me.seat) return;   // attacker must be the non-active seat
    const cfg = await this.state.storage.get("config") || null;
    if (cfg && cfg.cocoAttackEnabled === false) return;
    const want = parseInt(cfg && cfg.cocoAttackCost, 10);
    const cost = Math.max(1, Math.min(99, Number.isFinite(want) ? want : (parseInt(m.cost, 10) || 4)));
    const victim = 1 - me.seat;
    const atk = game.players[me.seat];
    if (!atk || (atk.gems || 0) < cost) return;
    if (game.cocoPendingFor != null || game.cocoTimerActive) return;
    atk.gems -= cost;
    game.cocoPendingFor = victim;
    await this.state.storage.put("game", game);
    const msg = { type: "__a", op: "state", state: game, rev: await this.bump(-1) };   // v71: foreign to BOTH seats — a selection sync in flight must not erase the mark
    this.send(ws, msg);
    this.toOthers(ws, msg);
    await this.touch();
  }

  // A device registers for turn alerts. One record per device/endpoint,
  // bound to the seat NAME the socket holds. Capped at 8 records a room.
  async onPush(ws, m) {
    const me = this.info(ws);
    if (!seated(me) || !me.name) return;
    if (!m.sub || typeof m.sub.endpoint !== "string" || !/^https:\/\//.test(m.sub.endpoint)) return;
    const dev = typeof m.dev === "string" && m.dev ? m.dev.slice(0, 40) : null;
    let subs = await this.state.storage.get("push") || [];
    subs = subs.filter((s) => s && s.sub && s.sub.endpoint !== m.sub.endpoint && !(dev && s.dev === dev));
    subs.push({ name: me.name, dev, sub: { endpoint: m.sub.endpoint.slice(0, 1024), keys: (m.sub.keys && typeof m.sub.keys === "object") ? m.sub.keys : {} },
      url: (typeof m.url === "string" && /^https:\/\//.test(m.url)) ? m.url.slice(0, 300) : null });
    while (subs.length > 8) subs.shift();
    await this.state.storage.put("push", subs);
    this.send(ws, { type: "__a", op: "pushok" });
    await this.touch();
  }
  async onPushOff(ws, m) {
    const ep = m && typeof m.endpoint === "string" ? m.endpoint : null;
    const dev = m && typeof m.dev === "string" ? m.dev : null;
    if (!ep && !dev) return;
    const subs = await this.state.storage.get("push") || [];
    const keep = subs.filter((s) => s && !(ep && s.sub && s.sub.endpoint === ep) && !(dev && s.dev === dev));
    if (keep.length !== subs.length) await this.state.storage.put("push", keep);
  }

  // Push "your move" to a seat's registered devices — unless that player has a
  // live socket in the room right now (never ping someone mid-game).
  async notifySeat(targetSeat, body) {
    try {
      if (!this.env || !this.env.VAPID_JWK) return;
      if (targetSeat == null || targetSeat < 0) return;
      const now = Date.now();
      for (const s of this.sockets()) {
        const info = this.info(s);
        if (info && info.seat === targetSeat && this.lastSeen(s, info) > now - LIVE_MS) return;
      }
      const seats = await this.state.storage.get("seats") || [];
      const name = seats[targetSeat] && seats[targetSeat].name;
      if (!name) return;
      const subs = await this.state.storage.get("push") || [];
      const mine = subs.filter((s) => s && s.name === name);
      if (!mine.length) return;
      const gone = [];
      for (const rec of mine) {
        const r = await sendWebPush(this.env, rec.sub, JSON.stringify({ title: "SpellCoco \u{1F43E}", body, url: rec.url || "https://westsmith.github.io/SpellCoco/" }));
        if (r === "gone") gone.push(rec);
      }
      if (gone.length) await this.state.storage.put("push", subs.filter((s) => !gone.includes(s)));
    } catch (e) {}
  }

  // ---- idle-room expiry ----
  async touch() {
    try {
      const now = Date.now();
      // Throttled to hourly: Coco-timer ticks push a move every second.
      if (this._touched && now - this._touched < 36e5) return;
      this._touched = now;
      await this.state.storage.put("lastWrite", now);
      const cur = await this.state.storage.getAlarm();
      const want = now + IDLE_WIPE_MS;
      if (cur == null || want - cur > 864e5) await this.state.storage.setAlarm(want);
    } catch {}
  }
  async alarm() {
    try {
      const now = Date.now();
      const live = this.sockets().some((s) => this.lastSeen(s, this.info(s)) > now - LIVE_MS);
      if (live) { await this.state.storage.setAlarm(now + 7 * 864e5); return; }
      const last = (await this.state.storage.get("lastWrite")) || 0;
      if (Date.now() - last < IDLE_WIPE_MS) { await this.state.storage.setAlarm(last + IDLE_WIPE_MS); return; }
      await this.state.storage.deleteAll();   // also clears the alarm
    } catch (e) { console.error("alarm failed", e && e.message); }
  }

  send(ws, obj) { try { if (ws.readyState === OPEN) ws.send(JSON.stringify(obj)); } catch {} }
  toOthers(ws, obj) { for (const s of this.sockets()) if (s !== ws) this.send(s, obj); }
}

// ---- Web Push (RFC 8291 aes128gcm + VAPID) ----
const te = (s) => new TextEncoder().encode(s);
function b64uEnc(buf) {
  let s = ""; const a = new Uint8Array(buf);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uDec(str) {
  let s = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const b = atob(s); const a = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
  return a;
}
function cat(...parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}
export async function encryptPush(sub, payload, testKeys) {
  const clientPub = b64uDec(sub.keys.p256dh);
  const auth = b64uDec(sub.keys.auth);
  const eph = testKeys ? testKeys.pair : await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const ephPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const peer = await crypto.subtle.importKey("raw", clientPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, eph.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, cat(te("WebPush: info\0"), clientPub, ephPub), 32);
  const salt = testKeys ? testKeys.salt : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te("Content-Encoding: nonce\0"), 12);
  const plain = cat(te(payload), new Uint8Array([2]));
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return cat(salt, rs, new Uint8Array([ephPub.length]), ephPub, ct);
}
async function vapidAuth(env, endpoint) {
  const jwk = JSON.parse(env.VAPID_JWK);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const aud = new URL(endpoint).origin;
  const head = b64uEnc(te(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64uEnc(te(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1e3) + 12 * 3600, sub: "mailto:thestudent@gmail.com" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te(head + "." + body));
  const pub = b64uEnc(cat(new Uint8Array([4]), b64uDec(jwk.x), b64uDec(jwk.y)));
  return `vapid t=${head}.${body}.${b64uEnc(sig)}, k=${pub}`;
}
async function sendWebPush(env, sub, payload) {
  try {
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return "bad";
    const body = await encryptPush(sub, payload);
    const res = await fetch(sub.endpoint, { method: "POST", headers: { Authorization: await vapidAuth(env, sub.endpoint), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "normal" }, body });
    if (res.status === 404 || res.status === 410) return "gone";
    return res.ok || res.status === 201 ? "ok" : "fail:" + res.status;
  } catch (e) { return "err"; }
}
