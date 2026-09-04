# 0009: Invite-only accounts, bootstrapped by a one-shot token

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** operator

## Context

Every enrichment this app runs is an LLM call billed to the operator's own
OpenRouter account, and until now anybody who found the URL could trigger one.
Closing that means account creation has to be gated, and the gate has to be an
invite rather than a payment wall or an email confirmation, because this
installation deliberately holds no addresses (ADR-0008, and
`drizzle/schema/accounts.ts`).

Three facts constrain the design, all of them read first-hand on 2026-09-03:

**The server can never create an account by itself.** Identity here is a
`handle` plus material derived in the BROWSER: Argon2id over a passphrase, then
two HKDF branches, one of which wraps the data-encryption key. The server
stores `HMAC(pepper, authHash)` and never sees the passphrase (`PROTOCOL.md`).
A conventional env-seeded admin, one row inserted at boot with a hardcoded
credential, is therefore not merely discouraged here, it is impossible. The
first account MUST be created by a real browser doing the real derivation.

That collides head-on with "nobody may create an account without an invite":
for the FIRST account there is, by definition, nobody to have minted one.

**`accounts` had zero rows in production.** Nobody had ever signed up, which
also means `/super/*` had never been reachable, because
`pnpm cli account grant-superadmin <handle>` flips a flag on an EXISTING row
and there had never been a row to flip. There was no account base to migrate
or strand, so this decision could be made without a compatibility burden.

**There are two identity tables in this repo, and only one of them
authenticates anybody.** `accounts` is the real one; the `users` /
`organizations` scaffolding is ts-factory-stack inheritance with its own,
separate `is_superadmin` column that nothing authorises against, zero rows in
production, and no path a real visitor reaches. It is recorded here because
the mistake it invites is expensive: building the invite gate on `users` would
resurrect a second identity system this repo has already walked away from.

## Decision

**Account creation requires an invite, and the first account is admitted by a
one-shot bootstrap token instead.**

1. A new global `invites` table (`drizzle/schema/invites.ts`) holds
   `HMAC-SHA-256(inviteTokenPepper, token)` and never the plaintext, mirroring
   how `accounts.verifier` holds no reversible secret. It records who minted an
   invite, who redeemed it, and when it expires, if it does.
2. The pepper is a THIRD labelled subkey of the single operator-supplied
   `SERVER_SECRET`, a sibling of the verifier pepper and the enumeration
   secret, derived under the frozen label
   `translate-altan-fyi:invite-token-pepper:v1`
   (`app/lib/invites/token.ts`). The hash itself is computed by the existing
   `computeVerifier`, so there is one keyed-hash primitive in this repo and not
   two.
3. `ACCOUNT_BOOTSTRAP_TOKEN`, an operator-set random secret, is accepted by
   signup IN PLACE OF an invite, and ONLY while `accounts` is empty. It is
   self-invalidating: once one account exists the precondition is false forever,
   so there is no ongoing secret to rotate.
4. `pnpm cli account invite` mints an invite direct-DB and prints the plaintext
   once. `pnpm cli account list-invites` shows status and never a token.
5. This milestone does NOT touch `users` or `organizations`. The gate is built
   on `accounts` only.

The direct-DB CLI is an extension of ADR-0001's existing bootstrap exception,
not a new one: an invite is what an account is created FROM, so a minting
endpoint behind the superadmin gate would be unreachable until somebody had
already got through the gate.

## Alternatives Considered

- **Option A, a first-account-free window.** Waive the invite check while
  `accounts` has zero rows; the operator signs up normally, then runs
  `grant-superadmin`. Simplest, and no new secret to manage. Rejected: the
  waiver is a public open door on a public URL. Between the deploy that ships
  the gate and the moment the operator claims the first account, anyone
  watching can create the zero-th account and grant themselves superadmin
  first. The window may be short, but it is a real race, not a theoretical one,
  and the whole point of this milestone is to stop unbilled strangers.
- **An env-seeded admin account.** The conventional answer everywhere else.
  Impossible here, as set out in Context: the server has no passphrase to
  derive from. Recorded because `.env.example` carried a `SUPERADMIN_EMAIL`
  comment claiming exactly this mechanism, and the comment was aspirational,
  nothing ever read the variable. It has been replaced by
  `ACCOUNT_BOOTSTRAP_TOKEN`, which describes something that exists.
- **An emailed invite link.** Rejected on the same grounds as the mailed
  recovery link in ADR-0008: this service holds no addresses, and adding a
  mailer to send invites would reintroduce the address register the account
  model was designed without.
- **Storing invite tokens in plaintext.** Rejected. It would make a database
  dump a stack of usable signup credentials, and there is no operational
  benefit, since the only supported read is "does this presented token match a
  row", which a keyed hash answers.
- **Reusing `verifierPepper` for invite hashes.** Rejected for the reason
  `server-secrets.ts` already states about its own two subkeys: one key across
  two unrelated HMAC purposes is precisely the mistake domain separation
  exists to prevent.

## Consequences

- The operator must set `ACCOUNT_BOOTSTRAP_TOKEN` before the first deploy of
  the gate, and should expect to use it exactly once. Losing it before the
  first signup means editing the environment, not editing the database.
- Rotating `SERVER_SECRET` now invalidates every unredeemed invite as well as
  every account verifier. That widens an already-breaking operational change
  rather than adding a new one.
- Invites are bearer tokens handed over out of band. Whoever holds one can
  create an account, so the CLI prints one once and says so.
- `invites.redeemedAt`, not `redeemedByAccountId`, is the authoritative spent
  marker, because the account reference is `ON DELETE SET NULL` and would
  otherwise hand a spent token a second life when an account is deleted.
- Follow-on work, owned by later specs in M184: signup itself must consult
  `invites` and the bootstrap token (spec 02), the route-by-route gating table
  and the anonymous-visitor line must be settled (spec 03), and the repo docs
  that still promise an ungated app must be corrected (spec 04).

## References

- `.tracker/M184-trl-invite-only-access/00-README.md`, "The bootstrap problem"
  and "The identity model".
- [ADR-0001](0001-cli-wraps-the-api.md), the direct-DB bootstrap exception this
  extends.
- [ADR-0008](0008-e2ee-sync-copied-not-extracted.md), why the account model
  has no address column, and why `app/lib/invites/` sits outside
  `app/lib/e2ee/`.
- `PROTOCOL.md` §5.8, the normative signup flow the redemption check hangs off.

## Amendment, 2026-09-04: the doors are named, and they are visible

Two things this ADR settled in M184 are now wrong, and both are corrected here
rather than in a second ADR, because both are consequences of the decision
above rather than new decisions.

**The routes are `/sign-in` and `/sign-up`.** They were `/sync/login` and
`/sync/setup`. The old names described the machinery, not the reader: a person
arriving at an invite-only product creates an account, and their devices then
carry the same words. Sync is a consequence of holding an account and is no
longer presented as something a reader sets up. The old paths answer forever,
with a permanent redirect that preserves the query string, because an invite is
handed out as `?invite=<token>` and a hop that dropped it would read as a broken
invite.

**The rule that `/` and `/account` must never prompt for signup is removed.**
That rule was correct for an anonymous-by-default product, where an account
bought sync and nothing else, and asking for one on the home page would have
been asking for something the reader did not need. The gate this ADR introduced
removed the premise: every search now requires an account. What survived was a
product that demands an account, hides the only link to creating one on the
sign-in page, and shows a stranger a working demonstration with no way in. That
is a defect, not restraint. The home page, `/account` and the app shell header
now carry "Create account" as the primary action and "Sign in" beside it.

Nothing about the invite itself changes. Creating an account still needs a valid
invite or the bootstrap token, and signup still answers every cause of refusal
with one message, so a visible door is not a wider one.
