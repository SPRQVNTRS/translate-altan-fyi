/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/engine/client/auth-client.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * The account half of the sync client: everything under `/v1/auth/*`, plus
 * the token lifecycle that keeps a session alive without ever holding the
 * passphrase (`PROTOCOL.md` §4.2, §5.7–§5.15).
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD: the master passphrase is never
 * stored, never cached, never logged, and never sent. It enters
 * `derive-credentials.ts` as an argument, produces `authHash` (a sibling HKDF
 * branch, useless for decryption) and the KEK, and is unreachable from
 * anywhere else. This class never accepts a passphrase at all — callers hand
 * it an already-derived `authHash` — which makes the invariant structural
 * rather than a rule someone has to remember.
 *
 * TOKENS LIVE IN MEMORY ONLY, and that is a design decision with a visible
 * consequence: reloading the page signs the session out and the user re-enters
 * their passphrase. That is not an oversight to be "fixed" with localStorage.
 * A persisted refresh token would only restore the SESSION — the DEK still
 * cannot be re-derived without the passphrase, so the user has to be prompted
 * anyway, and the persisted token would buy nothing except an XSS-readable
 * credential sitting on disk. Bitwarden's vault locks on reload for the same
 * reason. The refresh token earns its keep WITHIN a session: access tokens
 * last 15 minutes and a sync session can outlive that many times over.
 *
 * REFRESHES ARE SERIALIZED (`refreshInFlight`). Rotation is single-use, so two
 * concurrent refreshes would spend the same token twice — and a REUSED refresh
 * token is the theft signal that revokes the whole family and logs the real
 * user out (§4.2). Two tabs racing look exactly like an attacker; the cross-tab
 * half of that is handled by the orchestrator's single-writer lock, and this
 * promise handles the in-tab half.
 *
 * TRIMMED ON COPY: `handshake()`, `signupMode()` and `notice()` are gone, along
 * with the `checkProtocolCompatibility` / `isProtocolHandshake` /
 * `readHandshakeNotice` imports they were the only users of. All three read
 * `/health` to interrogate an ARBITRARY remote sync server — its protocol
 * version, its signup policy, its operator banner — which is a self-hosting
 * affordance. Here the sync server is this same origin and this same process,
 * so there is nothing to discover and no version skew to guard against, and the
 * handshake half of the protocol has no caller.
 *
 * Restoring any of them means copying `openplate`'s CLIENT-side protocol half,
 * not editing this repo's `protocol.ts`. That file is the SERVICE half, which
 * `app/lib/e2ee/` deliberately keeps as the single transcription: it exposes
 * neither `readHandshakeNotice` nor a narrowing `isProtocolHandshake`, and
 * widening it to suit a client caller would break the server modules that
 * import it. Two protocol transcriptions in one repo is the drift ADR-0008
 * exists to bound.
 */
import {
  AUTH_API_PREFIX,
  type AccountResponseWire,
  type AccountSummaryWire,
  type ChangePassphraseRequestWire,
  type DeleteAccountRequestWire,
  type KdfDescriptorResponse,
  type KdfDescriptorWire,
  type KeyRecordSubmissionWire,
  type LoginRequestWire,
  type RefreshRequestWire,
  type RecoverRequestWire,
  type RecoverRotateRequestWire,
  type RefreshResponseWire,
  type RotationResponseWire,
  type SessionResponseWire,
  type SessionTokensWire,
  type SignupRequestWire,
} from './auth-wire';
import { errorKindForStatus, SyncRequestError } from './sync-error';
import { defaultFetchImpl } from './fetch-impl';
import type { JsonValue } from '#app/lib/e2ee/json';
import { z } from 'zod';

type FetchImpl = typeof fetch;

export interface SyncAuthClientOptions {
  baseUrl: string;
  fetchImpl?: FetchImpl;
}

/** What the blob client needs from an authenticated session — nothing more. */
export interface SyncTokenProvider {
  getAccessToken(): string | null;
  /** Spends the refresh token for a new pair. Returns the new access token, or `null` when the user must sign in again. */
  refreshAccessToken(): Promise<string | null>;
}

/** A signed-in session, as this client tracks it. Both tokens are memory-only (see the module header). */
export interface SyncAuthSession {
  account: AccountSummaryWire;
  tokens: SessionTokensWire;
}

/**
 * Held for the single round trip inside {@link SyncAuthClient.adoptTokens},
 * between "we have tokens" and "we have read who they belong to". It exists
 * only so the bearer header can be attached to that one request; nothing
 * outside that method ever observes it.
 */
const PENDING_ACCOUNT: AccountSummaryWire = { id: -1, handle: '', displayName: null };

export class SyncAuthClient implements SyncTokenProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;
  private session: SyncAuthSession | null = null;
  private refreshInFlight: Promise<string | null> | null = null;

  constructor({ baseUrl, fetchImpl = defaultFetchImpl }: SyncAuthClientOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
  }

  // -------------------------------------------------------------------------
  // Session state
  // -------------------------------------------------------------------------

  getSession(): SyncAuthSession | null {
    return this.session;
  }

  getAccessToken(): string | null {
    return this.session?.tokens.accessToken ?? null;
  }

  /** Drops all token state. Local only — call `logout()` to also revoke server-side. */
  clearSession(): void {
    this.session = null;
    this.refreshInFlight = null;
  }

  /**
   * Adopts a token pair minted elsewhere — a rotation endpoint that returns
   * fresh tokens for the caller without describing the account again.
   *
   * The account is then READ from `/v1/auth/account` rather than assumed. A
   * placeholder id would end up in the envelope's AAD, where it would bind
   * every blob this session wrote to an account that does not exist — silent
   * at write time and undecryptable forever afterwards.
   */
  async adoptTokens(tokens: SessionTokensWire): Promise<SyncAuthSession> {
    this.session = { account: PENDING_ACCOUNT, tokens };
    const account = await this.getAccount();
    const session: SyncAuthSession = { account, tokens };
    this.session = session;
    return session;
  }

  // -------------------------------------------------------------------------
  // Pre-login
  // -------------------------------------------------------------------------

  /**
   * Fetches the account's Argon2id salt and parameters BEFORE deriving
   * anything (§5.7). Never assume this build's defaults: an account created
   * under raised costs derives differently, and getting it wrong looks exactly
   * like a wrong passphrase.
   *
   * An unknown handle returns a stable, real-shaped dummy — by design, so
   * this endpoint cannot be used to enumerate accounts. The client cannot tell
   * the difference and must not try to.
   */
  async fetchKdfDescriptor(handle: string): Promise<KdfDescriptorWire> {
    const body = await this.requestJson<KdfDescriptorResponse>({
      path: `${AUTH_API_PREFIX}/kdf`,
      method: 'POST',
      body: { handle },
    });
    return body.kdfDescriptor;
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  /**
   * Creates an account and returns its first session.
   *
   * `recoveryAuthHash` is the second authenticator and is set HERE or never
   * (`PROTOCOL.md` §5.8). That is not a limitation to be worked around: the
   * client shows the handle and the recovery code together as one saved
   * account card, so signup is the one moment the user is holding both.
   */
  async signup(input: {
    handle: string;
    authHash: string;
    kdfDescriptor: KdfDescriptorWire;
    displayName?: string | null;
    /** The recovery code's auth proof, or `null` for an account with no second authenticator. */
    recoveryAuthHash?: string | null;
    /** Required by an invite-only instance; ignored by an open one. */
    inviteToken?: string;
  }): Promise<SessionResponseWire> {
    const request: SignupRequestWire = {
      handle: input.handle,
      authHash: input.authHash,
      kdfDescriptor: input.kdfDescriptor,
      displayName: input.displayName ?? null,
      recoveryAuthHash: input.recoveryAuthHash ?? null,
    };
    // Assigned rather than spread, so an absent invite omits the field instead
    // of sending an explicit `undefined`.
    if (input.inviteToken !== undefined) request.inviteToken = input.inviteToken;
    const response = await this.requestJson<SessionResponseWire>({
      path: `${AUTH_API_PREFIX}/signup`,
      method: 'POST',
      body: request,
    });
    this.adoptSession(response);
    return response;
  }

  async login(input: { handle: string; authHash: string }): Promise<SyncAuthSession> {
    const request: LoginRequestWire = { handle: input.handle, authHash: input.authHash };
    const response = await this.requestJson<SessionResponseWire>({
      path: `${AUTH_API_PREFIX}/login`,
      method: 'POST',
      body: request,
    });
    const session: SyncAuthSession = { account: response.account, tokens: response.tokens };
    this.session = session;
    return session;
  }

  /**
   * `POST /v1/auth/recover` — a session proved with the recovery code instead
   * of the passphrase.
   *
   * The session it returns is an ORDINARY one, deliberately: the holder of the
   * recovery code is the account owner by construction, and a lesser
   * "recovery mode" token would add a second authorization surface carrying no
   * property the code does not already have.
   *
   * Throttled per IP and handle server-side, and never cleared on success —
   * this endpoint accepts a guess at a value written on a piece of paper.
   */
  async recover(input: { handle: string; recoveryAuthHash: string }): Promise<SyncAuthSession> {
    const request: RecoverRequestWire = { handle: input.handle, recoveryAuthHash: input.recoveryAuthHash };
    const response = await this.requestJson<SessionResponseWire>({
      path: `${AUTH_API_PREFIX}/recover`,
      method: 'POST',
      body: request,
    });
    const session: SyncAuthSession = { account: response.account, tokens: response.tokens };
    this.session = session;
    return session;
  }

  /**
   * `POST /v1/auth/recover-rotate` — prove the recovery code and set a new
   * passphrase, atomically.
   *
   * `keyRecords` MUST carry the `passphrase` record re-wrapped under the new
   * KEK; the service refuses the rotation without it rather than mint an
   * account that signs in and decrypts nothing. Rotating the recovery code as
   * well is all-or-nothing: `newRecoveryAuthHash` and a `recovery` record
   * travel together or neither does.
   */
  async recoverRotate(input: {
    handle: string;
    recoveryAuthHash: string;
    newAuthHash: string;
    kdfDescriptor: KdfDescriptorWire;
    keyRecords: KeyRecordSubmissionWire[];
    newRecoveryAuthHash?: string;
  }): Promise<SyncAuthSession> {
    const request: RecoverRotateRequestWire = {
      handle: input.handle,
      recoveryAuthHash: input.recoveryAuthHash,
      newAuthHash: input.newAuthHash,
      kdfDescriptor: input.kdfDescriptor,
      keyRecords: input.keyRecords,
    };
    // Assigned rather than spread, so an unrotated code omits the field
    // instead of sending an explicit `undefined` the service has no rule for.
    if (input.newRecoveryAuthHash !== undefined) request.newRecoveryAuthHash = input.newRecoveryAuthHash;
    const response = await this.requestJson<SessionResponseWire>({
      path: `${AUTH_API_PREFIX}/recover-rotate`,
      method: 'POST',
      body: request,
    });
    const session: SyncAuthSession = { account: response.account, tokens: response.tokens };
    this.session = session;
    return session;
  }

  /**
   * Spends the current refresh token for a new pair.
   *
   * Returns `null` — rather than throwing — when the session is simply gone
   * (no token, or the service rejected it). "The user must sign in again" is
   * an expected state of a long-lived app, not an exceptional one, and the
   * caller's response to it is a prompt, never a crash. A transport failure
   * still throws: that is "we don't know", which must not be mistaken for
   * "you are signed out".
   */
  async refreshAccessToken(): Promise<string | null> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const refreshToken = this.session?.tokens.refreshToken;
    if (refreshToken === undefined) return null;

    this.refreshInFlight = this.performRefresh(refreshToken).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async performRefresh(refreshToken: string): Promise<string | null> {
    const request: RefreshRequestWire = { refreshToken };
    let response: RefreshResponseWire;
    try {
      response = await this.requestJson<RefreshResponseWire>({
        path: `${AUTH_API_PREFIX}/refresh`,
        method: 'POST',
        body: request,
      });
    } catch (error) {
      if (error instanceof SyncRequestError && error.kind === 'unauthorized') {
        this.clearSession();
        return null;
      }
      throw error;
    }
    const account = this.session?.account;
    if (account === undefined) return null;
    this.session = { account, tokens: response.tokens };
    return response.tokens.accessToken;
  }

  /** Revokes this device's token family server-side and drops local state. Other devices keep their sessions. */
  async logout(): Promise<void> {
    const token = this.getAccessToken();
    this.clearSession();
    if (token === null) return;
    try {
      await this.fetchImpl(`${this.baseUrl}${AUTH_API_PREFIX}/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // Local state is already cleared, which is the part the user can see.
      // A failed revocation leaves a token that expires on its own within
      // minutes; throwing here would turn "signed out" into an error screen.
    }
  }

  // -------------------------------------------------------------------------
  // Account management
  // -------------------------------------------------------------------------

  async getAccount(): Promise<AccountSummaryWire> {
    const body = await this.requestJson<AccountResponseWire>({
      path: `${AUTH_API_PREFIX}/account`,
      method: 'GET',
      authenticated: true,
    });
    return body.account;
  }

  /**
   * Rotates the passphrase: new verifier, new KDF descriptor, and the DEK
   * re-wrapped under the new KEK — applied atomically server-side, because a
   * verifier stored without its re-wrapped DEK produces an account that logs
   * in fine and can never decrypt its own data again.
   *
   * `keyRecords` must carry the re-wrapped passphrase record. The `recovery`
   * record wraps the same unchanged DEK and is deliberately left alone.
   */
  async changePassphrase(input: {
    currentAuthHash: string;
    newAuthHash: string;
    kdfDescriptor: KdfDescriptorWire;
    keyRecords: KeyRecordSubmissionWire[];
  }): Promise<SessionTokensWire> {
    const request: ChangePassphraseRequestWire = input;
    const body = await this.requestJson<RotationResponseWire>({
      path: `${AUTH_API_PREFIX}/change-passphrase`,
      method: 'POST',
      body: request,
      authenticated: true,
    });
    const account = this.session?.account;
    if (account !== undefined) this.session = { account, tokens: body.tokens };
    return body.tokens;
  }

  /**
   * Deletes the account and, by cascade, every blob and key record it owns.
   * No soft delete, no grace period.
   *
   * Re-authentication is required even though a valid token is already held:
   * a session left behind on a shared device must not be enough to destroy
   * someone's data irreversibly.
   */
  async deleteAccount(input: { authHash: string }): Promise<void> {
    const request: DeleteAccountRequestWire = { authHash: input.authHash };
    await this.requestJson<unknown>({
      path: `${AUTH_API_PREFIX}/delete`,
      method: 'POST',
      body: request,
      authenticated: true,
    });
    this.clearSession();
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /**
   * One request, with §11's "on 401, refresh once and retry once; on a second
   * 401, send the user to log in" rule implemented exactly once rather than at
   * every call site.
   */
  private async requestJson<T>({
    path,
    method,
    body,
    authenticated = false,
  }: {
    path: string;
    method: 'GET' | 'POST';
    body?: unknown;
    authenticated?: boolean;
  }): Promise<T> {
    const send = async (accessToken: string | null): Promise<Response> => {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (accessToken !== null) headers.Authorization = `Bearer ${accessToken}`;
      try {
        return await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        throw new SyncRequestError({
          kind: 'transport',
          message: error instanceof Error ? error.message : 'The sync server could not be reached.',
        });
      }
    };

    let response = await send(authenticated ? this.getAccessToken() : null);
    if (authenticated && response.status === 401) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed !== null) response = await send(refreshed);
    }
    if (!response.ok) throw await toRequestError(response);
    if (response.status === 204) {
      // SAFETY: a 204 carries no body by definition, and every call site that
      // can receive one asks for `T = void` (`logout`, `deleteAccount`).
      return undefined as T;
    }
    // SAFETY: `T` is fixed at each call site to the §5.x response shape that
    // path requests. Upstream this also leaned on the service being
    // version-checked by `handshake()` first; that method was TRIMMED ON COPY
    // (see this module's header), and the guarantee is now structural instead:
    // the service is this same origin and this same build, so there is no
    // version skew for a handshake to detect.
    return (await readJson(response)) as T;
  }

  private adoptSession(response: SessionResponseWire): void {
    this.session = { account: response.account, tokens: response.tokens };
  }
}

/** Builds a {@link SyncRequestError} from a non-2xx response, keeping the server's prose for diagnostics only. */
export async function toRequestError(response: Response): Promise<SyncRequestError> {
  const kind = errorKindForStatus(response.status);
  let message = `sync request failed with status ${response.status}`;
  try {
    const parsed = protocolErrorBodySchema.safeParse(await response.json());
    if (parsed.success) message = parsed.data.error;
  } catch {
    // A non-JSON error body is itself diagnostic; the status already carries
    // the meaning a client is allowed to branch on.
  }
  const retryAfter = response.headers.get('Retry-After');
  return new SyncRequestError({
    kind,
    message,
    status: response.status,
    retryAfterSeconds: retryAfter === null ? null : Number.parseInt(retryAfter, 10),
  });
}

/** Every non-2xx body the service documents (`ProtocolErrorResponse`); a blank `error` is treated as absent. */
const protocolErrorBodySchema = z.object({ error: z.string().min(1) });

async function readJson(response: Response): Promise<JsonValue> {
  try {
    return await response.json();
  } catch {
    throw new SyncRequestError({
      kind: 'transport',
      message: 'The sync server returned a response this app could not read.',
      status: response.status,
    });
  }
}
