# Review handoff: remaining online correctness work

The audit's patch implemented findings **3, 4, 5, 6, 7, 8, 11, 12 and 13** and
left **1, 2, 9 and 10** with the designs below. The v71 review round shipped
narrower fixes for those four (tests in `tests/sync.test.mjs`):

| Finding | What shipped in v71 | Still deferred from the design below |
| --- | --- | --- |
| 1 | Room revision + per-seat "foreign write" marker; a `move`/`newgame` whose `base` predates another seat's write (or a Coco Attack) is refused as `reject{stale}` with the current state. Compare-and-swap, not a rewrite of the protocol. | Server-computed scoring / validated actions (a modified active client can still invent a score); per-operation idempotency receipts (duplicates are still handled by the turn check + echoed `q`); selection-only messages. |
| 2 | The tracked move is persisted in `localStorage` per room, restored on welcome, re-pushed with its original `base`, and shown once acked; a stale refusal tells the player. | IndexedDB outbox with multiple queued operations; same-seat multi-tab serialization. |
| 9 | `stats` is sent on every async welcome and peer arrival. | Result-ledger merge: counters are still merged by maximum, so disjoint device histories under-count. |
| 10 | Every game carries a match id (`state.id`, `gameover.gid`); recap dedup is per match, legacy id-less states keep the room-level rule. | Server-side completion events and a catch-up endpoint. |

The rest of this document is the audit's original design proposal, kept for
the deferred items.

## Implemented scope and review points

| Audit finding | Proposed correction | Review boundary |
| --- | --- | --- |
| 3 | Stop dispatch after reserved `__a` operations and validate allowlisted side messages | Does not make the relay authoritative over legal scores or moves |
| 4–5 | Separate deserialization from `activate()`; restore the countdown only on the timer authority; persist local ticks | Offline time pauses at the last saved/received second; no server deadline or wall-clock expiry is introduced |
| 6 | Both word-list downloads and body reads have a 20-second deadline; index fallback and local words; mark ready after building | Healthy downloads share one rebuild; a hung optional list may still delay full indexing up to 20 seconds |
| 7 | Filter imported base words to A–Z, 2–25 characters; custom words to 2–15; guard solver lookup | Invalid entries are excluded; the UI describes accepted format |
| 8 | Let eligible unknown words reach cloud assist; associate replies with their game, turn and selection | Existing cloud-word/consent policy is retained |
| 11 | Check player/board/selection/timer/recap shape and encoded size before storage | This is input validation, not proof of adjacency, scoring, authorization or match progression |
| 12 | Native board/swap buttons, roving focus, keyboard selection, swap dialog focus handling | Not a complete screen-reader/mobile accessibility audit; other dialogs still merit review |
| 13 | Reserve suffix space and check the result differs | No change to seat authentication |

The wire envelope remains unchanged. Client/Worker source can be reviewed
independently. The Worker tests accept the existing serialized state shape,
but real two-client staging checks are still needed before a maintainer elects
to deploy anything. A future test environment must be isolated to SpellCoco.

## Findings 1 and 2: revisions, idempotency and durable pending operations

Implement these together. Simply saving `pendingMove` makes stale replay more
reliable and increases the rollback risk.

Suggested room storage:

```text
current: { protocolVersion: 2, matchId, revision, state, config }
operations: { (matchId, seat, operationId) -> acceptedRevision, result }
```

Suggested client operation envelope:

```text
{ type: '__a', op: 'move', protocolVersion: 2,
  matchId, operationId, expectedRevision, action }
```

1. Persist the operation in an IndexedDB outbox before marking a move saved.
   Use a stable random operation ID, scoped to room/match/seat. Store the
   last authoritative state separately from the optimistic display state.
2. In a serialized/transactional room mutation, look up the operation ID
   **before** turn checks. A duplicate returns its original acknowledgement
   without applying it again, even if the turn has moved on.
3. For a new operation, check match ID, expected revision, seat and legal
   action. Increment the revision and store both the result and idempotency
   receipt atomically. Include authoritative match/revision in every ack,
   reject, welcome and state event.
4. Send selections through a separate ephemeral message carrying tile IDs,
   match and turn revision. It must not replace scores, treats or timers.
   Coco Attack, time extensions, rematches and game completion must use the
   same ordered mutation path as moves.
5. Restore the outbox before reconnecting. Remove only the matching operation
   on a confirmed result. A stale-revision rejection should retain the user's
   intended action for an explicit reconciliation state; never blindly
   replay an old full snapshot or pretend it was accepted.
6. Serialize same-seat browser tabs and queue dependent operations after
   acknowledgement. A single replaceable `pendingMove` slot is insufficient
   for multiple offline actions.

First choose whether v2 sends validated actions or temporary state deltas.
Actions are preferable for integrity: the server can compute scores and
charge abilities. A compare-and-swap check alone prevents stale overwrite
but does not prevent a modified active client from inventing a score.

Migration must be explicit: assign a match ID/revision once to legacy stored
rooms, advertise capabilities at welcome, and prevent v1 clients from writing
unversioned snapshots into a v2 match. Decide how legacy clients are prompted
to reload and how existing pending actions are reconciled. Bound retained
operation receipts without forgetting IDs that clients may still retry.

Required tests:

- Drop A's ack, accept B's turn, replay A: B's score and round remain intact.
- Delay a selection while Coco Attack commits: the attack and cost survive.
- Refresh offline after a move: restore it once; reconcile without rollback.
- Reconnect with queued move + rematch; reject old match IDs and late acks.
- Simultaneous tabs, hibernation/restart, storage failure between writes,
  duplicated messages and reordered deliveries.

## Findings 9 and 10: results ledger and statistics reconciliation

The normal async path receives `stats` but does not send it. Adding the missing
send on welcome/peer reconnect would improve exchange, but the current maximum
counter merge cannot combine disjoint games correctly and room-based dedup
cannot distinguish rematches. Treat a send-only patch as partial, not a fix.

1. Create an immutable completion event keyed by match ID and participants,
   containing final scores, winner/draw and the statistics contributions used
   by the UI. Commit it once with the terminal game revision.
2. Expose authorized room result summaries since a cursor so a device that
   was absent for an entire rematch can catch up. Decide retention, historical
   import and cross-room access before designing a global account endpoint.
   Seat names are not strong authentication.
3. Persist applied result IDs on each client. Merge result sets by ID and
   derive counters, best-word records and other metrics from unique events.
   Keep local-only/solo games in a separate namespace. Do not add aggregate
   counters or take maxima when the underlying game sets may differ.
4. Migrate legacy aggregate totals as a labelled baseline because missing
   historical match IDs cannot be reconstructed honestly. Prevent already
   counted legacy endings from being imported a second time.

Required tests: repeated ending delivery counts once; an entire missed rematch
counts after reconnect; disjoint device histories union correctly; draws,
guest games and solo games follow existing tracking policy; clearing device
storage and multiple reconnects do not inflate server-backed totals.

## Follow-on maintainability work

Extract rules, transport, persistence and rendering into modules after the
protocol change has tests. Replace per-game retained DOM listeners with a
single binding or explicit teardown. Decouple `updateUI()` from full-state
network writes. Add two-browser integration tests and mobile suspension/push
checks against a dedicated SpellCoco test environment.
