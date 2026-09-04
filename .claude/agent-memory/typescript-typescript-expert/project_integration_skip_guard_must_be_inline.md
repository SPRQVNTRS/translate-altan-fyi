---
name: integration-skip-guard-must-be-inline
description: tests/integration self-skip guards are matched as source TEXT, so hoisting the guard into a shared SKIP constant fails the unit test that enforces them
metadata:
  type: project
---

`tests/unit/integration-tests-self-skip.test.ts` counts `it(` against
`/skip:\s*[^,\n]*(TEST_API_KEY|DB_HOST)/`. It reads the FILE, not the runtime
value.

**Why:** `const SKIP = !DB_HOST ? '...' : false;` plus `{ skip: SKIP }` at every
case is correct at runtime and fails the guard with "N cases but 0 guards". The
rule wants the precondition visible AT the case, because a guard behind a name
is a guard the next reader deletes without noticing.

**How to apply:** write `{ skip: !DB_HOST ? 'DB_HOST not set' : false }` inline
in every `it`, however repetitive. Related:
[[project_integration_self_skip_guard]].
