/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/engine/client/argon2-worker.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * Spawns `crypto/argon2.worker.ts` and adapts it to the `Argon2idDeriver`
 * shape every passphrase path here takes (`setup-keys.ts`,
 * `derive-credentials.ts`). This is the wiring D1 required and spec 01
 * deliberately left to this spec.
 *
 * WHY A WORKER AT ALL: Argon2id at 64 MiB / 3 iterations takes roughly a
 * second on a desktop and several on a cheap phone, and on the main thread
 * that is a frozen UI — no spinner animates, no tap registers. Users read that
 * as a crash, not as work. The KDF is also unavoidably slow BY DESIGN (that
 * slowness is the security property), so it cannot be optimised away; it can
 * only be moved off the thread that paints.
 *
 * ONE WORKER PER DERIVATION, terminated in a `finally`. Argon2id runs at most
 * a handful of times in a session (setup, unlock, passphrase change) and each
 * run allocates 64 MiB inside the worker — keeping a warm worker around would
 * hold that memory for the whole session to save a spawn that costs
 * milliseconds against a job that costs seconds.
 *
 * THE FALLBACK IS NOT A CONVENIENCE. `Worker` is absent during SSR and in the
 * `node:test` suites, and a missing `Worker` there must not turn into a
 * crash — so the main-thread `deriveArgon2idHash` is used instead. It is
 * never chosen in a real browser: every browser that can run this app has
 * module workers.
 */
import { z } from 'zod';

import { deriveArgon2idHash, type Argon2idParams } from '#app/lib/e2ee/crypto/argon2';
import type { Argon2idWorkerRequest, Argon2idWorkerResponse } from '#app/lib/e2ee/crypto/argon2.worker';
import type { Argon2idDeriver } from './setup-keys';

/**
 * A worker message is an I/O boundary like any other, so the response is
 * DECODED rather than assumed: `MessageEvent<T>` is a compile-time promise
 * about a value that crossed a structured-clone boundary at runtime. The
 * `satisfies` keeps this decoder and the worker's own response type from
 * drifting apart silently.
 */
const argon2idWorkerResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), hash: z.instanceof(Uint8Array) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]) satisfies z.ZodType<Argon2idWorkerResponse>;

function canUseWorker(): boolean {
  return globalThis.Worker !== undefined;
}

/**
 * Runs one Argon2id derivation inside a freshly spawned module Worker.
 *
 * Rejects (never resolves with a sentinel) when the worker reports an error or
 * fails to load — a KDF that silently produced the wrong bytes would surface
 * as "your passphrase is wrong" for a passphrase that is right.
 */
function deriveInWorker(input: { passphrase: string; salt: Uint8Array; params: Argon2idParams }): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    // `new URL(..., import.meta.url)` is the form Vite statically analyses to
    // emit the worker as its own chunk. A computed specifier here would build
    // fine and 404 at runtime in production only.
    const worker = new Worker(new URL('../crypto/argon2.worker.ts', import.meta.url), { type: 'module' });

    const settle = (finish: () => void): void => {
      worker.terminate();
      finish();
    };

    worker.addEventListener('message', (event: MessageEvent) => {
      const parsed = argon2idWorkerResponseSchema.safeParse(event.data);
      if (!parsed.success) {
        settle(() => reject(new Error('Argon2id worker returned a response this build could not read.')));
        return;
      }
      const response = parsed.data;
      if (response.ok) {
        settle(() => resolve(new Uint8Array(response.hash)));
        return;
      }
      settle(() => reject(new Error(`Argon2id worker failed: ${response.error}`)));
    });
    worker.addEventListener('error', (event: ErrorEvent) => {
      settle(() => reject(new Error(`Argon2id worker failed to run: ${event.message}`)));
    });

    const request: Argon2idWorkerRequest = { passphrase: input.passphrase, salt: input.salt, params: input.params };
    // The second argument is a transfer list, not a target origin: `salt` is
    // the caller's buffer and must be COPIED, never transferred out from under
    // it, so nothing is transferred here.
    worker.postMessage(request, []);
  });
}

/**
 * The deriver every browser-side passphrase path should use.
 *
 * A function rather than a constant so the `Worker` availability check happens
 * per call: this module is imported during SSR (a route component's module
 * graph), where `Worker` is undefined at import time and defined by the time
 * anything actually derives.
 */
export const workerArgon2idDeriver: Argon2idDeriver = async (input) => {
  if (!canUseWorker()) return deriveArgon2idHash(input);
  return deriveInWorker(input);
};
