---
name: plain-accounts-m191
description: M191 replaced the e2ee account layer with users + user_tokens; where each rule lives (non-disclosure, single-statement token consumption, the session epoch, the limiter's client address) and the three-run migration that got there
metadata:
  type: project
---

M191 deleted `app/lib/e2ee/**` (42 files), `PROTOCOL.md`, `accounts`,
`account_tokens`, `sync_key_records`, `invites` and `SERVER_SECRET`. An account
is an email address plus a bcrypt hash at cost 10, and `sync_blobs.payload` is
plain `jsonb` the operator can read.

Where each rule lives, because none of them is visible from a call site:

- **Non-disclosure is decided in `app/services/auth.server.ts`, never in a
  screen.** `signIn` answers `null` for an unknown address, a wrong password and
  an unconfirmed address alike, and runs a DUMMY bcrypt compare when there is no
  row so the two paths cost the same wall clock. `registerUser` and
  `requestPasswordReset` answer `{ status: 'mailed' }` either way.
- **A mailed link is consumed in ONE statement**: `UPDATE user_tokens SET
  used_at = now() WHERE token_hash = ... AND kind = ... AND used_at IS NULL AND
  expires_at > now() RETURNING user_id`. `tests/integration/token-single-use.test.ts`
  fires the same token from two unawaited calls and asserts exactly one wins.
- **`users.password_changed_at` IS the session epoch.** The cookie carries
  `{ id, issuedAt }` and nothing else; `resolveUser` refuses a cookie older than
  that column. `changePassword`/`resetPassword` therefore RETURN a fresh
  `Set-Cookie` the caller must set, or they sign the changing tab out too.
- **The rate limiter reads `x-client-ip`**, which `server.ts` writes from
  `req.ip` after `trust proxy` resolves, deleting any incoming value first. A
  React Router middleware only sees a `Request`, so it has no `req.ip`; reading
  the forwarding header there would count a header the client can write.
  `app/lib/auth/paths.ts` exists for the same class of reason, see below.

**A route COMPONENT that reads a constant from a `.server` module fails only
`react-router build`.** `SIGN_IN_PATH` started in `session.server.ts`; lint,
typecheck, 558 unit tests and 84 integration tests were all green and the
production build refused `account.tsx`. RR8 strips only `loader`, `action`,
`middleware` and `headers`. The constant now lives in `app/lib/auth/paths.ts`.

**The migration took THREE generate runs**, and the order is forced:
(1) create `users` and `user_tokens`; (2) reshape `sync_blobs` (drop the fk to
`accounts`, drop `ciphertext`/`envelope_version`, add `payload jsonb` and
`user_id`, unique on `user_id`) AND repoint `enrichment_votes.account_id` to
`users`, both while `accounts` still exists; (3) DROP TABLE the four old ones.
Run 2 must not be merged into run 3: a `DROP TABLE ... CASCADE` removes the
foreign keys that the same migration's `DROP CONSTRAINT` then fails on (42704).
No pty prompt appeared, because the dropped and added `sync_blobs` columns have
different types. **`ALTER TABLE sync_blobs ADD COLUMN user_id integer NOT NULL`
fails on a non-empty table**, so any environment with a stored blob must have
`sync_blobs` emptied before run 2 applies.

Related: [[project_drizzle_generate_needs_a_pty]],
[[project_getrawdb_is_the_only_handle]], [[project_e2ee_copied_not_extracted]].
