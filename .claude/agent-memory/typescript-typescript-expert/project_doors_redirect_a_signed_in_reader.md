---
name: doors-redirect-a-signed-in-reader
description: /sign-up and /sign-in loaders redirect a resolvable session to /account with getAccountSession, not with the cookie-only display read
metadata:
  type: project
---

Both door routes carry a loader that throws `redirect('/account')` when
`getAccountSession(request)` resolves. They stay classified `public` in
`app/lib/route-classification.ts`: nobody is refused, a finished question is
answered.

**Why:** `readAccountHandleForDisplay` trusts the signed cookie without
resolving the token, so a stale or revoked session would be redirected away from
the only two screens that could end it. `getAccountSession` costs one indexed
lookup and answers `null` for exactly that reader, who then gets the form.

**How to apply:** `sign-in.tsx` had no loader before, so it needs
`import type { Route } from './+types/sign-in'`, and its doc comment saying "no
loader and no action" had to be corrected. `sign-up.tsx`'s comment calls its
loader "the one exception" that reads nothing secret; the session read was added
to that sentence rather than contradicting it. Tests:
`tests/integration/signed-in-visitor-leaves-the-doors.test.ts`, which mints a
session with `handleSignup` + `commitAccountSession` and keeps a
signed-out liveness case. Related:
[[translate-a-public-surface-test-needs-a-liveness-case]].
