/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/engine/crypto/argon2.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * Argon2id key stretching (M117 design spec D1) via `hash-wasm` — the ONE
 * security-critical WASM dependency the sync engine pulls in. It is
 * EXACT-PINNED in `package.json` (`"hash-wasm": "4.11.0"`, no `^`) so a
 * compromised patch release can never be pulled in silently; bump it
 * deliberately, and re-audit before launch per D1's standing caveat. No
 * native WebCrypto Argon2id primitive exists, so a WASM library is
 * unavoidable; `hash-wasm` was chosen over `argon2-browser` for
 * maintenance/audit-surface/bundle reasons (see D1's rationale).
 *
 * VITE DEP-OPTIMIZER NOTE for whoever wires this into the UI (M128 spec 04):
 * nothing in the routed module graph imports this file yet, so `hash-wasm`
 * is intentionally absent from `vite.config.ts`'s `optimizeDeps.include`
 * list. The moment a route (or a Worker entry) reaches it, it becomes a
 * lazily-discovered dependency — exactly the mid-session re-bundle-and-reload
 * race that list exists to prevent — and it must be added there.
 *
 * This module is a PURE function around `hash-wasm`'s API — it does not
 * decide whether it runs on the main thread or inside a Web Worker. D1
 * REQUIRES the Worker (a memory-hard KDF on the UI thread visibly freezes
 * low-end phones); `argon2.worker.ts` is the thin Worker wrapper that calls
 * this function and posts the result back. Keeping the derivation itself
 * worker-agnostic makes it directly unit-testable with `node:test` (no DOM,
 * no Worker runtime needed).
 */
import { argon2id } from 'hash-wasm';

/**
 * Parameter starting point (D1, order-of-magnitude — re-tune before launch,
 * re-benchmark on a low-end target device for ~0.5–1s on-device).
 */
export const ARGON2ID_DEFAULT_PARAMS = {
  memorySizeKib: 64 * 1024, // 64 MiB
  iterations: 3,
  parallelism: 1,
} as const;

/** 128-bit random salt length (D1) — a salt is not a secret; stored alongside the KDF descriptor in the passphrase key record. */
export const ARGON2ID_SALT_BYTES = 16;

export function generateArgon2idSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(ARGON2ID_SALT_BYTES));
}

/** The 32-byte Argon2id output length — long enough to feed directly into HKDF as input key material. */
const ARGON2ID_HASH_LENGTH_BYTES = 32;

export interface Argon2idParams {
  memorySizeKib: number;
  iterations: number;
  parallelism: number;
}

/**
 * Stretches `passphrase` with Argon2id. Deterministic for a given
 * `(passphrase, salt, params)` triple — re-deriving the SAME KEK on a new
 * device (D2's bootstrap flow) calls this again with the salt/params read
 * back from the passphrase key record's KDF descriptor.
 */
export async function deriveArgon2idHash({
  passphrase,
  salt,
  params = ARGON2ID_DEFAULT_PARAMS,
}: {
  passphrase: string;
  salt: Uint8Array;
  params?: Argon2idParams;
}): Promise<Uint8Array> {
  const hash = await argon2id({
    password: passphrase,
    salt,
    memorySize: params.memorySizeKib,
    iterations: params.iterations,
    parallelism: params.parallelism,
    hashLength: ARGON2ID_HASH_LENGTH_BYTES,
    outputType: 'binary',
  });
  return hash;
}
