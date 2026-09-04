---
name: translate-sign-in-up-routes-m187
description: The account doors are /sign-in and /sign-up, the old sync paths are 301 hops, and the no-signup-prompt rule is dead
metadata:
  type: project
---

M189 renamed `/sync/login` to `/sign-in` and `/sync/setup` to `/sign-up`
(`app/routes/sign-in.tsx`, `sign-up.tsx`). The old paths stay forever as
loader-only 301 hops, `app/routes/sync.{login,setup}-redirect.ts`, which
PRESERVE THE QUERY STRING because an invite travels as `?invite=<token>`.
`/sign-up` exposes that token as loader data named `invite`.

The M184 rule that `/` and `/account` must never prompt for signup is REMOVED,
not softened: M184 made an account mandatory for every search, so hiding the
door was a defect. Both screens and the shell header now carry "Create account"
plus "Sign in". The header slot reads `accountHandle` from the ROOT loader,
filled by `readAccountHandleForDisplay`, which reads the signed cookie and
resolves NO token, so it costs no query and never gates anything.

**Why:** the operator could not find the way in, and the only signup link in
the app sat on the sign-in page.
**How to apply:** an account is an "account"; sync is a consequence of holding
one and is never a user-facing setup step. Related:
[[translate-public-surface-contract-m184]].
