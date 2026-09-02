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
import { createDrizzleAccountStore } from './drizzle-account-store.server';
import { deriveServerSecrets } from './server-secrets';
import { generateToken, generateFamilyId } from './tokens';
import { createThrottleStore, type ThrottleStore } from './throttle';
import type { AuthContext } from './auth-handlers';
import type { SignupMode } from './protocol';

/**
 * ONE ROOT SECRET, TWO SUBKEYS. Derived once at module load rather than per
 * request: the derivation is a pure HMAC over a value that cannot change while
 * the process runs, and doing it per request would only add work.
 *
 * `verifierPepper` is mixed into every stored verifier and `enumerationSecret`
 * is behind the deterministic dummy KDF descriptor. Neither can be recovered
 * from the other, which is the whole reason the operator supplies one secret
 * and not two — see `server-secrets.ts`.
 */
const serverSecrets = deriveServerSecrets(CONFIG.e2ee.serverSecret);

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
    // This service has open signup. `AuthContext.signupMode` explains why the
    // other two modes are not reachable from here.
    signupMode: 'open' satisfies SignupMode,
    now: () => new Date(),
    mintToken: generateToken,
    mintFamilyId: generateFamilyId,
    logger: createComponentLogger('E2eeAuth'),
  };
}
