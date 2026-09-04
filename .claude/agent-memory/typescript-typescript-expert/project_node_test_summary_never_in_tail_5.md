---
name: translate-node-test-summary-never-in-tail-5
description: A spec check piping node --test through tail -5 can never see the pass line
metadata:
  type: project
---

`node --test` closes with, in this order: `tests`, `suites`, `pass`, `fail`,
`cancelled`, `skipped`, `todo`, `duration_ms`. So `... | tail -5` shows
`fail` onward and NEVER the `pass N` line, whatever the test count.

**Why:** five trailing lines are `fail`, `cancelled`, `skipped`, `todo`,
`duration_ms`. A tracker check written as `node --test ... | tail -5` with
`Expected: stdout matches /pass 1/` is unsatisfiable, not failing.

**How to apply:** report it as unsatisfiable rather than shrinking a test file
to one case to chase it, and run the same command with `tail -8` (or no pipe)
to give the real result. Note also that `/pass 1/` would match `pass 15`.
Related: [[translate-altan-fyi-verify-commands]].
