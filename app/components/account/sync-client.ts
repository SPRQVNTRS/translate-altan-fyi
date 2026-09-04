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
import { setupSyncKeys, type SyncKeySetupRecord, type SyncKeySetupResult } from '#app/lib/e2ee/client/setup-keys';
import { errorKindForStatus, SyncRequestError } from '#app/lib/e2ee/client/sync-error';
import { base64ToBytes, bytesToBase64 } from '#app/lib/e2ee/crypto/base64';
import { unwrapDek } from '#app/lib/e2ee/crypto/dek-wrap';
import { generateHandle, normalizeHandle } from '#app/lib/e2ee/flows/handle';
import { classifySignupFailure } from '#app/lib/e2ee/flows/signup-error';
import { reportError } from '#app/lib/report-error';

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

/**
 * The response is an ENVELOPE, not a bare descriptor (`PROTOCOL.md` section
 * 5.7). This client read the bare shape once and every second-device sign in
 * died silently between the KDF call and the login call, because the parse
 * threw before the login was ever attempted. `sync-ui.test.ts` now parses a
 * literal transcribed from the document through this schema, so the two cannot
 * drift apart again without a red test.
 */
export const kdfResponseSchema = z.object({ kdfDescriptor: kdfDescriptorSchema });

/**
 * A session response, shared by signup (`201`) and login (`200`), which
 * `PROTOCOL.md` sections 5.8 and 5.9 give the same shape:
 * `{"account": {...}, "tokens": {...}}`.
 *
 * Only the fields this client actually reads are required. `tokens` is
 * deliberately NOT modelled: the auth routes set an httpOnly session cookie,
 * so no code here may hold a bearer token, and a schema that required one
 * would be asserting a dependency this client must not have.
 */
export const sessionSchema = z.object({
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
  const response = await requestJson({
    path: '/api/v1/auth/kdf',
    method: 'POST',
    body: { handle },
    schema: kdfResponseSchema,
  });
  return response.kdfDescriptor;
}

/**
 * What a completed setup hands back to the ceremony: the two things the user
 * must save, and the session the sync engine then runs under.
 *
 * `dek` LEAVES THIS MODULE, and that is the one deliberate widening of the
 * boundary in this file's header. It goes to `setSyncSession`, which holds it
 * in a module variable for the lifetime of the page and writes it nowhere. It
 * must not be logged, stored, serialized or put in a form.
 */
export interface CreatedSyncAccount {
  handle: string;
  /** The grouped recovery code, for its one and only display. It is not stored anywhere. */
  recoveryCode: string;
  /** The account row id, which binds the sync envelope's AAD to this account. Not a secret. */
  accountId: number;
  /** The unwrapped data key, straight from the setup run — memory only, never persisted. */
  dek: Uint8Array;
}

/** What a sign-in resolves to: everything the sync engine needs, and nothing the user has to read. */
export interface UnlockedSyncSession {
  accountId: number;
  /** The DEK, unwrapped on this device from the account's `passphrase` key record. Memory only. */
  dek: Uint8Array;
}

/** The record kinds, in the order setup writes them. */
export type SyncKeyRecordKind = 'passphrase' | 'recovery';

/**
 * The signup request body, built as a value so a test can inspect it.
 *
 * ── The defect this shape exists to prevent ──────────────────────────────
 *
 * This body used to carry a `keyRecords` array. `PROTOCOL.md` section 5.8 does
 * not define that field, so the service ignored it and answered `201`. Every
 * account created that way had a session, a verifier, and NO wrapped DEK
 * anywhere on the server: the passphrase authenticated and there was nothing
 * for a second device to unwrap. The whole feature failed silently behind a
 * success status, and no gate could see it, because sending a field a server
 * does not read is invisible from this side.
 *
 * The fields below are exactly section 5.8's list and nothing else.
 * `displayName` is omitted rather than sent as `null`: the protocol makes it
 * optional and this product has no display name to put in it.
 *
 * ── `inviteToken`, and the second silent failure it exists to prevent ────
 *
 * This installation is invite only (M184, ADR-0009), so `POST
 * /v1/auth/signup` refuses with `403` unless the body carries a token
 * section 5.8.1 recognises. This client sent no such field, which meant every
 * browser signup was refused, the operator's own first one included: the
 * server half of the gate shipped and the form had no way to satisfy it. The
 * shape of that defect is the same as the `keyRecords` one above, a client and
 * a document disagreeing about one key, so it is recorded in the same place.
 *
 * IT IS OMITTED WHEN ABSENT, never sent as `null` or as `''`. The service reads
 * an empty string as "no token presented" and refuses it, which is correct, but
 * a field that is present and meaningless is a request nobody can reason about.
 * One field carries either an invite or the one-shot bootstrap token, because
 * the service accepts them in the same place and a person holding one has no
 * way to tell you which kind it is.
 */
export interface SignupRequestBody {
  handle: string;
  authHash: string;
  kdfDescriptor: PassphraseKdfDescriptor;
  recoveryAuthHash: string;
  /** An invite, or the bootstrap token. Absent, not empty, when the caller has neither. */
  inviteToken?: string;
}

export function buildSignupRequest(input: {
  handle: string;
  authHash: string;
  recoveryAuthHash: string;
  kdfDescriptor: PassphraseKdfDescriptor;
  /** Trimmed by the caller. An empty value leaves the key out entirely. */
  inviteToken?: string;
}): SignupRequestBody {
  const body: SignupRequestBody = {
    handle: input.handle,
    authHash: input.authHash,
    kdfDescriptor: input.kdfDescriptor,
    recoveryAuthHash: input.recoveryAuthHash,
  };
  // Assigned rather than spread, so an absent invite omits the field instead of
  // sending an explicit `undefined`. `auth-client.ts` does the same, for the
  // same reason.
  if (input.inviteToken !== undefined && input.inviteToken !== '') body.inviteToken = input.inviteToken;
  return body;
}

/**
 * One `PUT /key-records` body (`PROTOCOL.md` section 5.4).
 *
 * `expectedUpdatedAt` IS ALWAYS PRESENT, and at setup it is always `null`,
 * which is the caller asserting "no record of this kind exists yet". The route
 * rejects a body that merely omits the key, on purpose: a missing CAS token is
 * a caller who has not thought about concurrency, and accepting it is how one
 * device silently overwrites another device's rotation.
 *
 * The `kdfDescriptor` nullability is not a style choice either. A `passphrase`
 * record must carry the account's descriptor so any device can re-derive the
 * KEK; a `recovery` record must carry `null`, because that path is HKDF-only
 * and has no parameters to record. The service returns `400` for either
 * mistake.
 */
export interface KeyRecordRequestBody {
  /** The account's Argon2id descriptor for a `passphrase` record; `null` for a `recovery` one. */
  kdfDescriptor: SyncKeySetupRecord['kdfDescriptor'];
  /** Base64 of the packed IV, ciphertext and tag. */
  wrappedDek: string;
  /** The CAS token. Always present, and `null` at setup: "no record of this kind exists yet". */
  expectedUpdatedAt: string | null;
}

export function buildKeyRecordRequest(input: {
  kind: SyncKeyRecordKind;
  record: SyncKeySetupRecord;
}): KeyRecordRequestBody {
  return {
    kdfDescriptor: input.record.kdfDescriptor,
    wrappedDek: bytesToBase64(input.record.wrappedDek),
    expectedUpdatedAt: null,
  };
}

/**
 * The account's wrapped-DEK records (`PROTOCOL.md` section 5.3).
 *
 * THE ENVELOPE KEY IS `records`, AS THE DOCUMENT SPELLS IT. This schema once
 * read `keyRecords`, because the route answered that; both were a drift
 * introduced by the port, and both were corrected together —
 * `app/routes/api.v1.sync.key-records.ts` now answers section 5.3's shape.
 * Recorded here rather than left for a reader to discover through a silent
 * parse failure.
 *
 * `kdfDescriptor` is deliberately not modelled. It is on the wire, and the
 * unwrap below does not need it: the descriptor this device derived its KEK
 * from came from `POST /v1/auth/kdf`, which is the account's own, and reading
 * a second copy here would only create a second thing that could disagree.
 *
 * EXPORTED SO A TEST CAN REACH IT. `sync-ui.test.ts` parses a literal
 * transcribed from section 5.3 through this schema, the same treatment
 * `kdfResponseSchema` and `sessionSchema` get for 5.7 and 5.8. Nothing else
 * would catch a re-drift: this schema is reached only through `signInToSync`,
 * behind Argon2 and three endpoints, and the port already answered
 * `{keyRecords: ...}` here once.
 */
export const keyRecordsResponseSchema = z.object({
  records: z.array(
    z.object({
      kind: z.string(),
      /** Base64 of the packed IV, ciphertext and tag (`PROTOCOL.md` section 4). */
      wrappedDek: z.string().min(1),
      /** The CAS token for the next write to this record. Read here only so the shape is asserted whole. */
      updatedAt: z.string(),
    }),
  ),
});

/**
 * The stored record echoed back by a successful `PUT` (`PROTOCOL.md` section
 * 5.4). BARE, with no wrapper key: 5.4 says the body is "the stored record,
 * same shape as a `GET /key-records` entry".
 *
 * EXPORTED SO A TEST CAN REACH IT, for the same reason as the schema above:
 * `sync-ui.test.ts` pins it against a literal transcribed from section 5.4,
 * and that pin is the only thing standing between this client and a silent
 * re-drift back to the `{keyRecord: ...}` wrapper the port wrote.
 */
export const keyRecordResponseSchema = z.object({
  kind: z.string(),
  wrappedDek: z.string(),
  updatedAt: z.string(),
});

/**
 * Writes one wrapped-DEK record with the session the signup just issued.
 *
 * The kind travels as `?kind=`, which is this repo's URL shape for what
 * `PROTOCOL.md` spells `/key-records/:kind`. The route's own header records
 * that difference; the submission is identical either way.
 */
async function putKeyRecord(input: { kind: SyncKeyRecordKind; record: SyncKeySetupRecord }): Promise<void> {
  await requestJson({
    path: `/api/v1/sync/key-records?kind=${input.kind}`,
    method: 'PUT',
    body: buildKeyRecordRequest(input),
    schema: keyRecordResponseSchema,
  });
}

/**
 * Destroys an account whose key records could not be written.
 *
 * WHY DELETE RATHER THAN LEAVE IT. At this point the account exists, holds a
 * session, and can never decrypt anything: it is the exact unopenable state
 * this whole fix is about. Leaving it would hand the user a handle and a
 * recovery code that look like credentials and are not, which is strictly
 * worse than no account, because they would file it away and trust it. The
 * account is seconds old and holds no data, so there is nothing to lose by
 * removing it, and a clean retry is then possible.
 *
 * It re-authenticates with the same `authHash` the signup used, which the
 * endpoint requires so that a stray cookie cannot destroy an account.
 *
 * A failure here is REPORTED, never thrown: the caller is already handling a
 * more important error, and replacing that cause with a cleanup failure would
 * hide what actually went wrong.
 */
async function deleteHalfBuiltAccount(authHash: string): Promise<void> {
  try {
    const response = await fetch('/api/v1/auth/account', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ authHash }),
    });
    if (!response.ok) {
      reportError(new Error(`rollback failed with status ${response.status}`), {
        operation: 'create-account',
        step: 'deleteHalfBuiltAccount',
      });
    }
  } catch (cause) {
    reportError(cause, { operation: 'create-account', step: 'deleteHalfBuiltAccount' });
  }
}

/**
 * Provisions a sync account: one Argon2id run, one signup, then both
 * wrapped-DEK records.
 *
 * ── The order, and why it is not negotiable ──────────────────────────────
 *
 * The key-record endpoint is authenticated, so the records cannot be written
 * until the signup has issued a session. That leaves a window in which the
 * account exists and cannot decrypt anything, and the ONLY safe way to close
 * it is to refuse to report success until both records have landed. If either
 * write fails the account is deleted and the error is rethrown, so the user
 * never sees a recovery code for an account that cannot use one.
 *
 * The handle is minted HERE rather than in a component, because
 * `generateHandle` reads the CSPRNG and a value drawn during render would
 * differ between the server pass and the client pass and break hydration.
 */
export async function createSyncAccount({
  passphrase,
  inviteToken,
}: {
  passphrase: string;
  /**
   * The invite or bootstrap token the person typed, already trimmed by the
   * form. It travels from here to the signup body and nowhere else: it is a
   * bearer credential, so nothing may log it, store it or put it in a URL.
   */
  inviteToken?: string;
}): Promise<CreatedSyncAccount> {
  const recoveryCode = generateRecoveryCode();
  const keys = await setupSyncKeys({
    passphrase,
    recoveryCodeRaw: recoveryCode.raw,
    deriveHash: workerArgon2idDeriver,
  });
  const recoveryAuthHash = await deriveRecoveryAuthHash(recoveryCode.raw);

  const created = await signUp({ keys, recoveryAuthHash, inviteToken });

  try {
    // Sequential, not concurrent. Two writes against the same account through
    // one session is not a race worth running in parallel to save a round
    // trip, and a sequential pair fails on the first problem with a smaller
    // mess to undo.
    await putKeyRecord({ kind: 'passphrase', record: keys.passphraseKeyRecord });
    await putKeyRecord({ kind: 'recovery', record: keys.recoveryKeyRecord });
  } catch (cause) {
    await deleteHalfBuiltAccount(keys.authHash);
    throw cause;
  }

  return {
    handle: created.handle,
    recoveryCode: recoveryCode.formatted,
    accountId: created.accountId,
    // The DEK the setup run just generated. Returning it is what lets the first
    // device sync without a second Argon2id run to reopen what it just created.
    dek: keys.dek,
  };
}

/**
 * Creates the account row, minting a fresh handle for as long as the service
 * keeps answering `409`.
 *
 * @returns the handle the account was actually created under, and the id the
 * service assigned it. The id comes out of the signup response that
 * `sessionSchema` already parses, rather than a second round trip, and the
 * sync envelope's AAD is bound to it.
 */
async function signUp(input: {
  keys: SyncKeySetupResult;
  recoveryAuthHash: string;
  /** Carried through unchanged. A retry re-presents the SAME token under a new handle. */
  inviteToken?: string;
}): Promise<{ handle: string; accountId: number }> {
  let attempt = 1;
  while (attempt <= MAX_HANDLE_ATTEMPTS) {
    const handle = generateHandle();
    try {
      const session = await requestJson({
        path: '/api/v1/auth/signup',
        method: 'POST',
        body: buildSignupRequest({
          handle,
          authHash: input.keys.authHash,
          recoveryAuthHash: input.recoveryAuthHash,
          kdfDescriptor: input.keys.kdfDescriptor,
          inviteToken: input.inviteToken,
        }),
        schema: sessionSchema,
      });
      return { handle, accountId: session.account.id };
    } catch (cause) {
      // A taken handle is the ONE retryable signup failure: the handle is
      // machine-minted, so a collision is our problem to solve and not
      // something to report to a user who did not choose it. The classifier
      // owns the status-to-meaning mapping.
      //
      // THE MODE IS `'invite'` AND NOT `null`. It used to be `null`, which was
      // the honest answer while this client did not know what the service
      // wanted. It knows now: this client and the service are the same
      // deployment, and `e2ee-context.server.ts` hard-codes invite-only with a
      // comment saying no environment variable can move it. Reporting `null`
      // here would collapse an invite problem into the generic refusal and send
      // a person hunting for a door that is not shut.
      //
      // A RETRY RE-PRESENTS THE SAME INVITE, and that is safe: a `409` means the
      // signup never reached the redemption, so the token is still unspent.
      if (classifySignupFailure(cause, 'invite') !== 'handle-taken') throw cause;
      attempt += 1;
    }
  }
  throw new SyncRequestError({ kind: 'conflict', message: 'Every minted handle was already taken.', status: 409 });
}

/**
 * Signs in on a second device, and opens the account's data key.
 *
 * The name the sign-in screen calls {@link unlockSyncSession} by. The
 * sequence, and every reason behind it, is documented there.
 */
export async function signInToSync(input: { handle: string; passphrase: string }): Promise<UnlockedSyncSession> {
  return unlockSyncSession(input);
}

/**
 * Opens the account's data key from a handle and a passphrase, and takes the
 * session that comes with it.
 *
 * THE SAME WIRE SEQUENCE AS A SIGN-IN, because it is the same work: fetch the
 * account's KDF descriptor, stretch the passphrase once, log in with the
 * derived hash, and unwrap the DEK from the `passphrase` key record under the
 * KEK. `signInToSync` above is this function under the name the sign-in screen
 * calls it by; the difference is the user's intent, not the protocol.
 *
 * IT EXISTS SEPARATELY FOR THE UNLOCK CARD. The DEK lives in memory only, so a
 * reload leaves a browser SIGNED IN AND UNABLE TO SYNC, and the only way back
 * is Argon2id over the passphrase again. Writing that sequence a second time
 * in a component would be a second derivation path to keep correct, and the
 * first one to drift would be the one nobody drives in a browser.
 *
 * The login call is not skipped for the unlock case even though the session
 * cookie would already authenticate the key-records read. It is what checks
 * the passphrase server side, with the same single `401` for a wrong
 * passphrase and an unknown handle, and it refreshes the token family the
 * device will sync under. The service answers that one `401` for an unknown
 * handle and for a wrong passphrase alike, deliberately, so no caller may try
 * to say which.
 *
 * ── Why the unwrap belongs in the same call ──────────────────────────────
 *
 * The one Argon2id run behind the login produces BOTH the `authHash` that
 * travels and the `passphraseKek` that stays. Splitting the unwrap into a
 * later call would mean either stretching the passphrase a second time, at the
 * cost the user feels as a frozen screen, or holding the passphrase somewhere
 * beyond this call frame — and there is no such somewhere. So the KEK is used
 * where it is derived, and only the unwrapped DEK leaves.
 */
export async function unlockSyncSession({
  handle,
  passphrase,
}: {
  handle: string;
  passphrase: string;
}): Promise<UnlockedSyncSession> {
  const normalized = normalizeHandle(handle);
  const descriptor = await fetchKdfDescriptor(normalized);
  const { authHash, passphraseKek } = await deriveCredentialsFromPassphrase({
    passphrase,
    descriptor,
    deriveHash: workerArgon2idDeriver,
  });
  const session = await requestJson({
    path: '/api/v1/auth/login',
    method: 'POST',
    body: { handle: normalized, authHash },
    schema: sessionSchema,
  });

  const dek = await unwrapPassphraseDek(passphraseKek);
  return { accountId: session.account.id, dek };
}

/**
 * Reads the account's key records and unwraps the DEK under the
 * passphrase-derived KEK.
 *
 * AN ACCOUNT WITH NO `passphrase` RECORD IS UNOPENABLE. The passphrase
 * authenticates and there is nothing on the server for it to unwrap, so no
 * device can ever read that account's data. `deleteHalfBuiltAccount` above
 * exists precisely so our own setup path cannot create this state: it destroys
 * an account whose key records did not land rather than reporting a success
 * that would hand the user credentials that are not credentials. Reaching this
 * throw therefore means the account was made some other way.
 *
 * The unwrap itself throws a bare `OperationError` from WebCrypto when the KEK
 * is wrong, which is deliberate on the crypto side — a GCM tag check does not
 * say WHY it failed — and is left to propagate: `classifySignInFailure`
 * already treats an unrecognised cause as the generic failure, and inventing a
 * more specific message here would be guessing.
 */
async function unwrapPassphraseDek(passphraseKek: CryptoKey): Promise<Uint8Array> {
  const response = await requestJson({
    path: '/api/v1/sync/key-records',
    method: 'GET',
    schema: keyRecordsResponseSchema,
  });
  const record = response.records.find((candidate) => candidate.kind === 'passphrase');
  if (record === undefined) {
    throw new SyncRequestError({
      kind: 'invalid',
      message: 'This account holds no key for this passphrase, so its synced data cannot be opened.',
    });
  }
  return unwrapDek({ wrappedDek: base64ToBytes(record.wrappedDek), kek: passphraseKek });
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
