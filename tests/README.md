# Regression tests

Run with Node 22 or newer, from the repository root:

```sh
node --test tests/*.test.mjs
```

No package installation or network access is needed. `helpers.mjs` loads the
actual inline JavaScript and Worker module into deterministic DOM, timer,
storage and socket doubles. Tests cover all thirteen findings from the
[v70 audit](../docs/audit/2026-09-12-v70.md) — `sync.test.mjs` holds the
revision / durable-pending-move / statistics / per-match recap cases — plus
related compatibility and failure paths. The GitHub checks workflow runs this
command.

The doubles do not implement browser layout, native event synthesis, real
WebSockets, Durable Object transactions, push delivery or iOS suspension.
They exercise the relay's revision check with in-memory storage, not real
Durable Object transactions, two real browsers, or push delivery. The
[follow-up document](../docs/audit/proposed-follow-ups.md) records what was
shipped for findings 1, 2, 9 and 10 versus the fuller designs it proposed.

Manual localhost checks performed for this proposal:

- Spell ONE with Enter/Space and arrow keys; Backspace removes E and focus
  stays on that tile. Resubmit ONE for four points and advance to Shawn.
- Open Swap using the keyboard; A receives focus. Shift+Tab wraps to Cancel
  and Tab returns to A. Selecting A changes the tile, deducts three treats,
  and restores focus to the board.
- One pointer click selects one letter without being undone by a second
  handler invocation.

To reproduce the original audit against an unmodified v70 checkout:

```sh
node tests/reproduce-v70.mjs /path/to/v70-checkout
```

This separate script asserts the presence of 13 defect scenarios. A
`REPRODUCED` line is evidence of a bug, not a passing correctness test. It is
deliberately excluded from the regression-test glob. The tested revision is
`106203a463eefc8254c631fc240614c452896b91`. Keyboard access was audited separately
in the browser. `SPELLCOCO_TEST_ROOT` can also point the regression suite at
another source checkout for comparisons.
