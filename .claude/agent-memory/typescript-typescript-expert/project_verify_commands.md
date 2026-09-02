---
name: translate-altan-fyi-verify-commands
description: The verification commands that work in translate-altan-fyi, and what the pre-push gate does and does not run
metadata:
  type: project
---

In `translate-altan-fyi`, verify with:
`toolbox run -c ts-dev env CI=true pnpm lint | typecheck | test:unit`.

- `pnpm typecheck` is `react-router typegen && tsc` (tsc has `noEmit` in tsconfig).
- `pnpm test:unit` is `node --import tsx --test "tests/unit/**/*.test.ts"` — it runs
  ONLY `tests/unit/`. Tests are `node:test`, not vitest.
- `.githooks/pre-push` is the only gate: lint → typecheck → unit → content:validate → build.
  It deliberately excludes `tests/integration/`, whose cases all self-skip unless
  `TEST_API_KEY` is set and a server listens on :3456.

**Why:** there is no cloud CI test runner by workspace policy, so a local green
push IS the signal.
**How to apply:** run all three before reporting any TypeScript work complete here.
Related: [[translate-altan-fyi-integration-self-skip-guard]], [[oxlint-anti-slop-patterns]].
