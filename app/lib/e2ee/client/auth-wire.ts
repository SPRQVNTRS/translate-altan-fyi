/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/engine/client/auth-wire.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * The `/v1/auth/*` wire shapes, transcribed from `openplate-sync/PROTOCOL.md`
 * §5.7–§5.15.
 *
 * WHY THESE AREN'T IN `protocol.ts`: that file is the hand-maintained
 * duplicate of `openplate-sync/src/protocol.ts`, and changing the contract it
 * describes means editing FOUR places (both copies plus both transcribed-
 * literal drift-guard tests). The account endpoints arrived with the
 * standalone service in M128 spec 02 and were never mirrored into the client
 * copy; adding them here — CLIENT-SIDE ONLY, alongside the code that calls
 * them — keeps this spec from making a unilateral edit to a two-repo contract
 * file. Folding `AUTH_API_PREFIX` and these shapes into both `protocol.ts`
 * copies is a real and probably correct follow-up; it is a contract change,
 * not a side effect of wiring a client.
 *
 * These are transport shapes, not domain types. Nothing here is secret: the
 * only sensitive value that ever appears in one of these bodies is `authHash`,
 * which is the `AUTH` HKDF branch (`derive-credentials.ts`) — a sibling of the
 * KEK, never the KEK itself and never the passphrase.
 */
import type { Base64Bytes, IsoTimestamp, SyncKeyRecordKind } from '#app/lib/e2ee/protocol';
import type { KdfDescriptor } from '#app/lib/e2ee/kdf-descriptor';

/** Mount prefix for the account endpoints; the blob endpoints live beside it under `SYNC_API_PREFIX`. */
export const AUTH_API_PREFIX = '/v1/auth';

/** Argon2id salt + cost parameters — non-secret by design; served pre-login so a new device can derive. */
export interface KdfDescriptorWire {
  /** base64, 16 bytes. */
  salt: string;
  params: {
    memorySizeKib: number;
    iterations: number;
    parallelism: number;
  };
}

/** `POST /v1/auth/kdf` — the pre-login lookup. An UNKNOWN handle gets a stable, real-shaped dummy, never a 404. */
export interface KdfDescriptorResponse {
  kdfDescriptor: KdfDescriptorWire;
}

/** The account as the service describes it. No credential material of any kind, and since M181 no address either. */
export interface AccountSummaryWire {
  id: number;
  /** The account's canonical handle: NFKC, trimmed, lowercased by the service, and never containing `@`. */
  handle: string;
  displayName: string | null;
}

/**
 * A freshly minted token pair. Both are opaque random strings the service
 * stores only as SHA-256 digests (`PROTOCOL.md` §4.2).
 */
export interface SessionTokensWire {
  accessToken: string;
  accessTokenExpiresAt: IsoTimestamp;
  refreshToken: string;
  refreshTokenExpiresAt: IsoTimestamp;
}

/**
 * A signed-in account and its tokens.
 *
 * `tokens` IS NEVER NULL. It was nullable while an instance could withhold a
 * session until an address was confirmed; M181 deleted verification along with
 * every other use of a mailbox, so signup, login and both recovery endpoints
 * hand out a session or fail. Keeping the nullable shape would have kept a
 * dead branch alive in every caller.
 */
export interface SessionResponseWire {
  account: AccountSummaryWire;
  tokens: SessionTokensWire;
}

export interface SignupRequestWire {
  handle: string;
  authHash: Base64Bytes;
  kdfDescriptor: KdfDescriptorWire;
  displayName: string | null;
  /**
   * The recovery code's auth proof — the SECOND authenticator, set at signup
   * or never (`PROTOCOL.md` §5.8). Derived under the `RECOVERY_AUTH` HKDF
   * label, which is never the `RECOVERY_KEK` label.
   *
   * `null` is a real value here, not an omission: an account may exist with no
   * second authenticator, and saying so explicitly is what keeps a typo in
   * this field name from silently creating an unrecoverable account.
   */
  recoveryAuthHash: Base64Bytes | null;
  /**
   * The single-use token an invite-only instance requires (PROTOCOL.md
   * §5.8.1). Omitted entirely on an open instance — an explicit `null` would
   * be a value the service has no rule for.
   */
  inviteToken?: string;
}

export interface LoginRequestWire {
  handle: string;
  authHash: Base64Bytes;
}

export interface RefreshRequestWire {
  refreshToken: string;
}

export interface RefreshResponseWire {
  tokens: SessionTokensWire;
}

/**
 * A key record as submitted alongside a credential rotation (§5.14). Note the
 * missing `expectedUpdatedAt`: the whole rotation applies atomically
 * server-side, so these are not individually CAS-gated the way §5.4's
 * standalone `PUT` is.
 */
export interface KeyRecordSubmissionWire {
  kind: SyncKeyRecordKind;
  kdfDescriptor: KdfDescriptor | null;
  wrappedDek: Base64Bytes;
}

/** `POST /v1/auth/change-passphrase` — proof is the CURRENT passphrase's auth branch. */
export interface ChangePassphraseRequestWire {
  currentAuthHash: Base64Bytes;
  newAuthHash: Base64Bytes;
  kdfDescriptor: KdfDescriptorWire;
  /** MUST be present, even as `[]`. An absent key is a `400` — silence is never read as consent on a path that can strand data. */
  keyRecords: KeyRecordSubmissionWire[];
}

/**
 * `POST /v1/auth/recover` — log in with the recovery code instead of the
 * passphrase.
 *
 * It replaced `POST /v1/auth/reset`, whose proof was a mailed token. On a
 * zero-knowledge service that link was an account-TAKEOVER path returning no
 * recovery: whoever held the mailbox got a login to a diary they still could
 * not read, and could lock the owner out on the way. The recovery code is held
 * by the user and never by the server, so it both authenticates AND unwraps.
 */
export interface RecoverRequestWire {
  handle: string;
  recoveryAuthHash: Base64Bytes;
}

/**
 * `POST /v1/auth/recover-rotate` — prove the recovery code and set a new
 * passphrase, in ONE request applied as one transaction.
 *
 * The proof travels here rather than in a session minted by `/recover`, so the
 * code is checked in the same call that writes. A `passphrase` key record is
 * REQUIRED: the passphrase-KEK necessarily changed, so accepting the rotation
 * without a re-wrapped DEK would mint an account that logs in perfectly and
 * decrypts nothing.
 */
export interface RecoverRotateRequestWire {
  handle: string;
  recoveryAuthHash: Base64Bytes;
  newAuthHash: Base64Bytes;
  kdfDescriptor: KdfDescriptorWire;
  keyRecords: KeyRecordSubmissionWire[];
  /** Present only when the recovery code itself is being replaced — and then a `recovery` key record must accompany it, or the service refuses both halves. */
  newRecoveryAuthHash?: Base64Bytes;
}

/** Both rotation endpoints return a fresh pair for the caller. */
export interface RotationResponseWire {
  tokens: SessionTokensWire;
}

export interface AccountResponseWire {
  account: AccountSummaryWire;
}

/** `POST /v1/auth/delete` — re-authentication required even though the caller already holds a token. */
export interface DeleteAccountRequestWire {
  authHash: Base64Bytes;
}
