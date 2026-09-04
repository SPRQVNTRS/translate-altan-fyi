---
name: translate-a-public-surface-test-needs-a-liveness-case
description: A test asserting a route is public passes on an instance with no gate at all; add a contrast case
metadata:
  type: feedback
---

A test that asserts "this route answers an anonymous request" is green on an
instance where every gate was deleted. Pair it with one case that runs the real
gate (`accountMiddleware`) over an anonymous request and asserts the 302 to
`ACCOUNT_LOGIN_PATH`.

**Why:** the failure mode this milestone guards against is a gate that stopped
working, and a public-surface suite is exactly the suite that cannot see it.
This is the same rule as "prove the measurement chain before trusting a zero".
**How to apply:** in `tests/integration/public-surface-*.test.ts` the shape is:
walk the real `app/routes.ts` config for the nesting, call the loader for the
answer, then run the gate for contrast. Importing `app/middleware/auth` opens
the app pool, so `after()` must `await poolInitialized` then `closePool()`, and
the case declares `DB_HOST`. Related:
[[translate-public-surface-contract-m184]],
[[translate-altan-fyi-integration-self-skip-guard]].
