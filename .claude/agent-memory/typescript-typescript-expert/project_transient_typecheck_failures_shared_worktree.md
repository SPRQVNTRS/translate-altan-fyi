---
name: transient-typecheck-failures-shared-worktree
description: In translate-altan-fyi a typecheck failure naming another agent's files is often a mid-write snapshot; re-run before diagnosing or editing
metadata:
  type: project
---

When several agents work this repo at once, `pnpm typecheck` can fail on files
you do not own, and the failure can be a MOMENT-IN-TIME artifact rather than a
real error. Seen in one session: `Module '#drizzle/schema' has no exported
member 'enrichments'` plus `Cannot find module './+types/api.enrichment.
$headwordId'`. A `grep` for my own route line in `app/routes.ts` came back
empty, and a `sed` of the same line numbers seconds later showed the line
present and an md5 that was then stable. Nothing had been lost. Re-running
typecheck went green with no edit at all.

**Why:** `react-router typegen` reads `app/routes.ts` and emits `+types/*`. If
another agent is rewriting that file, typegen sees a truncated tree and silently
omits route types, so the error surfaces in YOUR file while the cause is in
theirs. The Drizzle barrel behaves the same way while `drizzle/schema.ts` and
`drizzle/schema/*.ts` are being split.

**How to apply:** before diagnosing a typecheck error that names a file outside
your ownership list, re-run `pnpm typecheck` once, and confirm the suspect file
is stable with two `md5sum` reads a couple of seconds apart. Only then treat it
as real. Never "repair" another agent's file from a single red run, and never
re-add your own line until you have confirmed it is genuinely gone.

Related: [[translate-altan-fyi-stack]]
