# 0008 — The E2EE sync code is copied from openplate-sync, not shared

- **Status:** Accepted
- **Date:** 2026-09-02
- **Deciders:** operator (altan), M172 spec 01

## Context

The personal layer of this service is end-to-end encrypted. A user's vocabulary
lists are a record of what that person does not know, and the server must be
unable to read them by construction rather than by policy.

That problem is already solved, in production-grade code, in two sibling repos:

- `openplate-sync` — the accounts, the opaque tokens, the wrapped-DEK key
  records and the peppered verifier.
- `openplate` — the client-side Argon2id and HKDF derivation, the AES-256-GCM
  envelope, and the DEK wrapping.

The written specification of the wire format is `PROTOCOL.md`, carried into this
repo verbatim.

M172 spec 01 asked for that code to be **extracted** into a shared private
package (`@sprqvntrs/e2ee-sync`, or a home inside the `platform-internal` repo
from M168) so a fix to a key-wrapping bug lands once instead of twice. The
milestone README records the reasoning, and it is sound: two divergent copies of
security-critical code is the defect class that workspace memory
`project_consumer_discards_source_value` already documents, applied to
cryptography.

Extraction is blocked here by a contract this repo cannot break:

1. **This repo is public, MIT-licensed.** A public application cannot depend on
   a private, unpublished package. Anybody who clones it could not install it,
   and "you can read the source but you cannot build it" is not open source.
2. **A new public package needs its own npm bootstrap.** The existing
   `@sprqvntrs/*` scope lives in GitHub Packages behind a token
   (`GITHUB_PACKAGES_TOKEN`), which is the same problem in a different place. A
   genuinely public package means a new registry identity, a release pipeline
   and a versioning contract, none of which exist today.
3. **openplate-sync is mid-flight.** It removed its mailer and its email column
   in M181 and is still moving. Freezing an API surface across a package
   boundary now would slow the repo that is furthest ahead.

The spec anticipated this and allowed the fallback explicitly, on the condition
that taking it is recorded as a decision rather than taken silently.

## Decision

**Copy now, extract later.**

The modules are copied into `app/lib/e2ee/`, byte-faithful wherever the move
permits. Only import specifiers change (`./foo.js` becomes `./foo`, matching this
repo's `bundler` module resolution) plus the minimum needed to compile.

Three things are held frozen, because they are the wire contract and not style:

- **`PROTOCOL.md`** is copied verbatim and remains normative. The TypeScript is
  its transcription, not the other way round.
- **The domain-separation labels are byte-identical**, including the literal
  string `openplate-sync` inside them: `openplate-sync:verifier-pepper:v1`,
  `openplate-sync:kdf-dummy:v1`, `openplate-sync:recovery-auth:v1`,
  `openplate-sync:recovery-kek:v1`. They read as the wrong product name in this
  repo and that is correct. Renaming them would change every derived key and
  every stored verifier, and would silently fork the protocol from its own
  specification.
- **The comments.** They are the security documentation: why the verifier is a
  fast keyed hash and not a second slow KDF, why the KDF descriptor endpoint
  serves a deterministic dummy, why revoked token rows are retained. Deleting
  them to tidy the copy would delete the reasoning that makes the code
  reviewable.

**Every copied file names its source path and commit in a header**, so a reader
can diff against the original:

```
COPIED, NOT SHARED. Source: openplate-sync/src/lib/tokens.ts @ 311a1578af3c...
See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
then here. Do not let the two drift.
```

The source commit is `311a1578af3ca169e8a08c6d50d90889e29d5889` for
`openplate-sync`.

### The copy follows the source, including where the source disagrees with the spec

M172 spec 01 was written against an older shape of `openplate-sync` and asked for
email-addressed accounts, email verification, mailed reset links and delivery
through pigeon. **`openplate-sync` deleted all of that in M181, deliberately.**
Accounts are identified by an opaque `handle`; `auth-input.ts` refuses a handle
containing `@` so the column cannot drift back into being an address register;
the mailer and both single-use link token kinds are gone.

The upstream reasoning is recorded in `tokens.ts` and is a security argument, not
a cleanup: a mailed reset link "restored a LOGIN to data that stays sealed,
because the server never held a key that unwraps a DEK". It was an
account-takeover path that bought no recovery.

Re-adding email here would not be a port. It would re-introduce the exact surface
the source removed for cause, and the two implementations would diverge on their
first day — which is the failure this ADR exists to bound. So this service holds
**no email address anywhere in the account model**, and recovery is what the
source made it: a **second authenticator**. `accounts.recoveryVerifier` stores
`HMAC(pepper, recoveryAuthHash)`, derived on the client under
`openplate-sync:recovery-auth:v1`, a deliberate sibling of the
`:recovery-kek:v1` label that wraps the DEK. The two are separate HKDF branches
so that the server never holds an HMAC of the material that opens the data.

The column is nullable, and a `NULL` means the account has no second
authenticator: a lost passphrase is then terminal. That is stated plainly rather
than papered over with a reset link that could not have helped.

## Alternatives Considered

- **Extract into a private `@sprqvntrs/e2ee-sync`.** The spec's first choice.
  Rejected because a public MIT repo cannot depend on a private package.
- **Extract into a new *public* package.** The right long-term answer, and the
  one this ADR owes. Rejected *for now* because it needs a registry identity, a
  release pipeline and a frozen API, and because `openplate-sync` is still
  moving.
- **Vendor by git submodule.** Would keep one source of truth without a
  registry. Rejected: a submodule pointing at a private repo fails for a public
  cloner exactly like a private dependency does, and it makes the build
  non-hermetic.
- **Re-implement from `PROTOCOL.md`.** Rejected outright. A second independent
  implementation of key wrapping is more drift than a copy, not less, and the
  spec's own reasoning is that copying a working protocol beats inventing a
  second one.

## Consequences

**What this buys.** The milestone ships. The code that runs here is code that has
already been security-reviewed and integration-tested upstream, down to the
millisecond-precision CAS timestamp on `sync_key_records` that was a real bug
(openplate-sync M160 spec 06). The repo stays installable by anyone who clones
it.

**What it costs, stated without euphemism.** There are now two copies of
security-critical cryptographic code, and nothing mechanical keeps them in step.
A key-wrapping fix landed in `openplate-sync` does not reach this repo. There is
no shared CI between the repos and there is no import that would break. The only
things standing between us and a silent split are this ADR, the per-file
provenance headers, and the transcription tests that assert the protocol
constants against literals.

**Mitigations in place.**

- Per-file `COPIED, NOT SHARED` headers naming the exact source path and commit,
  so a drift check is a `git diff` away.
- `tests/unit/e2ee/protocol.test.ts`, copied with the rest, asserts the protocol
  constants against transcribed literals. It fails if a constant here drifts from
  the document.
- The frozen labels are asserted rather than assumed, so a rename is a test
  failure and not a silent re-keying.

**Owed follow-up.** Extraction into a genuinely public `@sprqvntrs/e2ee-sync`
consumed by `openplate-sync`, `openplate` and this repo. It is a tracked
follow-up milestone, not an aspiration in a comment. Until it lands, the rule is
the one in every file header: **fixes go upstream first, then here.**

**Also owed, and out of scope here.** The spec's email, verification-link and
pigeon requirements are unmet *by design* under this decision, not by omission.
Whether this service ever wants an optional notification address, which would
carry no login or reset power, is a separate question for a separate spec.

## References

- `PROTOCOL.md` — the normative wire specification, copied verbatim.
- `.tracker/M172-trl-personal-layer/01-port-sync-accounts-tokens-and-key-records.md`
- `openplate-sync` @ `311a1578af3ca169e8a08c6d50d90889e29d5889`
- `.adr/0003-app-enforced-multi-tenancy.md` — the other place this codebase
  chooses application-level enforcement over a database mechanism.
