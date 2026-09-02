/**
 * The imperative shell of the sync screens: the browser-only key derivation
 * and the four HTTP calls that carry its results.
 *
 * ── The boundary this file exists to hold ────────────────────────────────
 *
 * The passphrase, the recovery code, the KEK and the DEK live in this module's
 * call frames and nowhere else. Nothing here writes any of them to a form, a
 * URL, a cookie, storage or a log. What LEAVES the device is only ever a
 * derived hash (`authHash`, `recoveryAuthHash`) or a ciphertext (`wrappedDek`),
 * which is the whole point of the protocol: the server cannot read the data it
 * stores, by construction rather than by policy.
 *
 * That is also why the screens submit through `fetch` from client code instead
 * of a `<Form method="post">`. A React Router action runs on the server, so a
 * passphrase placed in `FormData` would be a passphrase mailed to the operator.
 * The session cookie the auth routes set is `httpOnly`, so `credentials:
 * 'same-origin'` is all the authentication any call here needs, and this module
 * never sees or stores a token.
 *
 * ── Why Argon2id runs in a Worker ────────────────────────────────────────
 *
 * At 64 MiB it takes about a second on a desktop and several on a phone, and
 * that cost is the security property, so it cannot be optimised away. It can
 * only be moved off the thread that paints, which `workerArgon2idDeriver`
 * does. Every caller of this module is expected to show a pending state for
 * the whole call.
 */
import { z } from 'zod';
import { workerArgon2idDeriver } from '#app/lib/e2ee/client/argon2-worker';
import { deriveCredentialsFromPassphrase } from '#app/lib/e2ee/client/derive-credentials';
import type { PassphraseKdfDescriptor } from '#app/lib/e2ee/client/passphrase-kek';
import { deriveRecoveryAuthHash, generateRecoveryCode } from '#app/lib/e2ee/client/recovery-kek';
import { setupSyncKeys, type SyncKeySetupRecord } from '#app/lib/e2ee/client/setup-keys';
import { errorKindForStatus, SyncRequestError } from '#app/lib/e2ee/client/sync-error';
import { bytesToBase64 } from '#app/lib/e2ee/crypto/base64';
import { generateHandle, normalizeHandle } from '#app/lib/e2ee/flows/handle';
import { classifySignupFailure } from '#app/lib/e2ee/flows/signup-error';

/**
 * How many fresh handles a signup will mint before giving up on a `409`.
 *
 * A collision is a 50-bit coincidence (`HANDLE_LENGTH`), so one retry would
 * already be generous; three costs nothing because the Argon2id run is done
 * once, before the first attempt, and a retry only changes the handle.
 */
const MAX_HANDLE_ATTEMPTS = 3;

const kdfDescriptorSchema = z.object({
  salt: z.string(),
  params: z.object({
    memorySizeKib: z.number().int().positive(),
    iterations: z.number().int().positive(),
    parallelism: z.number().int().positive(),
  }),
});

/** A session response. The account is echoed back; the session itself rides an httpOnly cookie this code never touches. */
const sessionSchema = z.object({
  account: z.object({ id: z.number().int(), handle: z.string() }),
});

/**
 * Calls a same-origin sync endpoint and decodes the body.
 *
 * Failures are THROWN as `SyncRequestError`, never returned as a flag, because
 * every one of them means the operation did not happen. The `kind` is what the
 * `sign-in-error` and `signup-error` classifiers read, so a caller branches on
 * the status and never on the prose (`PROTOCOL.md` section 4).
 */
async function requestJson<T>({
  path,
  method,
  body,
  schema,
}: {
  path: string;
  method: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  schema: z.ZodType<T>;
}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw new SyncRequestError({
      kind: 'transport',
      message: cause instanceof Error ? cause.message : 'The sync service could not be reached.',
    });
  }

  if (!response.ok) {
    throw new SyncRequestError({
      kind: errorKindForStatus(response.status),
      message: await readErrorMessage(response),
      status: response.status,
    });
  }

  const payload: unknown = await response.json().catch(() => null);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new SyncRequestError({
      kind: 'transport',
      message: 'The sync service answered in a shape this build could not read.',
      status: response.status,
    });
  }
  return parsed.data;
}

/** Best-effort prose from an error body, for `describeErrorForUser` to show when there is no better copy. */
async function readErrorMessage(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null);
  const parsed = z.object({ error: z.string() }).safeParse(payload);
  return parsed.success ? parsed.data.error : `Request failed with status ${response.status}.`;
}

/**
 * Fetches the KDF descriptor for a handle.
 *
 * NEVER BRANCH ON THIS to decide whether an account exists. The endpoint
 * answers `200` for every handle, serving a deterministic dummy for the ones it
 * does not know, precisely so that a caller cannot turn it into an
 * account-enumeration oracle. An unknown handle therefore derives a perfectly
 * well-formed credential that the login then rejects, which is the intended
 * behaviour and not a bug to smooth over.
 *
 * A POST rather than a GET, and not for REST tidiness: a handle in a query
 * string is a handle written into the reverse proxy's access log, the
 * browser's history and any outgoing `Referer`. It is the only identifier this
 * service holds for a person, so it travels in a body.
 */
export async function fetchKdfDescriptor(handle: string): Promise<PassphraseKdfDescriptor> {
  return requestJson({
    path: '/api/v1/auth/kdf',
    method: 'POST',
    body: { handle },
    schema: kdfDescriptorSchema,
  });
}

/** What a completed setup hands back to the ceremony: the two things the user must save, and nothing else. */
export interface CreatedSyncAccount {
  handle: string;
  /** The grouped recovery code, for its one and only display. It is not stored anywhere. */
  recoveryCode: string;
}

function toWireKeyRecord(kind: 'passphrase' | 'recovery', record: SyncKeySetupRecord) {
  return {
    kind,
    kdfDescriptor: record.kdfDescriptor,
    wrappedDek: bytesToBase64(record.wrappedDek),
  };
}

/**
 * Provisions a sync account: one Argon2id run, both wrapped-DEK records, one
 * signup.
 *
 * The handle is minted HERE rather than in a component, because
 * `generateHandle` reads the CSPRNG and a value drawn during render would
 * differ between the server pass and the client pass and break hydration.
 *
 * Both key records go up with the signup in one request. Creating the account
 * first and writing the records after would leave a window in which a crash
 * produces an account that can log in and decrypt nothing, which is the exact
 * brick `PROTOCOL.md` section 5.14 refuses to permit.
 */
export async function createSyncAccount({ passphrase }: { passphrase: string }): Promise<CreatedSyncAccount> {
  const recoveryCode = generateRecoveryCode();
  const keys = await setupSyncKeys({
    passphrase,
    recoveryCodeRaw: recoveryCode.raw,
    deriveHash: workerArgon2idDeriver,
  });
  const recoveryAuthHash = await deriveRecoveryAuthHash(recoveryCode.raw);
  const keyRecords = [
    toWireKeyRecord('passphrase', keys.passphraseKeyRecord),
    toWireKeyRecord('recovery', keys.recoveryKeyRecord),
  ];

  let attempt = 1;
  while (attempt <= MAX_HANDLE_ATTEMPTS) {
    const handle = generateHandle();
    try {
      await requestJson({
        path: '/api/v1/auth/signup',
        method: 'POST',
        body: {
          handle,
          authHash: keys.authHash,
          recoveryAuthHash,
          kdfDescriptor: keys.kdfDescriptor,
          keyRecords,
        },
        schema: sessionSchema,
      });
      return { handle, recoveryCode: recoveryCode.formatted };
    } catch (cause) {
      // A taken handle is the ONE retryable signup failure: the handle is
      // machine-minted, so a collision is our problem to solve and not
      // something to report to a user who did not choose it. Anything else is
      // rethrown untouched for the classifier to read.
      // The classifier owns the status-to-meaning mapping, so this reads the
      // protocol's answer rather than re-deriving it from a status code here.
      // `null` for the signup mode is honest: this client does not fetch the
      // handshake, so it must not promise that an invite would help.
      if (classifySignupFailure(cause, null) !== 'handle-taken') throw cause;
      attempt += 1;
    }
  }
  throw new SyncRequestError({ kind: 'conflict', message: 'Every minted handle was already taken.', status: 409 });
}

/**
 * Signs in on a second device.
 *
 * The passphrase is stretched here and the derived `authHash` is what travels.
 * The service answers one `401` for an unknown handle and for a wrong
 * passphrase alike, deliberately, so the caller must not try to say which.
 */
export async function signInToSync({ handle, passphrase }: { handle: string; passphrase: string }): Promise<void> {
  const normalized = normalizeHandle(handle);
  const descriptor = await fetchKdfDescriptor(normalized);
  const { authHash } = await deriveCredentialsFromPassphrase({
    passphrase,
    descriptor,
    deriveHash: workerArgon2idDeriver,
  });
  await requestJson({
    path: '/api/v1/auth/login',
    method: 'POST',
    body: { handle: normalized, authHash },
    schema: sessionSchema,
  });
}

/** Ends the session on this device. The local data stays where it is; only the sync link goes. */
export async function signOutOfSync(): Promise<void> {
  const response = await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'same-origin' });
  if (!response.ok) {
    throw new SyncRequestError({
      kind: errorKindForStatus(response.status),
      message: await readErrorMessage(response),
      status: response.status,
    });
  }
}
