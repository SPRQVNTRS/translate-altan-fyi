/**
 * The composition root of the end-to-end-encrypted personal layer: it builds
 * the `AuthContext` the handler cores take, and owns the process-wide throttle
 * store.
 *
 * NOT COPIED. `openplate-sync` assembles the same pieces inside its Express
 * bootstrap; this file is the equivalent seam for a React Router app, so it
 * has no upstream counterpart and no provenance header. Everything it wires
 * together IS copied, and carries one.
 *
 * `.server.ts` because it reaches the Drizzle store and the process
 * environment. Nothing here may be imported from a route component.
 */
import { CONFIG } from '#config';
import { createComponentLogger } from '#app/lib/logger';
import { computeInviteTokenHash, deriveInviteTokenPepper, inviteTokenHashMatches } from '#app/lib/invites/token';
import { createDrizzleAccountStore } from './drizzle-account-store.server';
import { deriveServerSecrets } from './server-secrets';
import { generateToken, generateFamilyId } from './tokens';
import { createThrottleStore, type ThrottleStore } from './throttle';
import type { AuthContext, SignupAdmissionPort } from './auth-handlers';
import type { SignupMode } from './protocol';

/**
 * ONE ROOT SECRET, THREE SUBKEYS (the third is derived just below). Derived
 * once at module load rather than per request: the derivation is a pure HMAC
 * over a value that cannot change while the process runs, and doing it per
 * request would only add work.
 *
 * `verifierPepper` is mixed into every stored verifier and `enumerationSecret`
 * is behind the deterministic dummy KDF descriptor. Neither can be recovered
 * from the other, which is the whole reason the operator supplies one secret
 * and not two — see `server-secrets.ts`.
 */
const serverSecrets = deriveServerSecrets(CONFIG.e2ee.serverSecret);

/**
 * THE THIRD SUBKEY. `deriveServerSecrets` above produces two; this is the
 * sibling `app/lib/invites/token.ts` derives under its own frozen label, and
 * its header explains why it is derived there rather than by extending the
 * copied `server-secrets.ts`. Module scope for the same reason as the other
 * two: a pure HMAC over a value that cannot change while the process runs.
 */
const inviteTokenPepper = deriveInviteTokenPepper(CONFIG.e2ee.serverSecret);

/**
 * The operator's one-shot bootstrap token, or `null` when none is set.
 *
 * READ FROM `process.env` DIRECTLY, and not through `CONFIG`, following
 * `ALERT_WEBHOOK_URL` and `ABUSE_HASH_PEPPER`: it is an optional operator
 * secret with no default, consumed at exactly one point, and a `CONFIG` getter
 * would only add a second name for it.
 *
 * AN EMPTY OR UNSET VALUE IS `null`, NOT THE EMPTY STRING, and the distinction
 * is load-bearing. Comparing against `''` would admit a signup that presented
 * an empty token on an installation that deliberately configured none, which
 * is the whole gate falling open on a variable nobody set.
 *
 * READ ONCE, at module load. The token is meant to be used exactly once on a
 * fresh installation and then removed from the environment at the next deploy;
 * re-reading it per request would only make the process's behaviour depend on
 * when the read happened.
 */
const configuredBootstrapToken = process.env.ACCOUNT_BOOTSTRAP_TOKEN?.trim() ?? '';
const bootstrapToken: string | null = configuredBootstrapToken.length > 0 ? configuredBootstrapToken : null;

/**
 * The admission half of signup, as the narrow port the handler declares.
 *
 * Built once and shared: both members are pure functions over module-scope
 * secrets, so there is nothing per-request to close over.
 *
 * THE BOOTSTRAP COMPARISON IS BETWEEN HASHES, NOT BETWEEN THE TOKENS. Both
 * sides go through `computeInviteTokenHash` first, which gives two values of
 * one fixed length whatever the operator configured, and then through
 * `inviteTokenHashMatches`, which is `timingSafeEqual`. A direct `===` on the
 * plaintext would leak the token's LENGTH through the comparison time and then
 * its prefix, one character at a time, to a caller who can measure. That
 * caller is rate-limited by the signup throttle, which is a bound rather than
 * an answer.
 */
const signupAdmission: SignupAdmissionPort = {
  hashInviteToken(token: string): string {
    return computeInviteTokenHash({ token, pepper: inviteTokenPepper });
  },
  isBootstrapToken(token: string): boolean {
    if (bootstrapToken === null) return false;
    return inviteTokenHashMatches({
      candidate: computeInviteTokenHash({ token, pepper: inviteTokenPepper }),
      stored: computeInviteTokenHash({ token: bootstrapToken, pepper: inviteTokenPepper }),
    });
  },
};

/**
 * ONE store for the whole process, held at module scope on purpose.
 *
 * A throttle built per request counts to one and never locks anything. This is
 * in-memory, so it resets on restart and is per-replica; that is the upstream
 * trade-off, recorded in `throttle.ts`, and it is inherited rather than
 * re-decided here.
 */
const throttleStore: ThrottleStore = createThrottleStore();

/** The shared throttle buckets, for the routes that need to charge a failed attempt. */
export function getThrottleStore(): ThrottleStore {
  return throttleStore;
}

/**
 * Builds the injected context the `/v1/auth/*` handler cores run against.
 *
 * Cheap, and deliberately called per request rather than memoized: the only
 * per-call work is closing over the store and the clock, and a context built
 * fresh cannot accidentally carry a stale clock into a handler.
 *
 * @returns the store, the derived secrets, the clock and the token minters.
 */
export function createAuthContext(): AuthContext {
  return {
    store: createDrizzleAccountStore(),
    pepper: serverSecrets.verifierPepper,
    enumerationSecret: serverSecrets.enumerationSecret,
    // INVITE-ONLY, as a hard-coded literal and not a configuration value.
    // There is deliberately no env var that can move it: an operator cannot
    // reopen signup by mistyping a variable, only by editing this line and
    // deploying it. `AuthContext.signupMode` has the rest of the reasoning, and
    // ADR-0009 has the decision.
    signupMode: 'invite' satisfies SignupMode,
    admission: signupAdmission,
    now: () => new Date(),
    mintToken: generateToken,
    mintFamilyId: generateFamilyId,
    logger: createComponentLogger('E2eeAuth'),
  };
}
