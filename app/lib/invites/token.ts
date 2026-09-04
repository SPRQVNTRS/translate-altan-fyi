/**
 * Signup-invite token primitives: minting the plaintext token, and computing
 * the ONLY form of it this installation ever stores.
 *
 * NOT COPIED, and deliberately not placed in `app/lib/e2ee/`. Everything under
 * that directory is a transcription of `openplate-sync` carrying a provenance
 * header (ADR-0008), and an invite gate is this app's own product decision
 * (ADR-0009), not upstream's. Putting it there would blur the boundary that
 * tells the next contributor which files must be fixed upstream first.
 *
 * PURE, and DB-free on purpose: the mint command in `cli/commands/account.ts`
 * and the signup check that will consult `invites` both need exactly these
 * three functions, and neither should have to stand a database up to test
 * them.
 *
 * WHAT IS STORED. `invites.tokenHash` holds `HMAC-SHA-256(inviteTokenPepper,
 * token)`, hex. The plaintext is shown to the operator once and then exists
 * nowhere on this installation, exactly as `accounts.verifier` holds no
 * reversible secret. A dumped `invites` table is therefore not a stack of
 * usable signup credentials, and it cannot be checked offline against guessed
 * tokens without the pepper, which lives in the environment and not in the
 * database.
 *
 * WHY A SEPARATE PEPPER, NOT `verifierPepper`. `deriveServerSecrets`
 * (`app/lib/e2ee/server-secrets.ts`) already turns the one operator-supplied
 * `SERVER_SECRET` into labelled subkeys, and its header states the rule this
 * module follows: reusing one key across two unrelated HMAC purposes is the
 * mistake domain separation exists to prevent. An invite token and an account
 * auth-hash are unrelated purposes, so this module derives a THIRD sibling
 * subkey under its own frozen label rather than borrowing the verifier's.
 *
 * WHY THE LABEL IS DERIVED HERE AND NOT ADDED TO `server-secrets.ts`. That
 * file is a copied one. Adding a field to it would be exactly the drift its
 * header forbids, and the label belongs to a decision upstream does not have.
 * The construction below is the same one-line HMAC-over-label that file uses,
 * so the three subkeys are siblings, unequal by construction, and none is
 * recoverable from another.
 *
 * The HASH itself is computed by `computeVerifier` from
 * `app/lib/e2ee/verifier.ts`, not by a second hand-rolled HMAC. That function
 * is already this repo's one answer to "keyed hash of a high-entropy secret
 * under a server pepper", and its own doc explains why a fast keyed hash and
 * not a slow KDF is correct for a pre-image that is 256 bits of `randomBytes`.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { computeVerifier } from '#app/lib/e2ee/verifier';
import { SIGNUP_INVITE_TOKEN_PREFIX } from '#app/lib/e2ee/tokens';

/**
 * FROZEN. Changing it invalidates every unredeemed invite ever minted on this
 * installation, because their stored hashes were computed under the old
 * subkey and nothing can recompute them without the plaintext.
 *
 * Scoped to this app, not to `openplate-sync`, because the invite gate is this
 * app's decision and no upstream instance derives this subkey.
 */
export const INVITE_TOKEN_PEPPER_LABEL = 'translate-altan-fyi:invite-token-pepper:v1';

/** Bytes of entropy behind one invite. 256 bits, so there is no dictionary to run against the stored hash. */
const INVITE_TOKEN_BYTES = 32;

/**
 * The invite subkey of the operator's single `SERVER_SECRET`. Pure: the same
 * root secret always yields the same pepper, which is required rather than
 * incidental, since a stored hash has to stay checkable across restarts.
 */
export function deriveInviteTokenPepper(rootSecret: string): string {
  return createHmac('sha256', rootSecret).update(INVITE_TOKEN_PEPPER_LABEL).digest('hex');
}

/**
 * Mints one plaintext invite token: the existing `si_` signup-invite prefix
 * over 256 fresh random bits, hex-encoded.
 *
 * The prefix is reused from `app/lib/e2ee/tokens.ts` rather than reinvented so
 * that `isSignupInviteToken` keeps working as the pre-lookup shape gate, and
 * so a token pasted into the wrong field is refused before it is ever hashed.
 *
 * HEX, not the base64url the session tokens use, and that is a usability call
 * rather than a security one: an invite is the one token here that a person
 * copies out of a terminal and pastes into a chat, and hex survives that trip
 * without a case-folding or line-wrapping accident.
 */
export function generateInviteToken(): string {
  return `${SIGNUP_INVITE_TOKEN_PREFIX}${randomBytes(INVITE_TOKEN_BYTES).toString('hex')}`;
}

/** The value stored in `invites.token_hash`. Never store, log or return the `token` argument. */
export function computeInviteTokenHash(input: { token: string; pepper: string }): string {
  return computeVerifier({ authHash: input.token, pepper: input.pepper });
}

/**
 * Constant-time hash comparison, for the redemption path spec 02 owns.
 *
 * Length is checked first because `timingSafeEqual` throws on a mismatch, and
 * a length mismatch here means a malformed stored value rather than a
 * near-miss guess, so leaking that one bit costs nothing. Same reasoning, and
 * same shape, as `verifierMatches`.
 */
export function inviteTokenHashMatches(input: { candidate: string; stored: string }): boolean {
  const candidate = Buffer.from(input.candidate, 'utf8');
  const stored = Buffer.from(input.stored, 'utf8');
  if (candidate.byteLength !== stored.byteLength) return false;
  return timingSafeEqual(candidate, stored);
}
