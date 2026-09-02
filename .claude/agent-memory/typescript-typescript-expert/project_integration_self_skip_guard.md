---
name: translate-altan-fyi-integration-self-skip-guard
description: A unit test enforces that every tests/integration case self-skips on TEST_API_KEY; do not add an unguarded case there
metadata:
  type: project
---

`tests/unit/integration-tests-self-skip.test.ts` reads every `*.test.ts` under
`tests/integration/` and asserts the count of `it(`/`test(` declarations equals the
count of `skip:` options mentioning `TEST_API_KEY`. It also fails if enumeration
finds zero files.

**Why:** the pre-push gate never runs `tests/integration/`, so an unguarded case
there would be executed by nothing while the suite looks green.
**How to apply:** any new integration case needs
`{ skip: !TEST_API_KEY ? 'TEST_API_KEY not set' : false }`. If a test needs no live
server, put it in `tests/unit/` instead. Related: [[translate-altan-fyi-verify-commands]].
