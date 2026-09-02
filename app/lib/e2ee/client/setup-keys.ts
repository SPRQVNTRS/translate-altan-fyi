/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/engine/client/setup-keys.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * First-time sync key setup — the one composite the UI needs, built from the
 * primitives in `../crypto` and this directory.
 *
 * The key hierarchy it produces (M117 design spec D1/D2/D5):
 *
 *   passphrase --Argon2id--> hash --HKDF(PASSPHRASE_KEK)--> KEK_p --wraps--> DEK
 *   recovery code           ----------HKDF(RECOVERY_KEK)--> KEK_r --wraps--> DEK
 *
 * and, nested one level down (ADR-0002's partition amendment), the same shape
 * again for the owner-private compartment — one CDK, wrapped twice:
 *
 *   hash --HKDF(PRIVATE_STORE_KEK)----------> K_pp --wraps--> CDK
 *   recovery code --HKDF(PRIVATE_STORE_RECOVERY_KEK)-> K_pr --wraps--> CDK
 *
 * One DEK, wrapped twice. That indirection is what makes a passphrase change
 * (or the recovery path) re-wrap 32 bytes instead of re-encrypting the user's
 * entire history — and it is why losing BOTH the passphrase and the recovery
 * code is unrecoverable by anyone, including us.
 *
 * Neither the DEK nor either KEK is returned. The caller gets only the two
 * wrapped-DEK records, which are exactly what goes on the wire
 * (`protocol.ts`'s `KeyRecordWire`) — there is no code path here through
 * which key material could accidentally reach the network or storage layer.
 *
 * WHY `deriveHash` IS INJECTED: Argon2id at production parameters (64 MiB,
 * 3 iterations) takes roughly a second and MUST run off the main thread —
 * `../crypto/argon2.worker.ts` is that wrapper, and wiring it is the sync
 * UI's job (M128 spec 04), not this module's. Injecting the derivation keeps
 * this composition worker-agnostic, keeps its unit tests fast (they inject
 * tiny parameters), and keeps the "where does Argon2id run" decision in one
 * place instead of hidden inside a helper.
 */
import {
  ARGON2ID_DEFAULT_PARAMS,
  deriveArgon2idHash,
  generateArgon2idSalt,
  type Argon2idParams,
} from '#app/lib/e2ee/crypto/argon2';
import { generateDek, wrapDek } from '#app/lib/e2ee/crypto/dek-wrap';
import { establishPrivateStore, type EstablishedPrivateStore } from '#app/lib/e2ee/crypto/private-store';
import type { KdfDescriptor } from '#app/lib/e2ee/kdf-descriptor';
import { createPassphraseKdfDescriptor, type PassphraseKdfDescriptor } from './passphrase-kek';
import { deriveCredentialsFromPassphrase } from './derive-credentials';
import { derivePrivateStoreRecoveryKek, deriveRecoveryKek } from './recovery-kek';

/** One wrapped-DEK record, ready to be base64-encoded onto the wire by the caller. */
export interface SyncKeySetupRecord {
  /** The Argon2id salt + parameters for the `passphrase` kind; `null` for `recovery` (HKDF-only). */
  kdfDescriptor: KdfDescriptor | null;
  /** A SINGLE packed blob: the 12-byte AES-GCM IV followed by ciphertext+tag (`crypto/aes-gcm.ts`'s `packIvAndCiphertext`). */
  wrappedDek: Uint8Array;
}

/** Both key records produced by a completed first-time setup, plus what the account endpoints need. */
export interface SyncKeySetupResult {
  passphraseKeyRecord: SyncKeySetupRecord;
  recoveryKeyRecord: SyncKeySetupRecord;
  /**
   * The `AUTH` HKDF branch (base64) from the SAME Argon2id run that produced
   * `KEK_p` — this is what `POST /v1/auth/signup` takes as the credential.
   *
   * Returned here rather than derived separately by the caller because
   * Argon2id at 64 MiB is the expensive step and there is no reason to pay it
   * twice; and because a caller deriving it independently could accidentally
   * use a different salt, producing an account whose stored KDF descriptor no
   * longer matches its own key record. That failure is silent until a SECOND
   * device tries to unlock.
   */
  authHash: string;
  /** The descriptor recorded on both the account and the passphrase key record — the same salt/params for both, always. */
  kdfDescriptor: PassphraseKdfDescriptor;
  /**
   * The unwrapped DEK, so a caller that has just completed setup can start
   * syncing without a second Argon2id run to reopen what it just created.
   * Memory only — persisting this anywhere defeats the entire design.
   */
  dek: Uint8Array;
  /**
   * The OWNER-PRIVATE COMPARTMENT, established here (ADR-0002's partition
   * amendment) because setup is the one moment BOTH its doors exist at once:
   * the passphrase is in this call frame and the recovery code has not yet
   * been shown-and-forgotten. Creating it later is impossible without one of
   * them, and an account with no compartment cannot sync a share key at all.
   */
  privateStore: EstablishedPrivateStore;
  /**
   * `K_pp`, the compartment's passphrase door — THE ONE KEK THIS MODULE
   * RETURNS, and the exception needs its reason stated.
   *
   * Neither the DEK's KEK nor the recovery KEK is returned, because nothing
   * after setup needs them: the DEK itself is handed back instead. This one is
   * different. A session must be able to open a compartment ANOTHER device
   * wrote — a second device, or the same device after a passphrase change that
   * landed elsewhere — and the only way to do that is slot 1 under `K_pp`.
   * Re-deriving it would cost a second Argon2id run at 64 MiB, which the user
   * feels as a frozen screen.
   */
  privateStoreKek: CryptoKey;
}

/** The Argon2id step, injected so the caller decides where it runs (main thread, Worker, or a fast test stub). */
export type Argon2idDeriver = (input: {
  passphrase: string;
  salt: Uint8Array;
  params: Argon2idParams;
}) => Promise<Uint8Array>;

/**
 * Runs a complete first-time key setup and returns both wrapped-DEK records.
 *
 * @param passphrase - the user's master passphrase. Never persisted anywhere by this module.
 * @param recoveryCodeRaw - raw bytes from `generateRecoveryCode()`; the caller owns showing the formatted code to the user.
 * @param params - Argon2id cost parameters; recorded in the passphrase record's descriptor so any device can re-derive.
 * @param deriveHash - the Argon2id step (see this module's doc comment on why it is injectable).
 */
export async function setupSyncKeys({
  passphrase,
  recoveryCodeRaw,
  params = ARGON2ID_DEFAULT_PARAMS,
  deriveHash = deriveArgon2idHash,
}: {
  passphrase: string;
  recoveryCodeRaw: Uint8Array;
  params?: Argon2idParams;
  deriveHash?: Argon2idDeriver;
}): Promise<SyncKeySetupResult> {
  const descriptor = createPassphraseKdfDescriptor(generateArgon2idSalt(), params);

  // ONE Argon2id run, split into its two independent HKDF branches
  // (`derive-credentials.ts`). Deriving the auth branch separately would
  // double the most expensive step in the flow for no benefit.
  const { authHash, passphraseKek, privateStoreKek } = await deriveCredentialsFromPassphrase({
    passphrase,
    descriptor,
    deriveHash,
  });
  const recoveryKek = await deriveRecoveryKek(recoveryCodeRaw);
  const privateStoreRecoveryKek = await derivePrivateStoreRecoveryKek(recoveryCodeRaw);

  const dek = generateDek();

  return {
    passphraseKeyRecord: {
      kdfDescriptor: descriptor,
      wrappedDek: await wrapDek({ dek, kek: passphraseKek }),
    },
    recoveryKeyRecord: {
      // Always `null` for the recovery kind — the service rejects a recovery
      // record that carries one (D5: HKDF-only, so there are no parameters
      // to record).
      kdfDescriptor: null,
      wrappedDek: await wrapDek({ dek, kek: recoveryKek }),
    },
    authHash,
    kdfDescriptor: descriptor,
    dek,
    privateStore: await establishPrivateStore({
      passphraseKek: privateStoreKek,
      recoveryKek: privateStoreRecoveryKek,
    }),
    privateStoreKek,
  };
}
