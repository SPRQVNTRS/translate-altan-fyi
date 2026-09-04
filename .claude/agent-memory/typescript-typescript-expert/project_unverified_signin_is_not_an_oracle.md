---
name: unverified-signin-is-not-an-oracle
description: signIn returns a three-member result; `unconfirmed` is reachable only with the CORRECT password, which is why it discloses nothing
metadata:
  type: project
---

`signIn` answers `{ status: 'ok' | 'unconfirmed' | 'refused' }`.
`refused` covers an unknown address AND a wrong password. `unconfirmed` is
returned only after the bcrypt comparison passed.

**Why:** answering "that address and password do not match" to somebody holding
the right credentials leaves them stuck with no way forward, which a browser
walk found on 2026-09-04. Telling them to open the mailed link reveals nothing:
they just proved they hold the password.

**How to apply:** THE ORDER OF THE CHECKS IS THE PROPERTY. Compare the password
before reading `emailVerifiedAt`, and keep the dummy bcrypt compare for the
no-row case. Reading the confirmed state first would answer `unconfirmed` to
somebody guessing, which IS an oracle. `tests/integration/signup-verify-signin.test.ts`
asserts that a WRONG password on an unconfirmed address still reads `refused`.
