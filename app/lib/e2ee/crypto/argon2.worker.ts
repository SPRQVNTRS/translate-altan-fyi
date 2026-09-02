/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/engine/crypto/argon2.worker.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * Web Worker entry point for Argon2id (design spec D1 — REQUIRED, not
 * optional: running the memory-hard KDF on the main/UI thread visibly
 * freezes low-end phones for seconds). This file is the entire worker: it
 * receives one message (the derivation input), calls the pure
 * `deriveArgon2idHash` from `argon2.ts`, and posts back either the result or
 * an error string. No state, no queueing — the host app owns spawning a
 * fresh worker per derivation (setup, unlock) and terminating it after.
 *
 * SERVICE-WORKER PRECACHE (D1): `public/sw.js` must precache this compiled
 * worker script so the very first sync setup still works offline / on a
 * flaky connection — the KDF has to run before any network call. (`hash-wasm`
 * 4.x embeds its WASM as inline base64, so there is no separate `.wasm` asset
 * to list.) Wiring that precache entry belongs with the code that actually
 * spawns this worker (M128 spec 04) — noted here so it isn't missed.
 *
 * Uses a minimal LOCAL ambient type for the worker global scope instead of
 * TypeScript's `WebWorker` lib, which conflicts with the `DOM` lib the rest
 * of the app needs — see `tsconfig.json`.
 */
import { deriveArgon2idHash, type Argon2idParams } from './argon2';

declare const self: {
  /**
   * A DedicatedWorkerGlobalScope's second argument is a TRANSFER LIST, not a
   * target origin (that overload belongs to `Window.postMessage`). Nothing
   * here is transferred — the response is small and the worker is terminated
   * by its host immediately after — so callers pass an empty list.
   */
  postMessage: (message: Argon2idWorkerResponse, transfer: Transferable[]) => void;
  addEventListener: (type: 'message', listener: (event: { data: Argon2idWorkerRequest }) => void) => void;
};

export interface Argon2idWorkerRequest {
  passphrase: string;
  /** Transferred as a plain array (structured clone handles `Uint8Array` fine too, but this keeps the wire shape explicit). */
  salt: Uint8Array;
  params: Argon2idParams;
}

export type Argon2idWorkerResponse = { ok: true; hash: Uint8Array } | { ok: false; error: string };

async function runDerivation(request: Argon2idWorkerRequest): Promise<void> {
  const { passphrase, salt, params } = request;
  try {
    const hash = await deriveArgon2idHash({ passphrase, salt, params });
    self.postMessage({ ok: true, hash }, []);
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }, []);
  }
}

self.addEventListener('message', (event) => {
  void runDerivation(event.data);
});
