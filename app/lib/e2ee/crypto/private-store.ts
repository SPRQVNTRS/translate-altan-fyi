/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/engine/crypto/private-store.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * The OWNER-PRIVATE COMPARTMENT's crypto (`openplate-sync` ADR-0002, "The
 * snapshot is partitioned — amendment, 2026-08-27").
 *
 * ── The problem, in one paragraph ─────────────────────────────────────────
 *
 * A share is full-DEK and the blob is the WHOLE snapshot, so "share the DEK"
 * silently means "share the DEK's entire domain". When the client put the
 * owner's share PRIVATE key and their pinned peers into that snapshot, it put
 * them into the very thing a grant discloses. That is a CASCADE, not a leak: a
 * grantee holding the grantor's share private key can decrypt every wrap
 * addressed to that grantor, so a dietician who is also somebody's patient
 * would hand their own grantee the keys to *their* patients' shares —
 * reaching a third party who made no trust decision about the recipient.
 *
 * ── The construction, frozen by the ADR ───────────────────────────────────
 *
 *   CDK       <- random 256-bit compartment data key
 *   slot 1    <- wrapDek(CDK, K_pp), K_pp = HKDF(Argon2id hash, salt = account
 *                salt, info = PRIVATE_STORE_KEK)
 *   slot 2    <- wrapDek(CDK, K_pr), K_pr = HKDF(recovery code, salt = empty,
 *                info = PRIVATE_STORE_RECOVERY_KEK)
 *   ciphertext<- iv || AES-256-GCM(CDK, plaintext, aad = AAD)
 *   AAD       <- {"accountId":<int>,"purpose":"private-store","v":1}
 *
 * The indirection through a CDK exists for the same reason the DEK's does:
 * TWO INDEPENDENT UNLOCK PATHS MUST OPEN ONE CIPHERTEXT. Losing the recovery
 * slot would mean a recovery-code restore recovered the diary and silently
 * lost every share key the account owns.
 *
 * ── What this module deliberately does NOT do ─────────────────────────────
 *
 * It knows only bytes. There is no third wrap format here: both slots are
 * `wrapDek`/`unwrapDek` — the same 60-byte `iv || ciphertext+tag` blob a key
 * record stores — because a second wrap implementation is how the packed-IV
 * convention drifts (see `dek-wrap.ts`'s finding #1). And it never learns what
 * the plaintext MEANS: serializing the owner-private region is
 * `app/lib/sync/private-store.ts`'s job, one level up.
 */
import { aesGcmDecrypt, aesGcmEncrypt, packIvAndCiphertext, splitIvAndCiphertext } from './aes-gcm';
import { bytesToBase64 } from './base64';
import { toBufferSource } from './buffer-source';
import { DEK_BYTES, unwrapDek, wrapDek } from './dek-wrap';

/**
 * The compartment data key's length — AES-256, the same size as the DEK.
 *
 * Deliberately expressed as `DEK_BYTES` rather than a second `32`: the two are
 * the same key size because they are the same primitive, and a future change
 * to one that silently left the other behind is exactly the drift this
 * aliasing prevents.
 */
export const CDK_BYTES = DEK_BYTES;

/** The compartment AAD's version field. Frozen: a change here makes every existing compartment unopenable. */
export const PRIVATE_STORE_AAD_VERSION = 1;

/** Generates a fresh random compartment data key. Memory only — it is never persisted unwrapped. */
export function generateCdk(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(CDK_BYTES));
}

/**
 * The compartment's additional authenticated data, as canonical fixed-key-order
 * JSON.
 *
 * Built by string concatenation rather than `JSON.stringify` of an object, for
 * the same reason `share-wrap.ts`'s AAD is: THE BYTE SEQUENCE IS THE CONTRACT,
 * and it must not depend on a property order the language merely happens to
 * preserve today. Binding `accountId` is what stops a malicious service from
 * splicing one account's compartment into another account's blob — that splice
 * becomes a tag failure instead of a misattributed key pair.
 *
 * @throws when `accountId` is not a safe integer — it is interpolated raw into
 * the JSON, so a float would produce a string neither end could reproduce.
 */
export function buildPrivateStoreAad({ accountId }: { accountId: number }): Uint8Array {
  if (!Number.isSafeInteger(accountId)) {
    throw new Error(`accountId must be a safe integer, got ${accountId}`);
  }
  return new TextEncoder().encode(
    `{"accountId":${accountId},"purpose":"private-store","v":${PRIVATE_STORE_AAD_VERSION}}`,
  );
}

/**
 * Wraps the CDK under one of the two slot KEKs.
 *
 * No AAD, matching the key-record wraps rather than the share wrap: a slot
 * lives inside the account's own blob beside the ciphertext it opens, so there
 * is no association table for anyone to splice it into. The CIPHERTEXT carries
 * the `accountId` binding, which is where the splice defence belongs.
 */
export async function wrapCdk({ cdk, kek }: { cdk: Uint8Array; kek: CryptoKey }): Promise<Uint8Array> {
  return wrapDek({ dek: cdk, kek });
}

/** Unwraps a CDK produced by {@link wrapCdk}. Throws (WebCrypto `OperationError`) when the KEK is wrong. */
export async function unwrapCdk({ wrappedCdk, kek }: { wrappedCdk: Uint8Array; kek: CryptoKey }): Promise<Uint8Array> {
  return unwrapDek({ wrappedDek: wrappedCdk, kek });
}

/** Encrypts the compartment's plaintext under the CDK, returning the packed `iv || ciphertext` blob. */
export async function sealPrivateStore({
  cdk,
  plaintext,
  accountId,
}: {
  cdk: Uint8Array;
  plaintext: Uint8Array;
  accountId: number;
}): Promise<Uint8Array> {
  const key = await importCdk(cdk);
  const { iv, ciphertext } = await aesGcmEncrypt({
    key,
    plaintext,
    additionalData: buildPrivateStoreAad({ accountId }),
  });
  return packIvAndCiphertext(iv, ciphertext);
}

/**
 * Decrypts a compartment sealed by {@link sealPrivateStore}.
 *
 * @throws when the CDK is wrong, when `accountId` differs from the one the
 * compartment was sealed for, or when the blob is malformed. All three arrive
 * as the same `OperationError` — a GCM tag check does not say WHY it failed,
 * and callers must not pretend to know.
 */
export async function openPrivateStore({
  cdk,
  ciphertext,
  accountId,
}: {
  cdk: Uint8Array;
  ciphertext: Uint8Array;
  accountId: number;
}): Promise<Uint8Array> {
  const key = await importCdk(cdk);
  const parts = splitIvAndCiphertext(ciphertext);
  return aesGcmDecrypt({
    key,
    iv: parts.iv,
    ciphertext: parts.ciphertext,
    additionalData: buildPrivateStoreAad({ accountId }),
  });
}

/**
 * The CDK travels as raw bytes (it is wrapped, stored and rewrapped as bytes),
 * so it is imported to a `CryptoKey` at each use rather than held as one. The
 * key is NON-EXTRACTABLE, so nothing downstream of this import can serialize
 * it back out — the raw bytes stay the single representation, in one place.
 */
async function importCdk(cdk: Uint8Array): Promise<CryptoKey> {
  if (cdk.byteLength !== CDK_BYTES) {
    throw new Error(`compartment data key must be exactly ${CDK_BYTES} bytes, got ${cdk.byteLength}`);
  }
  // `toBufferSource` for the reason its header gives: a view into a larger
  // buffer would silently import the WRONG BYTES as the key.
  return crypto.subtle.importKey('raw', toBufferSource(cdk), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * A compartment that has just been created, with its CDK still in the clear.
 *
 * The two wraps are base64 because that is how they ride inside the snapshot's
 * JSON; the CDK is bytes because it never leaves memory.
 */
export interface EstablishedPrivateStore {
  cdk: Uint8Array;
  cdkWrapPassphrase: string;
  cdkWrapRecovery: string;
}

/**
 * Creates a compartment: a fresh CDK wrapped under BOTH doors.
 *
 * Called only at the moments both are in hand at once — first-time setup, an
 * interrupted setup being finished, a reset that mints a new recovery code,
 * and a recovery-code regeneration. A compartment cannot be created from a
 * session alone, because a recovery code is shown once and never retained;
 * that is exactly why the DEK's setup and this one happen together.
 */
export async function establishPrivateStore({
  passphraseKek,
  recoveryKek,
}: {
  passphraseKek: CryptoKey;
  recoveryKek: CryptoKey;
}): Promise<EstablishedPrivateStore> {
  const cdk = generateCdk();
  const [wrappedUnderPassphrase, wrappedUnderRecovery] = await Promise.all([
    wrapCdk({ cdk, kek: passphraseKek }),
    wrapCdk({ cdk, kek: recoveryKek }),
  ]);
  return {
    cdk,
    cdkWrapPassphrase: bytesToBase64(wrappedUnderPassphrase),
    cdkWrapRecovery: bytesToBase64(wrappedUnderRecovery),
  };
}
