---
name: super-is-a-top-level-layout
description: /super/* is a top-level layout stacking accountMiddleware then superadminMiddleware, and /super is a hop to /super/llm
metadata:
  type: project
---

`app/routes/_super.tsx` is a TOP-LEVEL layout since M189. It nested under
`routes/_auth.tsx` until then, and that file is gone with the `users` table.

**Why:** `superadminMiddleware` only reads `accountContext`; it sets nothing. On
its own it refuses every caller, so `_super.tsx` exports
`[accountMiddleware, superadminMiddleware]` in that order. A non-superadmin
lands on `/account`.

**How to apply:** any new operator screen goes inside that layout in
`app/routes.ts` and gets a `gated-layout` entry in
`app/lib/route-classification.ts`. Only two screens live there, `llm` and
`whoami-ip`, and `/super` itself is `routes/super/index-redirect.ts`, a
temporary redirect to `/super/llm`. See [[the-tenancy-is-gone-adr-0010]].
