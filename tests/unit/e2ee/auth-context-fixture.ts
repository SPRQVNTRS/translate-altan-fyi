/**
 * A controllable `AuthContext` for the auth handler tests.
 *
 * The clock and the token minter are both deterministic, which is what makes
 * expiry and rotation assertable without sleeping, without a network, and
 * without a database. `mintToken` hands out `token-1`, `token-2`, … so a test
 * can name the exact token it expects a handler to have issued.
 *
 * There is no mailer to substitute: this service has none, so the only things
 * this fixture fakes are time, randomness and the log sink.
 */
import { hashToken, type GeneratedToken } from '#app/lib/e2ee/tokens';
import type { AuthContext, AuthLogger } from '#app/lib/e2ee/auth-handlers';
import type { SignupMode } from '#app/lib/e2ee/protocol';
import { createFakeAccountStore, fakeInviteTokenHash, type FakeAccountStore } from './fake-account-store';

/**
 * A logger that discards everything.
 *
 * Hand-written rather than imported: `AuthLogger` is the narrow port the
 * handlers declare precisely so this suite needs no logging library, and the
 * app's real `Logger` exposes a readonly pino instance a test cannot build.
 */
function createSilentLogger(): AuthLogger {
  return { info: () => undefined, warn: () => undefined };
}

export interface AuthFixture {
  ctx: AuthContext;
  store: FakeAccountStore;
  /** Mints an invite the fixture's store will admit once, for a signup body. */
  mintInvite(options?: { expiresAt?: Date }): string;
  /** Moves the fixture clock forward. */
  advance(ms: number): void;
  /** Current fixture time. */
  now(): Date;
}

export interface AuthFixtureOptions {
  signupMode?: SignupMode;
  startAt?: Date;
  /**
   * The operator's `ACCOUNT_BOOTSTRAP_TOKEN`, or absent for an installation
   * that configured none, which is the DEFAULT, so a test has to opt in to
   * the bootstrap path rather than inherit it.
   */
  bootstrapToken?: string;
}

export function createAuthFixture(options: AuthFixtureOptions = {}): AuthFixture {
  const store = createFakeAccountStore();
  let clock = options.startAt ?? new Date('2026-08-04T10:00:00.000Z');
  let tokenCounter = 0;
  let familyCounter = 0;

  function mintToken(): GeneratedToken {
    tokenCounter += 1;
    const raw = `token-${tokenCounter}`;
    return { raw, hash: hashToken(raw) };
  }

  const ctx: AuthContext = {
    store,
    pepper: 'unit-test-pepper',
    enumerationSecret: 'unit-test-enumeration-secret',
    // INVITE, because that is what the app runs (`e2ee-context.server.ts`) and
    // a fixture defaulting to a mode production does not use would test a code
    // path no request can reach.
    signupMode: options.signupMode ?? 'invite',
    admission: {
      // The fake hash, not the real HMAC: see `fakeInviteTokenHash`. A test
      // needs no server secret to exercise the admission policy.
      hashInviteToken: fakeInviteTokenHash,
      isBootstrapToken: (token: string) =>
        options.bootstrapToken !== undefined && token === options.bootstrapToken,
    },
    now: () => new Date(clock.getTime()),
    mintToken,
    mintFamilyId: () => {
      familyCounter += 1;
      return `family-${familyCounter}`;
    },
    logger: createSilentLogger(),
  };

  return {
    ctx,
    store,
    mintInvite: (inviteOptions = {}) => store.mintInvite(inviteOptions),
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    now: () => new Date(clock.getTime()),
  };
}

/** A structurally valid Argon2id descriptor for request bodies. */
export function sampleKdfDescriptor(saltByte = 1) {
  return {
    salt: Buffer.alloc(16, saltByte).toString('base64'),
    params: { memorySizeKib: 65536, iterations: 3, parallelism: 1 },
  };
}

/** A structurally valid base64 auth-hash (32 bytes), distinct per `seed`. */
export function sampleAuthHash(seed = 7): string {
  return Buffer.alloc(32, seed).toString('base64');
}

/** A non-empty opaque wrapped-DEK payload. */
export function sampleWrappedDek(seed = 9): string {
  return Buffer.alloc(60, seed).toString('base64');
}
