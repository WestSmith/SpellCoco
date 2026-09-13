# SpellCoco changelog

Newest first. The on-screen build label is `APP_VERSION` in `index.html`.

```
================================================================
SPELLCOCO v71 — AUDIT FIXES (PROPOSED)
- Worker: block forged server-only relay operations; allowlist supported
  side messages; reject malformed playable states and final recaps before
  persisting them. This validates shape, not authoritative game rules.
- Coco Attack: activate restored games after installing the game and seat;
  resume the saved countdown on its owning client, persist local ticks,
  and cancel an old timer when an authoritative turn/ending replaces it.
- Dictionary: bound both downloads (including body reads), index after
  fallback, report readiness only after indexing, filter imports to A-Z,
  and defensively skip unsupported letters in the swap solver.
- Cloud assist: enable Submit for eligible unknown words; ignore late
  responses after the game, turn, or selection changes.
- Keyboard: native letter buttons, arrow navigation, Enter/Space selection,
  Backspace/Escape, retained focus, and a keyboard-operable swap picker.
- Guest identities: reserve suffix space and avoid an identical fallback.
- Tests: Node regression suite in CI. The audit and follow-up designs are
  in docs/audit/. Revision/idempotency, durable pending moves, statistics
  exchange and per-match results remain open; no deployment accompanies
  this proposal.
================================================================

================================================================
SPELLCOCO v70 — REVIEW ROUND 3 (2026-09-12)
- FIX: reject{game-over} while a rematch is pending kept the move tracked
  correctly (v69.1 stored the reject itself and re-sent it every 20s,
  which relayed the OLD recap to the opponent and lost the real move).
- FIX: NET.disconnect resets the busy/re-hello counters so a device can
  rejoin after one "seat busy" welcome; a refused newgame (bad-state)
  stops re-sending; CONFIG.solo is cleared on every online load; closing
  the definition modal disowns an in-flight lookup.
- PERF: the 196k-word trie is built once (both word lists awaited
  together); TrieNode children are prototype-free objects.
- FIX: dictionary API calls abort after 8s — a hung request used to leave
  cloudPending stuck and block every later submit.
- UI: toasts wrap instead of truncating on phones; safe-area insets apply
  at every width (landscape notches); screen-reader status region for
  turn changes and submitted words; word display aria-hidden.
- PWA: real maskable icon (opaque, logo inside the safe zone) and a
  180px apple-touch-icon.
- REPO: CHANGELOG.md (this file) replaces the in-<head> changelog;
  GitHub Actions static checks (syntax, manifest, version label);
  README covers solo, async play and turn alerts.
================================================================

================================================================
SPELLCOCO v69.1 — REGRESSION FIXES FROM THE v68/v69 REVIEW
- pendingStart re-send now runs before the move replay and sends the
  current board; a reject{game-over} while a start is pending no longer
  resurrects the old recap. Busy/full welcomes mid-game drop the socket
  but keep the room identity (NET.disconnect) so netNudge can recover.
  DEF_PENDING set before the cache hit; AudioContext.resume() rejections
  swallowed; solo flag never accepted from a peer config; P2P superseded
  pipe guarded; sw.js tolerates a bad push URL; APP_VERSION bumped.
- Worker: bad-state rejects echo q so the client retires the move;
  lastWrite throttled to hourly; idle alarm ignores dead sockets; push
  URLs must be https.

SPELLCOCO v69 — SERVER HARDENING (worker source now lives in worker/)
- Worker: WebSocket hibernation (idle rooms no longer billed), seat
  required for newgame, state validation + storage-error rejects,
  config-derived Coco cost + non-active-seat check, seated-only side
  channel, newgame acked with moveok{q}, 90-day idle-room wipe,
  Workers Logs enabled. Wire protocol unchanged.
- Client: ASYNC_URL is a literal; the defunct relay host is dropped from
  the CSP connect-src.

SPELLCOCO v68 — BUG SWEEP (adversarially verified review, 2026-09-12)
- FIX: NET.cleanup now leaves the async room for real (async flag, code,
  gameCode, seat, myIndex). A stale flag hijacked later LOCAL games:
  netNudge reconnected to the old room on wake, every local move sent
  "Reconnecting" toasts, local autosave stopped, local Coco Attack sent
  a net op instead of starting the timer, stats were keyed by the old room.
- FIX: sanitizeConfig keeps CONFIG.solo — resumed vs-Coco games froze
  (Coco never took a turn, human blocked on Coco's seat).
- FIX: Start treats = 0 no longer silently becomes 3; Zoomies fallback
  cost is 4 everywhere (was 5 in two places, 4 in the default/UI).
- FIX: Shuffle cleared the selection AFTER tile ids moved, leaving
  permanently highlighted ghost tiles. Order swapped + shuffleBoard scrubs.
- FIX: Coco-timer expiry's delayed endTurn is tracked/cancelled; endTurn
  refuses to run on a finished game (double-advance / double treat bonus).
- FIX: ability modals (swap/shuffle/zoomies) close on turn change so they
  can't charge the next player; confirmShuffle now checks turn/treats
  (could go negative).
- FIX: Zoomies closes the undo-swap window (parity with Shuffle).
- FIX: tile tap fired twice (pointerdown + per-tile onclick); only the
  primary pointer/button starts a selection now.
- FIX: audio unlock — playTone re-resumes a suspended context and the
  first board tap calls initAudio (iOS guests/async loads were silent).
- FIX: definition lookup no longer caches network failures for the
  session, a slower earlier lookup can't overwrite the word tapped last,
  404 = "no entry" but 429/5xx = "couldn't reach" (also in cloudCheckWord).
- FIX: win-tracker merge coerces wire counters, merges the solo (Coco)
  record, and keeps games >= results.
- FIX (async): newgame/rematch op is remembered (pendingStart) and re-sent
  on a welcome that still shows the finished room — a dropped newgame
  used to resurrect the old recap and double-count its stats. Coco-timer
  ticks go through sendMove; only a sequenced moveok clears pendingMove.
- FIX (latent P2P/relay paths): remote submit paths are de-duplicated and
  adjacency-checked; a second PeerJS joiner closes the first connection.
- FIX: serviceWorker.register rejection handled; sw.js notificationclick
  only navigates a tab that isn't already on the game URL.
- REMOVED: v62test.html (stale pre-CSP client on the production relay).

SPELLCOCO v67.5 — FIX: tied game showed a winner
================================================================
A 293–293 Keith–Shawn game was recorded as a draw (the stats
code checks equal scores) but the recap banner crowned whoever
sat in seat 0: renderRecap took players[0] unconditionally.
Now a tied top score renders "It's a draw at N pts!" and both
tied players get the crown instead of "#2". Display only —
scoring and the all-time record are unchanged.
================================================================
SPELLCOCO v67.4 — SECURITY: malformed selection + cocoPendingFor
================================================================
Sixth audit pass — two availability issues, no XSS remaining.
- applySelection(ids) assumed an array and called .forEach — a
  peer 'sel'/'submit' with ids:{} threw (and left NET.quiet
  stuck, stalling later sync); string keys like "__proto__"
  could touch inherited props. Now rebuilds ids to valid in-
  range integer tile indices before use. The 'sel' handler also
  restores NET.quiet via try/finally.
- cocoPendingFor was sanitized to 0–9 but not bounded to a real
  seat; a value like 9 stays non-null forever and permanently
  blocks new Coco attacks (never matches a player to clear).
  Now coerced to null unless it's seat 0 or 1.
Availability hardening only; valid states unaffected.
================================================================
SPELLCOCO v67.3 — SECURITY: out-of-range startIndex (round stall)
================================================================
Fifth audit pass. validPlayableState() checked turnIndex<2 but
NOT startIndex — the sanitizer permits 0–9, fromState keeps it,
and a round ends only when the next player index === startIndex
(endTurn). A hostile startIndex of 2–9 never matches, so rounds
never advance and the game runs indefinitely. FIX: also require
startIndex < players.length (turnIndex check generalized to the
same bound). One-line hardening; valid states unaffected.
================================================================
SPELLCOCO v67.2 — SECURITY: ending-state XSS + malformed-state crash
================================================================
Third audit pass — one more recap XSS route + a crash hardening:
- asyncShowEnding(state) took the relay's RAW m.state (reject +
  closing-state branches) and forwarded finalPlayers/players to
  the recap innerHTML without cleanPlayers. Now it scrubs via
  cleanPlayers inside the function, protecting every caller, and
  bails if the cleaned list is empty.
- Malformed peer states (empty/short player or tile arrays, out-
  of-range turnIndex) used to reach Game.fromState → st.tiles.map
  / a missing currentPlayer → broke the guest's session. New
  validPlayableState() gate (exactly 2 valid players + 25 valid
  tiles + turnIndex<2): fromState returns null (validated BEFORE
  retiring the live game), applyState no-ops, all 5 fromState
  callers degrade gracefully (corrupt save cleared / start modal
  re-shown), and renderGameOver ignores an empty player list.
No gameplay/visual change for valid states.
================================================================
SPELLCOCO v67.1 — SECURITY: 3 more peer-message XSS routes
================================================================
Second audit pass caught three innerHTML sinks the v67 sweep
missed (all confirmed exploitable by a hostile HOST/opponent):
- guestStart(m.config): the wire CONFIG was passed straight
  through normalizeConfig, whose numeric fields (maxGems,
  costs.*, cocoAttackCost) are interpolated into innerHTML.
  normalizeConfig now runs sanitizeConfig — rebuilds CONFIG
  from a trusted default, coercing every field to its type.
- gameover m.players → renderGameOver/recordGameStats → recap
  interpolates names/words/scores into HTML. Both networking
  paths now scrub via cleanPlayers (cleanPlayer per entry).
- undoreq m.from/m.to → undoreq-text.innerHTML. Now cleanChar
  at ingestion AND at the sink (board chars only).
No gameplay/visual change — legit values pass through identical.
================================================================
SPELLCOCO v67 — SECURITY HARDENING (WIRE-DATA SANITATION)
================================================================
From an external code audit. A hostile online opponent (or anyone
who learns a room code) could inject HTML/JS into the other
player's page: game states, stats syncs, fx relays, and custom-word
messages were rendered with innerHTML unvalidated.

- Wire-data sanitation layer (cleanPlayer/cleanPlayedWord/
  sanitizeNetState & co.): every remote game state (relay + P2P +
  saved resumes) is rebuilt from validated pieces at ingestion —
  names stripped to name-safe chars, words must be A–Z, all
  numbers coerced, tile chars/multipliers checked against the
  real sets. Covers player cards, history, recap, and board.
- mergeStats: bestWord/longestWord rebuilt via cleanBestRec
  (were copied wholesale off the wire into an innerHTML sink).
- fx relays (P2P + async): toast/overlay/celebration text is
  escaped on receive (netSafeHtml — the TICON treat icon is the
  one markup token restored); bubbleDelay coerced; SFX key gated
  to own properties.
- wordok/wordno/addword now validate m.w BEFORE toasting (the
  toast used to render the raw string even when addCustomWord
  rejected it); wordreq unchanged (was already validated).
- asyncWelcome seat names + peek roster sanitized at ingestion.
- PeerJS CDN script now carries an SRI integrity hash (matches
  cdnjs's published sha512) + crossorigin=anonymous.
- Content-Security-Policy meta: scripts pinned to self+cdnjs,
  connect-src limited to the two relays, PeerJS cloud, and
  dictionaryapi.dev; object/frame none.
No gameplay, netcode, or visual changes — legit values pass
through the sanitizers byte-identical.
================================================================
SPELLCOCO v66 — ZOMBIE GAME FIX + BUBBLE CHOREOGRAPHY
================================================================

CHANGELOG v65 → v66 (Shawn's playtest, 2026-07-04):
- FIX: "error sound when I click a word" + "scores/positions
  jumping around" (Round 6/5 screenshots) — ONE root cause: every
  new Game left the PREVIOUS game wired to #grid (setupTouchDrag
  listeners are never removed) with its timers alive. After "Play
  Again", each tap also fired the FINISHED game's handler, which
  played SFX.invalid and repainted the whole UI with its dead
  state. New retireGame() marks the old instance _dead (called
  from the constructor and fromState, so every replacement path is
  covered) and _dead now gates every entry point: grid listeners,
  handleTileClick, submitWord, endTurn, updateUI. Finished games
  also stop taking board taps (handleTileClick checks .over).
- FIX: Coco's bubble no longer appears BEFORE he ambles over —
  FX.loungeUntil is stamped when a side-switch is scheduled
  (1.6s defer + 1.4s walk) and the bubble pump waits it out,
  alongside the existing round-overlay wait.
- CHANGE: bubble messages are now UTTERANCES, one bubble at a
  time. Same-play lines (score → best word → swap ceiling, <900ms
  apart) still merge; anything later is a NEW bubble, and every
  personality line (quips, teases, reactions, net bubbles) is
  ALWAYS standalone — a swap no longer silently grows an old
  bubble, and quips stop getting buried. The current bubble gets
  ≥1.7s on screen, then a 280ms blink separates bubbles (no
  animation — Keith's sensory-load rule). Eyes stay open across
  the blink when more is queued.
- Client-only, no netcode change. v65 preserved for revert.

================================================================
(v65) COCO SPEAKS (DE-BOXITIS) + STATUS DOTS
================================================================

CHANGELOG v64 → v65 (Shawn's mobile UI/UX pass, 2026-07-04):
- CHANGE: player cards lose the P1/P2 chips and the "▸ history"
  hint — left card IS first player, and the whole card was already
  tappable. Cards are now real buttons (Enter/Space opens history,
  aria-label announces it).
- ADD: online status dots on the player cards (online games only):
  green = connected, yellow = reconnecting/unknown, red = offline.
  YOUR card shows your socket; the opponent card shows their
  presence. The 🌐 header pill stays (Shawn's call).
- REMOVE: ALL connection popups ("Reconnecting…", "Opponent went
  offline", "is online", "Host disconnected"…) — the dots carry
  that now. The #ingame-rejoin banner stays.
- CHANGE: game-event toasts are GONE — Coco says them instead.
  One cream bubble anchored to wherever he's lounging (absolute in
  the player-bar wrap, so it scrolls with the page and moves with
  him). Messages from the same play MERGE into one multi-line
  bubble (score + best-word + swap ceiling) instead of queuing.
  Bubble is edge-bound (left+right constraints) so text can never
  bleed off the board. His eyes OPEN while he speaks (real
  COCO_MARK eyes: white sclera / green iris / pupil / glint) and
  close again after.
- CHANGE: instant input feedback ("Not a valid word!", "Not enough
  treats!", "Swap cancelled"…) is now a quiet inline line in the
  word area — immediate, boxless, never queued (Shawn: events-only
  speech).
- CHANGE: history modal is fully LEFT-ALIGNED (the modal's
  text-align:center leaked in), meta text is bigger + brighter
  (AAA), italics dropped — Keith-readable.
- Client-only, no netcode change. v64 preserved for revert.

================================================================
(v63) POPUP CHOREOGRAPHY (FX QUEUE)
================================================================

CHANGELOG v62 → v63 (Shawn's screenshots, 2026-07-03):
- FIX: popups no longer float ON TOP of the round/turn fade.
  Toasts were z-index 999 over the overlay's 90 AND fired in the
  same tick as endTurn's overlay. The overlay is now z 1100
  (covers everything) and stamps FX.overlayUntil; every toast
  rides a new FX QUEUE that waits out the fade and then shows
  ONE toast at a time (2.4s spacing) — no more stacked/overlapped
  toasts, no more ghost-text mess mid-fade. The score float (+NN)
  defers past the fade too.
- CHANGE: the hand-tuned 2600/5300ms delays for the "⭐ Best
  possible" and "🔄 With a swap" toasts are gone — they queue in
  order. Coco's bubble delay is now fxEta() (queue-drain time),
  still sender-computed for the online fx channel. Toasts queued
  before the game ends are dropped if it ends while they wait.
- FIX (mobile): docked toasts are BOTTOM-anchored at Coco's
  midline, so wrapped toasts grow UP into the header gap instead
  of down over the top tile rows (v62 top-anchored them).
- FIX (mobile): "✦ Coco's Guest's Turn ✦" wrapped with a lone ✦
  on its own line. Title sparkles are now &nbsp;-bound, the
  overlay is centered with side padding, and long titles wrap
  balanced (text-wrap:balance).
- Client-only, no netcode/gameplay change. v62 preserved for revert.

================================================================
(v62) SHAWN'S PLAYTEST FIXES + UNDO SWAP + TURN PUSH
================================================================

CHANGELOG v61 → v62 (Shawn + Keith's live-game feedback, 2026-07-01):
- FIX (desktop): the v60 bottom-pinned reference cluster left a
  void in the lower-left when the panel content was short. The
  sidebar now hugs its content (height:auto, max-height caps it)
  and #letter-ref keeps its order but drops margin-top:auto.
- FIX (desktop): the 🌐 net pill was clipped at the panel edge —
  the header couldn't shrink. The volume slider is now flexible
  (flex:1, min 36px) and the logo row may compress, so mute +
  slider + pill always fit.
- FIX (mobile): SWAP now works on iPhone. The swap-target tap
  relied on a `click` that iOS Safari doesn't reliably deliver
  on the drag-managed grid; pointerdown now handles it directly.
  A 350ms ghost-tap guard stops the same touch from "choosing" a
  letter in the picker that opens under the finger.
- FIX (online): Coco's speech bubbles never reached the OPPONENT
  in server (async) games — asyncFx dropped the fx `bubble`
  field. Keith saw his own 100+ lines; Shawn saw none.
- CHANGE (mobile): toasts dock beside lounging Coco (top of the
  board) instead of covering the bottom tile rows.
- ADD: Coco reactions after the post-word popups finish:
  90–99 pt lines (new tier), 100+ (existing pools), pet-word
  teasing (a word the same player has played 3+ times on this
  device — QUIZZER seeded for Keith), and RARE random chatter
  (5%, max 2/game, 25s cooldown; not every game — Shawn's
  sensory-overload rule). One reaction max per turn, priority
  100+ > 90s > tease > chatter. All ride the fx bubble channel
  with a sender-computed delay so they fire AFTER the toasts.
- CHANGE: player cards render in PLAY ORDER — whoever goes first
  is the LEFT card (P1), second player RIGHT (P2), regardless of
  who hosted. Cards get small P1/P2 tags. Coco's lounge side +
  "active" highlight follow the real turn index still.
- ADD: UNDO SWAP (consent-based, like custom words). Available
  to the swapper same-turn, BEFORE a word is submitted; opponent
  gets an Allow/Refuse modal; on Allow the tile letter reverts
  and the 3 treats come back. Local pass-and-play shows the
  modal to the other seat; solo Coco auto-forgives; online runs
  undoreq/undook/undono over the relay (async only — legacy P2P
  hides the button). Any board change (submit/shuffle/turn end)
  closes the window.
- ADD: TURN PUSH NOTIFICATIONS (Web Push). 🔔 toggle in the
  online panel + in-game room bar. iPhone requires the game
  installed to the Home Screen (iOS 16.4+ Apple rule — the
  toggle explains this). New sw.js service worker shows
  "Your move" notifications; the game server stores per-device
  subscriptions (op push/pushoff) and pushes on turn change,
  new game, and game over — only to players with no live
  socket in the room. VAPID keys: public pinned in client,
  private lives as a Worker secret (never in this repo).
- Server v62 changes ride the SAME wrangler worker
  (spellcoco-async); v61 client (37e45cb) preserved for revert.

================================================================
SPELLCOCO v61 — ONE SEAT PER LIVE PLAYER (SEAT-SHARING FIX)
================================================================

CHANGELOG v60 → v61 (Shawn: "even if I join as player 2, I can
control player 1 in player 1's round"):
- ROOT CAUSE (reproduced headlessly, 2 isolated clients vs the
  live relay): the relay seats purely by NAME. Whenever the
  joiner's hello carried the same name as the host — an explicit
  tap of the host's name (v58's ONLINE_TAPPED bypassed the v55
  collision guard), or a same-browser tab silently reusing the
  remembered identity (spellcoco.id.<code> is localStorage,
  shared across tabs) — BOTH live sockets got seat 0. Both
  clients then had myIndex=0, myTurn=true on player 1's turn,
  and the server accepted either socket's moves.
- FIX (client): hello now carries a per-TAB device nonce
  (sessionStorage spellcoco.dev — survives reload, never shared
  between tabs/devices). New 'busy' welcome handling: if my
  name's seat is being PLAYED live elsewhere, retry twice when
  this device remembers being that identity (covers a half-open
  socket of MY OWN dying tab), then take the open seat instead
  (openSeatName flip); if already seated, an identity tap that
  collides is reverted with a toast; if the room is truly full,
  say so. Tapping/typing an identity AFTER connecting now
  re-hellos, so the server seat FOLLOWS the tap (used to
  silently diverge: UI said Keith, server still had you as
  seat-0 Shawn).
- FIX (server v61): seats store {name, dev}. A hello for a seat
  that another LIVE socket holds is refused with busy (seat:-1)
  unless the dev nonce matches (same tab reconnecting — the old
  socket is superseded). A hello with a NEW name but a known dev
  RENAMES that device's seat pre-game (identity change follows
  the player). Two live sockets can never share a seat.
- Old client + new server: collision hello now gets seat -1
  (harmless spectator) instead of corrupting the game.
  New client + old server: dev/busy fields are simply unused;
  v55 name-guard behavior remains.
- v60 preserved for instant revert.

================================================================
SPELLCOCO v60 — KEITH'S DESKTOP CUT: NO-SCROLL SIDEBAR,
SOLID TREATS, FRESH BONUSES EVERY ROUND, COCO SPEAKS
================================================================

CHANGELOG v59 → v60 (Keith's recorded feedback session, 2026-07-01;
cleaned transcript in the OneDrive folder):
- CHANGE: Desktop layout (≥840px ONLY — mobile pixels untouched).
  Keith plays 100% zoom + fullscreen Firefox and still had to
  scroll the left column. Now: the dictionary checker moves UNDER
  the game board (JS relocates it via matchMedia; it snaps back
  for mobile) and opens by default there; the left panel is
  slightly narrower; Letter Values + Long Word Bonus + the room
  code bar are pinned to the panel BOTTOM (margin-top:auto) as
  collapsed dropdowns — turn, scores, treats, round stay visible
  with no scrolling. Rejoin link + offline status stay at the TOP
  (Keith: "keep that up at the top, but the room code down").
- ADD: 🔤 Letter Values dropdown (Keith: "I want to know what the
  value of every letter is") — A–Z chips built from LETTERS.
- CHANGE: Treat icons are SOLID now — same shapes, facet lines
  removed (.ticon, .tile-gem, selected/path gold variant). The
  crystal texture made Keith's eyes work to focus ("it wastes
  time for my eyes… makes the game more stressful").
- CHANGE: Bonus tiles re-roll EVERY round (Keith's spec, confirmed
  by Shawn): round 1 = one letter bonus only; every later round =
  one letter bonus AND one word bonus, random value (2x/3x uniform)
  and random spot, cleared+rerolled at each round start. Same board
  for both players (multipliers already ride serialized state).
  Used-bonus same-value random re-add (v48 rule) unchanged.
- CHANGE: Zoomies default cost 5 → 4 treats (Keith: "at five it
  will never be used"). One-time settings migration bumps saved 5s
  to 4 (flagged in spellcoco.zoom4 so a deliberate 5 sticks later).
  Still configurable on the start screen.
- ADD: 🗨 Coco speech bubble — 100+ point plays ONLY (rare by
  design; Keith: reacting to everything = sensory overload). A
  static cream bubble beside Coco (whichever side he's lounging
  on), auto-hides. Line pools are personal: loving for Shawn,
  grumpy-affectionate for Keith ("Do it again and I might let you
  pet me" — bed-stealing lore), neutral for guests, smug for Coco
  AI. Lines are pure sass — never solver output (v39 spoiler rule).
  Online: rides the existing type:'fx' live-toast channel.
- NOT DONE (explicitly cancelled in the session): all swap↔Coco-
  Attack interaction rules — Keith had misread Coco Attack as a
  board-changer. Otter's auto action-items list a 15s cooldown;
  it is WRONG, do not implement.
- Client-only; server untouched. v59 preserved for instant revert.

================================================================
SPELLCOCO v59 — MY GAMES LIST + REMATCH VALIDATION
================================================================

CHANGELOG v58 → v59 (Shawn: "go for it — My Games + rematch"):
- ADD: 🐾 My Online Games list on the start screen. Every async game
  this device plays is remembered in localStorage spellcoco.games
  (code → {opp, me, turn:'me'|'them'|'over', t}), capped at the 8
  most recent. Each row shows the opponent, whose turn it is
  ("YOUR TURN" rows glow eye-green), and how long ago it moved;
  tapping a row rejoins that room as the remembered identity
  (finished rooms open straight to the recap — v58's persistence).
  ✕ removes a row. regTurnSync() at the end of updateUI keeps the
  whose-turn flag fresh (memoized — one localStorage write per
  actual turn change, not per tap).
- Rematch: the existing 🔄 Rematch button (async branch, seat-stable
  names + random opener) is now live-validated 2-tab; sendStart's
  v58 gover-key clear means rematch stats record correctly.
- FIX (found in live test): launchGame now builds the Game QUIETLY —
  the constructor's updateUI pushed a 'move' BEFORE the 'newgame' op,
  so a rematch in a finished room was rejected with the old over-state
  and instantly re-finished itself. newgame is now the first message.
- FIX (found in live test): the game-ender's own My Games row now
  flips to "finished" (regTurnSync in endGame/asyncShowEnding/gameover
  — endGame skips updateUI, so the hook there never fired).
- Client-only; server untouched. v58 preserved for instant revert.

================================================================
SPELLCOCO v58 — CONNECTION RESILIENCE
================================================================

CHANGELOG v57 → v58 (audit of the online layer; Shawn: "we wanted
it to have connection resilience — proceed, I trust you"):
- ADD: heartbeat keepalive. Client pings the game server every 20s;
  a missed pong closes the socket so the normal auto-reconnect takes
  over. Catches "half-open" mobile connections that LOOK connected
  but silently eat messages. (Server v58 answers 'ping' with 'pong';
  the client only enforces the timeout once it has seen a pong, so
  it stays safe against an older server.)
- ADD: instant reconnect on wake. visibilitychange + online events
  call netNudge() — reconnect NOW instead of waiting out the backoff
  when the phone comes back from background/airplane mode.
- ADD: first-connect retry. Opening a game link on a flaky network
  retries up to 4 times before giving up (was: one shot, dead end).
- FIX: moves made while disconnected are no longer lost. If the
  socket is down when a move is pushed, the player sees "your move
  is safe and will sync"; on reconnect, if the server is a move
  behind (still shows it as OUR turn — turn enforcement makes this
  safe), the client REPLAYS its local state instead of reverting.
- FIX: finished games stay finished. serialize() now carries `over`;
  endGame pushes a closing state + the server persists over/final
  recap (finalPlayers). Rejoining a finished room shows the Game
  Over recap instead of resurrecting a live board. Stats record
  once per room (spellcoco.gover.<code> guard), so a player who
  missed the live ending still gets the result on rejoin.
- FIX: identity lock released for new games. ONLINE_LOCKED and the
  disabled seat buttons now reset in setMode() — after one online
  game you can host/join a new one as anyone without reloading.
- FIX: spurious "not your turn" toasts. Dictionary-update handlers
  (wordok/addword/answerWordRequest) repaint via quietUI() instead
  of updateUI(), which used to push a full state the server would
  reject. Real rejects now also carry the authoritative state so a
  diverged client self-heals.
- FIX: endGame ranks a COPY of players for the recap — seat order
  stays intact in the pushed final state.
- CHANGE: seat-collision guard (v55) now trusts an EXPLICIT tap.
  If you deliberately tapped who you are (ONLINE_TAPPED), joining
  as the same name as seat 0 no longer silently flips you to the
  other seat — fixes the real host being reseated as their opponent
  when opening the shared link on a new device.
- Server redeployed (spellcoco-async v58): ping/pong, persisted
  game-over, reject-with-state, finished-game move gate — and the
  v54 'peek' op is finally live (open-seat pre-pick on shared links).
- v57 preserved for instant revert.

================================================================
SPELLCOCO v57 — SOUND ON BY DEFAULT
================================================================

CHANGELOG v56 → v57 (Shawn: "sound should be on by default instead
of off"):
- CHANGE: Sound Effects now default ON. The #sound-toggle checkbox
  is `checked` in markup (new-user / fresh-install default), and
  restoreSettings reads `cfg.sound!==false` so a saved config that
  predates a stored sound flag also comes up ON. Existing players
  who explicitly turned sound OFF keep their choice (saved
  sound:false is respected). Mirrors the v45 cloud-assist pattern.
- Client-only; no gameplay, netcode, or state changes. v56 preserved
  for instant revert.

================================================================
SPELLCOCO v56 — VERSION ON SCREEN + PET THE COCO
================================================================

CHANGELOG v55 → v56 (Shawn: "show which version we're playing,
somewhere in the game" + "can clicking the sleeping Coco purr?"):
- ADD: on-screen build version. A single APP_VERSION constant feeds
  every .app-version slot — a subtle line under the start-screen
  tribute AND a tag in the in-game side-panel header
  ("Word Duel · 🐾 · v56"). Bump APP_VERSION (+ this header) per release.
- ADD: pet the Coco. Tapping the lounging Coco on the board frame
  plays a soft Web-Audio purr (two low sawtooth carriers through a
  lowpass, amplitude-modulated by a ~23→27 Hz LFO for the roll, gentle
  attack/release) plus a subtle wobble. Click or keyboard (role=button,
  Enter/Space); plays even if game SFX are muted (the tap unlocks
  audio), volume slider still applies.
- Both additive + client-only; no gameplay, netcode, or state changes.

================================================================
SPELLCOCO v55 — FAIR SEATS, FAIR START
================================================================

CHANGELOG v54 → v55 (Shawn reported: both players ended up "Shawn"
when joining by link; only the joiner saw the in-game room code;
and the host always went first):
- FIX (identity): the relay seats by NAME, so when a joiner's device
  defaulted to "Shawn" it collided onto the host's seat 0 — both
  controlled Shawn, nobody held Keith. A JOIN-mode client that lands
  on seat 0 now detects the collision and re-claims the OPEN seat
  (the host reopening the shared link is exempted via remembered
  identity). Identity is no longer stamped until the relay confirms
  the seat, so the guard can't be fooled by an unconfirmed default.
- ADD (identity lock): once BOTH seats are filled, each player's name
  is locked to their seat — a later disconnect/rejoin can't switch it
  (e.g. a "Shawn" can't become a guest). The seat picker collapses to
  your locked identity; the host's Start screen names the confirmed
  opponent.
- FIX (first player): online games randomize who opens instead of
  always the host. Implemented as a serialized startIndex with a
  round = one full cycle from the opener (backward-compatible with
  v54 saves, which open at seat 0). Applies to new games and rematch.
- FIX (room code): the host now also sees the always-visible in-game
  room-code bar (previously only the joiner did).
- All changes are client-side; the relay is unchanged.

================================================================
SPELLCOCO v48 — COCO LEARNS TO SPEND HIS TREATS
================================================================

CHANGELOG v47 → v48 (Shawn: "can Coco be smart enough to use
gems and swap letters? and can the best word factor in swaps?"):
- ADD: findBestWordWithSwap — the trie DFS gains a 1-substitution
  budget. At any step it may follow ANY trie child instead of the
  tile's real letter, spending the budget and recording
  {id, from, to}. The substituted tile scores at the NEW letter's
  value; DL/TL/2W/3W stay put (swap changes the letter, not the
  tile). Ties prefer the no-swap path so a swap is only reported
  when it's strictly better.
- ADD: Coco can now SWAP (mood-gated, COCO_SWAP). If he can
  afford it (cost + a mood reserve), the dice agree, and the
  swap-best beats the board best by the mood's threshold
  (zoomies ≥6 pts / cozy ≥12 / sleepy never), he pays 3 treats,
  the tile flips with a toast ("🐾 Coco swaps P→R!") and the
  swap sound, and he plays the unlocked word at his usual pace —
  missteps and all. He commits: a swapped turn plays the full
  swap word, not a mood-degraded one.
- ADD: Post-word reveal now includes the swap ceiling. After the
  existing "⭐ Best possible" toast, a second toast shows
  "🔄 With a swap: NN pts possible" when a swap beat the board
  best. SCORE ONLY mid-game — same no-spoiler rule as v39, since
  unused tiles survive the refill. The post-game recap and word
  history show the full detail: which letters, which word
  (definable, like board best).
- Efficiency % is UNCHANGED — still measured against the
  no-swap best, since swaps cost treats (Shawn's call).
- CHANGE: solo-panel hint no longer claims "he never uses
  abilities" (that was v41 truth). Now explains the mood rules.

================================================================
SPELLCOCO v47 — COCO WAITS FOR THE CURTAIN
================================================================

CHANGELOG v46 → v47 (Shawn: "the move animation is obscured —
it happens at the same time as the overlay"):
- FIX: Coco's amble to the active player's side was firing in the
  same tick as showRoundOverlay, so the whole 1.4s walk played
  behind the full-screen turn banner (90% opaque + blur, fades by
  ~1.6s). The side-toggle in updateUI is now deferred 1600ms when
  the side actually changes — banner announces the turn, lifts,
  and THEN Coco saunters over. First updateUI of a game still
  snaps him in place instantly (no pointless walk at setup), and
  the scheduled target is tracked so repeated updateUI calls
  (tile taps, net sync, Coco AI) can't reset or duplicate the
  timer. Works for host, guest, and solo alike since the logic
  lives in updateUI.

================================================================
SPELLCOCO v46 — COCO TAKES HIS TIME (AND STEPS ON THE WRONG TILE)
================================================================

CHANGELOG v45 → v46 (Shawn: "his round ends in under 10 seconds —
too quick to even read the word"):
- CHANGE: Coco's turn pacing is now per-mood (COCO_PACE) instead of
  hardcoded 650/300/750ms. He thinks before his first tile, pads
  between tiles with jitter, and holds the finished word on screen
  (~1.5–2.8s) before submitting so you can actually read it.
  Sleepy is slowest, cozy middling, zoomies still the quick one —
  just no longer instant.
- ADD: Missteps. Per word Coco has a mood-scaled chance (zoomies
  20% … sleepy 45%) of stepping on a wrong tile — always a real
  NEIGHBOR of his previous tile, so it reads as a paw slip, not a
  glitch. He pauses ~0.8–1.4s, deselects it (real deselect sound),
  and continues with the right tile. Long words (5+) can get a
  rare second slip. The chosen word and final score are unchanged
  — missteps are theater, not handicap.
- Net effect: a 5-letter cozy word now takes ~7–10s instead of ~4.

================================================================
SPELLCOCO v45 — A CALMER FRONT DOOR + A DICTIONARY THAT KNOWS "OK"
================================================================

CHANGELOG v44 → v45 (Shawn's mobile feedback + dictionary upgrade):
- CHANGE: Start screen de-boxified. Advanced sections (Game
  Settings, Multipliers, Long Word Bonus, Dictionary & Words)
  now live in collapsible <details> accordions under the Start
  button — first paint is just mode + players + Start. Dashed
  boxes are gone; panels use a soft tint instead of borders.
- FIX: iPhone could pan the start screen left–right. Root cause:
  .modal-content{max-width:min(92vw,560px)} ignores .modal's
  20px side padding, so under ~500px wide the card was wider
  than the padded flex container (92vw+40px > 100vw) → sideways
  scroll. Now max-width:min(100%,560px) (100% respects the
  padding) + overflow-x:hidden + file inputs clamped to 100%
  (their intrinsic width was a second offender).
- CHANGE: dictionary.txt upgraded TWL06 (178,696 words, 2006) →
  NWL2023 (196,601 words) — adds OK, EW, ZEN, VAX, DOXING,
  YEET and ~20k other modern words Keith & Shawn kept missing.
- ADD: custom_words.txt seeded with the 11 house words NWL2023
  still lacks (GOONER, SIZZ, UNTAX, LAWYERESS, FOVEATION, …).
- ADD: Cloud word check (Dictionary section, default ON). If a
  submitted word isn't in the local list, the game asks
  dictionaryapi.dev (already used for definitions); real words
  are accepted, auto-added to custom words, and broadcast to
  the opponent in online games. Offline → graceful "couldn't
  check" message, nothing breaks.
- FIX (latent): selectLWPreset() stripped .active off the Game
  Mode and mood buttons because they shared .lw-preset-btn.
  They now use .choice-btn (same look, no interference).

================================================================
SPELLCOCO v44 — COCO GETS A SHELF + THE iOS BLEED, ACTUALLY FIXED
================================================================

CHANGELOG v43 → v44 (Shawn's iPhone, round 2):
- FIX: "What is Coco resting on?" On phones he floated 4px above
  the grid. His lounge now overlaps the grid frame's top border
  by ~8px (bottom:-58px vs the 50px gap) so he visibly lies ON
  the frame — same way he's always lain on the action zone's
  edge on desktop (which is unchanged).
- FIX: The iOS bleed survived v43's explicit rows because the
  real bug is WebKit resolving the grid's height:100% against
  the WRONG box of an aspect-ratio-sized parent (border-box vs
  content-box → overflow by exactly padding+border, ~13px —
  matches the screenshots). v44 removes percentage height from
  the equation entirely: aspect-ratio:1/1 now lives on .grid
  itself (width-driven, definite height, 1fr rows resolve
  against it) and .grid-frame simply wraps its content —
  uniform padding keeps the frame square. Desktop pixels are
  identical; no engine has to resolve % inside aspect-ratio.

================================================================
SPELLCOCO v43 — COCO MOVES IN WITH THE NAMES + GRID FITS ITS FRAME
================================================================

CHANGELOG v42 → v43 (both from Shawn's iPhone feedback):
- CHANGE: Lounging Coco (the turn indicator) is re-anchored to
  the PLAYER BAR instead of the action zone. On phones the
  action zone sits below the grid, which left him stranded far
  from the names he's supposed to point at. He now lies right
  beneath the active player's card on every layout (a
  .player-bar-wrap wrapper provides the anchor so updateUI's
  innerHTML rebuild of #player-list can't wipe him). Desktop
  geometry is pixel-identical: the 40px gap above the action
  zone is the same spot he always occupied.
- FIX: The board could overflow its frame on iOS ("grid doesn't
  fit the border"). Root cause: .grid never declared row tracks
  — columns were repeat(5,1fr) but rows were IMPLICIT
  (content-sized + stretch), and WebKit sizes those differently
  than Blink. Now grid-template-rows:repeat(5,1fr) with
  min-width/min-height:0 on tiles — the 5×5 board mathematically
  cannot exceed the square frame on any engine.

================================================================
SPELLCOCO v42 — GUESTS GO ONLINE + PHONES STOP CLIPPING
================================================================

CHANGELOG v41 → v42:
- ADD: Online guest seats. Host AND joiner each pick Keith /
  Shawn / Guest (editable name, default "Coco's Guest") in
  their panel. The side messages now carry real names; each
  end shows "…is playing as X". If both pick the same name the
  host dedups (second becomes "Name 2") and the start message
  carries the joiner's FINAL identity (guestName) so index
  lookup never breaks. Joiner auto-complements (host took
  Shawn → you default to Keith) until they pick explicitly.
  Guest games online stay unrecorded (same rule as local).
- FIX: Phone / PWA layout (Shawn's iPhone screenshots). The
  page was locked to viewport height with overflow:hidden, so
  the square grid overflowed its flex slot, drew OVER the
  action zone, and everything below the fold was clipped
  unscrollably. ≤839px now scrolls naturally (body height:auto,
  overflow-y:auto, .grid-panel flex:none) with safe-area
  insets for the notch/home bar (viewport-fit=cover).
- FIX: color-scheme:dark declared (meta + CSS) so mobile
  browsers' force-dark/auto-dark never inverts the cream tiles.
- CHANGE: oppName() now reads the real opponent name from the
  game (or the announced side) instead of assuming Keith/Shawn.

================================================================
SPELLCOCO v41 — COCO PLAYS: SOLO MODE + COCO'S GUEST
================================================================

CHANGELOG v40 → v41:
- ADD: Single player "vs Coco" mode. Coco himself takes the
  second seat (🐾 ginger name — orange stays Coco-only) and
  plays real words using the same trie solver, with three moods
  picked at setup: 😴 Sleepy (gentle little words), 😺 Cozy
  (a fair match), 🌪 Zoomies (near-purrfect play). His word is
  traced tile by tile on the board so you can watch him play.
  He collects the treats he lands on (end-of-game bonus, like
  everyone else) but never uses abilities — he's a cat.
  Coco Attack is hidden in solo (he won't attack himself).
- ADD: Coco's Guest. In Local mode either seat can be Keith,
  Shawn, or a Guest with an editable name (default "Coco's
  Guest"). Guest games are friendly matches — they never touch
  the all-time Keith–Shawn record. Solo can also be played as
  a guest. Online stays Keith & Shawn (side-pick protocol is
  name-based).
- ADD: vs-Coco record on the start screen (humans vs Coco),
  stored separately — bestWord / longestWord stay
  Keith–Shawn-only so the duel record stays pure.
- FIX: Input is hard-locked while Coco plays (taps, drags,
  abilities); also closes a drag-select leak on the opponent's
  device online.

================================================================
SPELLCOCO v40 — DE-BOXITIS: ONE HERO, THREE PANELS, QUIET CHROME
================================================================

CHANGELOG v39 → v40 (STRUCTURE ONLY — no font size, weight, tile,
or multiplier badge dimension changed anywhere; Keith's
accessibility sizes are untouched and every interactive surface
keeps a hard >=3:1 boundary):
- CHANGE: Header de-boxed. Logo + Coco's face float on the
  starfield (like the round indicator always has) over a thin
  flag underline. Coco's face grows 38px → 56px (44px mobile).
- CHANGE: ONE action zone replaces three boxes (word area +
  controls + Coco attack). Inside: word display, Submit/Clear,
  the neutral ability trio (Shuffle/Swap/Hint), then a hairline,
  then Coco's section — 🌪 Zoomies (current player) and Coco
  Attack (opponent). Orange = "Coco does something."
- CHANGE (v40.1): Coco's two rows are twins now — Zoomies got the
  Attack row's anatomy: dashing-paw icon · "{name}'s Zoomies!"
  (current player, mirroring the Attack's "{name}'s") · orange
  cost button ("5🐟 ZOOM!"). No more lone pill button + caption.
- CHANGE (v40.2): Online, each device shows only its OWN move:
  the active player sees Zoomies, the opponent sees Coco Attack.
  Local pass-and-play still shows both rows (shared screen).
- ADD: Lounging Coco lies along the action zone's top edge —
  drawn from Shawn's reference photos (white blaze, chest bib,
  mittens, faint stripes, plush build; deliberately saturated
  "game Coco" ginger). He lounges on the ACTIVE player's side
  and ambles across on turn change, head always facing inward.
  He replaces the old ears as the turn indicator. Instant jump
  under prefers-reduced-motion; aria-hidden (decorative).
- CHANGE: Dictionary Check and Long Word Bonus are quiet
  collapsible rows (no boxes) — lookup tools, not gameplay.
- CHANGE: Round paw pips bigger & brighter (16/20px; future pips
  cream @60% opacity, were dim grey @40% — hard for Keith).
- CHANGE: 🐱 emoji retired (didn't look like him): removed from
  titles/overlay, 🐾 in toasts/history.
- Mobile order: grid sits directly under the player bar; the
  action zone follows (Submit/abilities near thumbs); quiet
  rows last.
- Design research: NN/g Gestalt proximity & common region;
  low-vision guidance (TetraLogical, AFB) says keep >=3:1
  boundaries on interactive components at high zoom — hence
  "fewer, stronger boxes" rather than "no boxes."

================================================================
SPELLCOCO v39 — KEITH'S CUT: NO SPOILERS, CRYSTAL TREATS, ZOOMIES
================================================================

CHANGELOG v38 → v39:
- CHANGE: Best-word reveal de-spoilered (Keith's call — the word
  was often still playable by the next player). Mid-game, the
  toast and history modal show only the SCORE ("⭐ Best possible:
  41 pts"). Full words are revealed in the end-of-game recap,
  where tap-to-define still works. Hint unchanged (paid, current
  player only).
- CHANGE: Treats are high-contrast purple crystals on tiles again
  (deep purple ≈6:1 on cream vs the ginger fish's ≈1.8:1 — hard
  for Keith to see and to parse). Gold crystal on selected/path
  tiles. Inline treat icon is a brighter crystal for dark panels.
  Still called Coco Treats everywhere in text.
- ADD: 🌪 Coco Zoomies ability (default 5 treats, configurable):
  Coco tears across the board — ALL 25 letters rerolled,
  multiplier types kept but repositioned, treats re-scattered.
  Confirm modal like Shuffle; online-safe (guest sends action,
  host validates). Orange-themed: orange now strictly means
  "Coco does something" (Attack + Zoomies).
- FIX: Removed the ginger ears on the active player card — they
  read as two arrows pointing at the round paw pips.
- FIX: "＋ Add" custom-word button no longer overflows the start
  modal (input min-width:0).
- FIX: Idle "--" timer placeholder hidden; the timer appears only
  while a Coco timer is running.

================================================================
SPELLCOCO v38 — CUSTOM WORD CONSENT + EXPORT
================================================================

CHANGELOG v37 → v38:
- ADD: Online custom-word consent. Adding a word while connected
  now sends a request; the opponent gets an Allow/Refuse modal
  with a tap-to-define link so they can rule fairly. On Allow,
  the word is permanently saved on BOTH devices and instantly
  playable. On Refuse, the proposer gets a 🙀 veto toast.
  Local pass-and-play keeps instant adds (you're both right
  there). No global database exists — each pair of players
  curates only their own shared dictionary.
- ADD: "Export my custom words" button downloads the device's
  custom list as spellcoco-custom-words.txt (for backups, or to
  merge into the repo's custom_words.txt).

================================================================
SPELLCOCO v37 — QA: DEFINITION LAYERING + BEST-WORD DEFINITIONS
================================================================

CHANGELOG v36 → v37:
- FIX: Definition popup opened BEHIND the score history modal
  (both z-index 100, DOM order put history on top). The define
  modal is now z-index 200 — always above history and recap.
- ADD: Best words are now tap-to-define everywhere: the "⭐ best:"
  entries in player history, the "board best:" labels in the
  recap, and each player's own Best word in the recap stats.
  Great learning opportunity (Shawn's words).
- VERIFIED: Online Coco Attack gating — the ACTIVE player's
  device has the button disabled (and guests get a friendly
  refusal even if forced); only the non-active opponent can
  fire it, host- and guest-side both validated by the host.

================================================================
SPELLCOCO v36 — ONE COCO, MANY PAWS
================================================================

CHANGELOG v35 → v36:
- CHANGE: De-duplicated Coco's face. The v35 logo mark is now the
  only face in the UI. The old hand-drawn cat next to Coco Attack
  is replaced by a tilted ginger paw.
- CHANGE: Coco Attack overlay is now a giant paw that slams down
  (pawSwat animation) instead of the old cat pop-in.
- ADD: Round progress pips are now tiny paw prints (same bi-flag
  colors as before — blue done, gradient current, dim future).
- ADD: The active player's card grows a pair of ginger ears
  peeking over its top edge — Coco watches whoever's turn it is.

================================================================
SPELLCOCO v35 — REMATCH, HINTS & PALETTE 2.0
================================================================

CHANGELOG v34 → v35:
- ADD: Rematch button on game over (local instant; online host
  re-deals for both; guest sends a rematch request).
- ADD: Hint ability (💡, configurable treat cost, default 2):
  first two letters + length of the board's best word. Online:
  host validates and deducts; hint shown only to the asker.
- ADD: Efficiency % in recap (score vs best-possible words).
- ADD: Tap-to-define words (dictionaryapi.dev) in history, recap,
  and the dictionary checker.
- ADD: Online resume — host's unfinished online games autosave
  and resume when the opponent rejoins a fresh room.
- ADD: Synced win tracker — devices merge all-time records on
  connect.
- ADD: PWA manifest + Coco icon (installable on phones).
- DESIGN (Palette 2.0): one ginger ramp everywhere; warm amber
  nebula anchors Coco in the sky; tile faces warmed to his cream
  chest. 60-30-10: night sky / bi triad / Coco accents.

================================================================
SPELLCOCO v34 — COCO BLEND  (ginger accents on the bi-flag base)
================================================================

CHANGELOG v33 → v34:
- DESIGN: Blended Coco palette. The bi pride flag (Keith's pick)
  stays structural: background, buttons, multipliers, grid frame,
  tile colors, logo shimmer — all unchanged. The gold accent
  family is re-pointed to Coco's ginger tabby coat (scores,
  rewards, ×3W badge, winner banner, long-word chips).
- CHANGE: Gems are now Coco Treats — a hand-drawn ginger fish
  kibble (cream on selected tiles). All labels, costs, toasts,
  history and recap updated. Valid-word score preview is now
  Coco's eye green.
- ADD: Six faint ginger paw prints drift among the pride
  particles in the starfield.
- FIX: Online status pill clipped ("connected" cut off next to
  the logo). Now a compact icon-only pill (🌐 / ⚠) with the full
  status in its tooltip/aria-label — header fits at any zoom.
- A11Y: Modals capped to 92vw so OS/browser scaling never
  pushes content off-screen; treat icon carries aria-label.

================================================================
SPELLCOCO v33 — ONLINE PLAY + PERSISTENCE  (renamed for Coco 🐾)
================================================================

CHANGELOG v32 → v33:
- REBRAND: SpellCraft → SpellCoco, in loving memory of Coco.
- ADD: Online 2-player mode via PeerJS (WebRTC). Host gets a
  4-letter room code; guest joins from any device. Host is
  authoritative: guests send actions, host broadcasts state.
- ADD: Settings persistence (localStorage). All start-screen
  options are remembered between sessions.
- ADD: In-game custom word editor. Add words on the start screen
  or straight from a rejected word during play. Saved locally,
  merged with custom_words.txt and any uploaded file.
- ADD: Resume after refresh (local mode). Game state autosaves;
  reopening the page offers Resume / Discard.
- ADD: All-time win tracker — Keith vs Shawn record, best word,
  longest word. Shown on start screen and game-over recap.
- ADD: Best-word reveal. After each submit, a Boggle-style trie
  solver finds the best possible word that was on the board;
  shown as a toast, in player history, and in the recap.

================================================================
SPELLCRAFT v26 — PLAYER HISTORY + ROUND PIPS
================================================================

CHANGELOG v25 → v26:
- ADD: Player history modal. Tapping either player card opens a
  modal showing every word they've played, organised by round,
  with per-word score, word/long-word multiplier info, and gems.
  A running total row at the bottom shows words played + total pts.
  A subtle "▸ history" cue on the player name communicates the
  card is tappable. Modal closes with ✕ Close button.
- ADD: Round progress pips. Below the round text, five dots show
  completed (blue), current (pulsing gradient, slightly larger),
  and upcoming (outlined dim) rounds at a glance.
- ADD: Round indicator text enlarged significantly
  (clamp 0.78rem → 1rem–1.2rem) for accessibility.

CHANGELOG v24 → v25:
- FIX: Round indicator removed from header entirely. It now lives
  as its own slim row (.round-indicator-row) between the header
  and the player bar. Styled as shimmer gradient text (✦ ROUND 1/5 ✦)
  matching the logo treatment — no box, no border, no crowding.
  Header is now cleanly: logo (left) + sound controls + timer (right).

CHANGELOG v23 → v24:
- FIX: Header horizontal overflow / scroll. Root cause: badge +
  mute + slider + timer in header-right was wider than the
  available space on mobile. Fixed three ways:
  (1) Round badge is now compact — smaller font, less padding,
      white-space:nowrap so it never wraps to two lines.
  (2) Volume slider is hidden on mobile (≤839px). Mute button
      still present; slider only appears on desktop where there
      is room for it.
  (3) body gets explicit overflow-x:hidden and header gets
      overflow:hidden as hard stops against any future bleed.
- FIX: header-right gap reduced 12px → 8px and gets min-width:0
  so flex children can compress rather than overflow.

CHANGELOG v22 → v23:
- ADD: Turn switch overlay. After each turn ends (mid-round),
  showRoundOverlay() fires with "Name's Turn" as title and
  "Round N of 5" as subtitle. Reuses existing infrastructure.
  Does not fire at round boundaries (endRound already covers
  the transition there).
- FIX: Header crowding. Round badge moved from standalone
  centre position into header-right, so header is always
  logo (left) + [badge · sound · timer] (right).
- FIX: Gems toast now fires with a 600ms delay so it lands
  cleanly after the submit feedback settles.
- POLISH: Full sidebar padding audit. Tightened header,
  player cards, word area, controls, dict checker, lw-ref,
  and reduced side-panel gaps. No elements removed or
  collapsed — just spacing dialled back to reduce scrolling.

CHANGELOG v21 → v22:
- FIX: Redundant gem scramble on last turn of round 1. Previously
  randomizeGems() fired even when the turn was about to call
  endRound() → upgradeMultipliersForNewRound() → replenishGems(),
  which immediately overwrote the scramble. Now the check gates on
  turnIndex < players.length-1, so scramble only fires between
  turns within round 1, never on the closing turn.
- ADD: In-game Long Word Bonus reference. A collapsible <details>
  element appears in the side panel once the game starts, populated
  from the exact tiers configured at setup. Tap to expand; each
  tier renders as a compact gold chip. A blue "Stacking" chip
  appears when stacking mode is active. Mobile-friendly — no
  layout impact when collapsed.

CHANGELOG v20 → v21:
- ADD: Coco Attack enable/disable toggle on the start screen.
  When disabled, the coco zone is hidden for the entire game.
  CONFIG.cocoAttackEnabled drives the in-game visibility.
- ADD: Round 1 Gem Chaos. After each player submits their word
  in round 1 (and only round 1), gem positions are randomized
  via Fisher-Yates before the next player sees the board.
  A toast "💎 Gems shifted!" confirms the scramble.
  Normal gem replenishment still runs first so the count is
  correct, then positions are shuffled. From round 2 onward
  gems behave exactly as before.

CHANGELOG v19 → v20 (grid-only):
- FIX: Tile letters now use Fredoka (v17's display face) as
  primary, Atkinson Hyperlegible as fallback. Atkinson remains
  the font for every other surface — player cards, word display,
  buttons, modals, dict checker — because Keith likes it there.
  Fredoka's chunkier strokes just read bigger on the tiles.
- FIX: Tile NUMBERS were 0.42em / 700 / 70% opacity in v19 —
  restored to 0.62em / 900 / 100% opacity with a subtle dark
  pill behind them (matches v17). The v17 number treatment was
  what worked for Keith.
- FIX: Removed the -0.02em letter-spacing that was squeezing
  the tile letters. They breathe now.
- FIX: Letter font-size nudged up to clamp(1.9rem,7.3vmin,3.2rem)
  to account for Fredoka's slightly smaller x-height vs Atkinson.
- ADD: White-highlight text-shadow on tile letters — matches v17
  and adds a subtle letterpress pop.
- Swap modal tiles also switched to Fredoka so the swap picker
  matches the main grid.

EVERYTHING ELSE IS IDENTICAL TO v19:
- Bi flag palette, flag-gradient border on grid frame
- Starfield + aurora nebulae + pride-colored particles
- Tricolor rail on active player card
- Shimmering logo / valid word / winner banner
- Reduced-motion support
- All game logic, settings, abilities, recap

FROM v19 (unchanged):
================================================================

Bi flag palette drives the visual grammar of the game.
Atkinson Hyperlegible typography + AAA contrast preserved from v18.
Gameplay, scoring, settings, abilities are 100% unchanged.

COLOR GRAMMAR:
  Pink   → active / casting / gems (the "now" of a spell)
  Purple → the bridge, secondary accent, the bi middle
  Blue   → the path / the trail / the "already walked"
  Gold   → rare & triumphant (×3W, scores, crown)
  Each spell traces a literal pink-tipped, blue-tailed streak —
  the flag drawn letter by letter across the grid.

MULTIPLIER PALETTE:
  ×2L = blue,   ×3L = purple,   ×2W = pink,   ×3W = gold
  (three flag stripes + gold reserved for the rarest mult)
================================================================

CHANGELOG v18 → v19:
- CHANGE: Palette is now the bisexual pride flag — pink (#ff3d92),
  purple (#b469e0), blue (#4d80ff) — all brightened against dark
  cosmos bg to pass WCAG AAA contrast at 7:1+.
- RESTORED: Starfield atmosphere (callback to the original
  Discord Spellcast). Now multi-colored: white, pink, purple,
  blue stars; bi-colored drifting shimmer particles; three
  aurora nebulae in the flag colors that slowly breathe.
- CHANGE: Selected tile → hot pink with white letter, pink glow.
  Path tiles → blue with white letter. Default → cream with
  deep cosmos ink. A word-in-progress now visually reads as
  the bi flag painted across the grid.
- CHANGE: Grid frame has a real pink→purple→blue gradient
  border with a slow 6s breathing glow (respects
  prefers-reduced-motion).
- CHANGE: Active player card gets a literal 3-block flag rail
  across the top — hard-edged pink | purple | blue stripes.
- CHANGE: Logo, valid word display, round overlay, celebration
  banner, and winner banner all sweep an animated pink→purple→
  blue gradient via background-clip:text + background-position
  animation.
- CHANGE: Multipliers realigned to the flag: ×2L blue, ×3L
  purple, ×2W pink, ×3W gold (gold = rarest).
- CHANGE: Gems are now bi-purple crystals (they were a pink-
  magenta before). Gem indicators on selected/path tiles flip
  to gold so they stay visible on the hot-pink / blue tile.
- CHANGE: Submit button becomes pink→purple gradient; Start
  Game button becomes the full flag gradient.
- ADD: Reduced-motion media query that freezes background
  atmosphere, logo shimmer, and frame pulse for anyone who
  needs it.
- UNCHANGED: All JS gameplay (mechanics, settings, abilities,
  shuffle logic, Coco Attack, scoring, recap, dictionary,
  custom word lists). Identical to v17/v18.
```
