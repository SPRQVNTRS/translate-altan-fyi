---
name: translate-public-surface-contract-m184
description: The post-M184 public surface of translate-altan-fyi, and where each gate actually lives
metadata:
  type: project
---

After M184 the app is invite-only, and the gate is keyed on the REQUEST:
`/` and `/search` are two route ids over `app/routes/search.tsx`, so the rule
sits at the top of that one loader (empty `q` is the public landing page, any
other `q` calls `requireAccountSession`). Screens with no public half are gated
by nesting under `app/routes/_app.gated.tsx`, which carries `accountMiddleware`,
NOT `authMiddleware` (that one also demands a linked `users` row, which almost
no account has). `/healthcheck` is registered at the top level of
`app/routes.ts`; the three `/legal/*` pages sit under `routes/_public.tsx` and
export no `loader` and no `middleware`. `/account`, `/sync/login`, `/sync/setup`
and `/offline` stay public.

**Why:** a path-keyed rule once gated `/search` and left `/?q=`, the primary
URL, wide open.
**How to apply:** never describe or gate this app by path. `ACCOUNT_BOOTSTRAP_TOKEN`
is read at MODULE LOAD in `app/lib/e2ee/e2ee-context.server.ts`, so it must be
set before first boot. Related:
[[translate-a-public-surface-test-needs-a-liveness-case]].
