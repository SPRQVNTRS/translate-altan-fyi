# 0011: Plain accounts replace the encrypted layer

- **Status:** Accepted
- **Date:** 2026-09-04
- **Deciders:** operator

## Context

The account layer this app carried until now was copied from `openplate-sync`
under [ADR-0008](0008-e2ee-sync-copied-not-extracted.md): a handle instead of
an address, a passphrase run through Argon2id in the browser, a data-encryption
key wrapped so the server never held it, and a recovery code as the one way
back in if the passphrase was lost. That bar exists because openplate protects
a food diary, a kind of health record. This app is a dictionary. Nothing a
reader stores here needs to be unreadable by the server that stores it, and the
bar was never chosen for this product, it arrived with the clone.

The price was paid by the one real user. They had a random sign-in name instead
of an address, and no password to forget because there was no password, only a
passphrase with no reset path. The operator said what was needed on
2026-09-04: "a plain user signup/super admin flow, I want to be able to reset
my password."

Everything the plain version needs, address, password hash, a mailed link, a
superadmin flag, is plumbing `selfhostedworld-com` and `ts-factory-stack`
already carry. This is a copy of a proven pattern, not new design, the same way
ADR-0008 copied a proven pattern for the layer it replaces.

## Decision

Replace the encrypted account model with a plain one.

**Tables.** `users` holds `id`, `email` (unique, stored lower-cased and
trimmed), `password_hash` (bcryptjs, cost 10), `email_verified_at`,
`password_changed_at`, `is_superadmin`, `created_at`, `updated_at`. No roles, no
display name, no invites, no bootstrap token, no login-attempt table.
`user_tokens` holds `id`, `user_id`, `kind` (`verify` or `reset`), `token_hash`
(SHA-256 hex of 32 random bytes), `expires_at`, `used_at`, `created_at`. A
mailed link is spent by a single `UPDATE ... WHERE token_hash = ... AND
used_at IS NULL AND expires_at > now() RETURNING user_id`, never a read then a
write, so two clicks on one link cannot both succeed.

**Session.** A React Router cookie session holds `{ userId, issuedAt }` and
nothing else. No bearer tokens, no refresh tokens, no device list. The auth
middleware re-reads the user row on every request and drops the session when
the user is gone, unverified, or when `password_changed_at` is newer than the
cookie's `issuedAt`. That column is the session epoch: a password change
signs out every other device with no session table to sweep, because the
comparison alone does the work.

**Tokens.** Both the verification link and the reset link are single-use and
expire. Neither is minted for an address that does not need one, and neither
signup, sign-in, nor forgot-password says which half of a credential was
wrong, or whether the address is on file at all. That answer is uniform by
construction in `app/services/auth.server.ts`, not by convention in a screen.

**Sync.** `sync_blobs` keeps its compare-and-set version, `blob_version`, but
the column is `payload jsonb` instead of `ciphertext bytea`. The sync API
authenticates with the session cookie on same-origin fetches, the same as
every other app screen. `sync_key_records`, the table that held the wrapped
per-device key material, is gone with the keys it wrapped.

**Signup is open.** There is no invite and no bootstrap token. A verification
mail is required before the first sign-in.

**Mail.** `@sprqvntrs/pigeon`, sent over plain `fetch` against the same wire
contract `selfhostedworld-com` uses, with a console fallback in development
(`app/services/email.server.ts`). From `no-reply@translate.altan.fyi`.
Templates are plain text, in English and German through i18n keys, written by
wordsmith.

**Superadmin.** `users.is_superadmin`, granted with `pnpm cli account
grant-superadmin <email>`, the same direct-DB bootstrap exception
[ADR-0001](0001-cli-wraps-the-api.md) already carves out for the first API
key. `/super` stays gated two ways: the Bay `vpn_routes` entry restricts it to
the operator's tailnet, and the superadmin session check is the second,
independent layer.

## Consequences

**The server can now read the sync blob.** It is ordinary JSON in
`sync_blobs.payload`, readable by any query against that table. That was true
by construction under the old model and it is the central trade this ADR
makes.

**Mail is now a hard dependency.** Signup, forgotten-password, and losing
access to the mailbox on file all now depend on a working mail transport.
Production refuses to boot without `PIGEON_API_KEY` and `PIGEON_BASE_URL`
rather than send silently to nowhere.

**What was deleted.** `app/lib/e2ee/`, its tests, and its routes; `PROTOCOL.md`;
the `accounts`, `account_tokens`, `sync_key_records`, and `invites` tables; and
`SERVER_SECRET` and `ACCOUNT_BOOTSTRAP_TOKEN`. Production held zero accounts
and stage held one throwaway account, so the migration drops the old tables
outright rather than converting a row that could not be converted, since there
was no key on the server side to decrypt what an old row held.

**The migration ran as three separate `drizzle generate` runs, applied in
order.** The first created `users` and `user_tokens`. The second changed
`sync_blobs`: dropped its foreign key to `accounts`, added `user_id` and
`payload jsonb not null`, and dropped `ciphertext` and `envelope_version`.
`enrichment_votes` also held a foreign key to `accounts`, so it had to be
repointed at `users` in the same run, which is why the two-table change could
not be folded into the first run or the third. Before that run applied, the
one throwaway row in `sync_blobs` on stage was deleted by hand: a `NOT NULL`
column cannot be added to a table that already has rows without either a
default or a backfill, and a payload has no honest default. The third run
dropped `accounts`, `account_tokens`, `sync_key_records`, and `invites`, once
nothing referenced them.

## Not now

These are accepted gaps, not oversights, and a review by four advisors before
this ADR was written returned "proceed with adjustments" from all four.

- **The sync blob is no longer encrypted at rest.** A database dump exposes a
  reader's lists, notes, and history. This is the central trade above, stated
  again because it is the one a future reader is most likely to ask about.
- **One blob per user, with a Lamport merge and compare-and-set, and no
  per-device rows or conflict UI.** Two devices pushing at once resolve
  through the same merge the old model used; there is nowhere to see or
  choose between two conflicting edits, there is only the merged result.
- **Mail is sent inline, with a resend button, rather than queued through
  pg-boss.** A signup or reset request waits on the mail send finishing.
- **Open signup relies on the anonymous daily budget in
  `drizzle/schema/abuse.ts`, not on an email blocklist.** Nothing stops an
  address, disposable or otherwise, from getting an account; what is bounded
  is spend, by an hourly, peppered, anonymous counter.
- **The in-memory rate limiter resets on every deploy.** It runs as a
  process-local map in `app/middleware/rate-limit.ts` because this app runs as
  one container. It slows a script down; it does not survive a restart, and it
  is not meant to.

## References

- [ADR-0008](0008-e2ee-sync-copied-not-extracted.md), superseded by this
  record, the decision this one replaces.
- [ADR-0009](0009-invite-only-accounts.md), superseded by this record, the
  invite gate this ADR removes.
- [ADR-0001](0001-cli-wraps-the-api.md), the direct-DB bootstrap exception
  `account grant-superadmin` extends.
- `.tracker/M191-trl-plain-accounts/00-README.md`, the decision list this ADR
  transcribes into prose.
- `app/services/auth.server.ts`, `drizzle/schema/users.ts`,
  `drizzle/schema/sync.ts`, `app/services/email.server.ts`.
