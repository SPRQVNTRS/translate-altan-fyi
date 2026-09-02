/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/orchestrator.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * The sync cycle: snapshot → wire meta → pull → decrypt → merge → encrypt →
 * push, with the mandatory compare-and-swap retry loop around it.
 *
 * This is the imperative shell (`functional-core`). Every decision it makes —
 * who wins a conflict, whether a push is even needed — is a call into the pure
 * `snapshot-sync.ts`; what lives here is ordering, I/O and the retry policy.
 * Both halves are injected (`SyncCycleDeps`), so a test drives the real
 * algorithm against a protocol-faithful fake service without a browser or a
 * database.
 *
 * ── The 409 loop is mandatory, not an optimization ─────────────────────────
 *
 * `PROTOCOL.md` section 5.1 is explicit: a client that treats `409` as fatal
 * strands the device permanently out of sync. Losing the CAS means another
 * device wrote first, which is a NORMAL outcome — pull it, merge it,
 * re-encrypt with the AAD bound to the NEW blob version, push again. Bounded
 * by `maxAttempts` so a pathologically busy account fails loudly instead of
 * spinning.
 *
 * ── Offline is a no-op, deliberately ──────────────────────────────────────
 *
 * The local store IS the source of truth, so an offline edit is already
 * durable and the next successful cycle carries it up whole. The outbox
 * (`app/lib/local-store/outbox.ts`) queues the INTENT to run a cycle, never
 * the data: a second representation of the same pending work is a second thing
 * that can disagree with the store.
 *
 * ── The AAD, and why schema versions are probed ───────────────────────────
 *
 * Decryption binds `{accountId, blobVersion, payloadSchemaVersion}`. The first
 * two travel on the wire; the third does not — so a device pulling a blob
 * written by a peer on an OLDER `SCHEMA_VERSION` has to know which value to
 * present before it can decrypt. It cannot, so it tries the current version
 * and then walks down. With `SCHEMA_VERSION` at 1 that loop runs exactly once,
 * and the code stays because the loop is what makes the NEXT bump
 * forward-compatible rather than a flag day. A blob from a NEWER schema fails
 * every attempt, which is the correct refusal — this build genuinely cannot
 * read it, and guessing would corrupt it.
 *
 * ── TWO DEPENDENCIES THE SOURCE HAS AND THIS DOES NOT ─────────────────────
 *
 * `assertPulledSnapshot` is gone. It was the veto that refused a pulled
 * owner-private compartment before the cycle wrote anything, and this product
 * has no counterpart for it: there is no sharing and no research enrolment
 * here, so there is no third party whose account a device could push a whole
 * store into by mistake. Removed on purpose, not forgotten.
 *
 * `deviceId` is gone too. Upstream the cycle STAMPED entities as it went, so
 * it needed this device's identity; here the stamp is applied at the write by
 * `primary-store.ts`, and nothing in a cycle mints one.
 */
import { buildEnvelope, parseEnvelope } from '#app/lib/sync/engine/envelope/build-envelope';
import type { SyncPayload } from '#app/lib/sync/engine/envelope/types';
import { ENVELOPE_VERSION, MAX_BLOB_BYTES } from '#app/lib/e2ee/protocol';
import { SyncRequestError } from '#app/lib/e2ee/client/sync-error';
import { SCHEMA_VERSION, type SyncedSnapshot } from '#app/lib/local-store';
import { mergeSnapshots, payloadsEqual, toWireMeta, type StampedSnapshot } from './snapshot-sync';
import { applyMergedSnapshot, parseRemoteSnapshot, readLocalSnapshot } from './local-store-bridge';
import { createBrowserSyncHttpClient, type SyncHttpClient } from './http-client';
import { createSyncStateStore, deviceStorage, type PersistedSyncState, type SyncStateStore } from './sync-state';
import { getSyncSession } from './sync-session';
import { withSyncOrchestratorLock } from './sync-lock';

/** How many CAS rounds a single cycle will fight for before giving up. */
export const DEFAULT_MAX_PUSH_ATTEMPTS = 5;

export interface SyncCycleDeps {
  /** Binds the envelope's AAD — a blob cannot be replayed into another account. */
  accountId: number;
  /** The unwrapped data-encryption key. Held in memory for the session only, never persisted anywhere. */
  dek: Uint8Array;
  http: SyncHttpClient;
  state: SyncStateStore;
  /** The device's synced rows, tombstones included. */
  readSnapshot: () => Promise<SyncedSnapshot>;
  applySnapshot: (input: { merged: SyncedSnapshot }) => Promise<void>;
  parseRemoteSnapshot: (input: { snapshot: unknown; schemaVersion: number }) => SyncedSnapshot;
  now?: () => number;
  maxAttempts?: number;
}

export interface SyncCycleResult {
  /** The blob version this device now agrees with. */
  blobVersion: number;
  /** Whether this cycle actually wrote a new blob (false when the merge contributed nothing). */
  pushed: boolean;
  /** How many CAS rounds it took. `1` is the uncontended case. */
  attempts: number;
  lastSyncedAt: number;
}

/**
 * Runs one full sync cycle under the device's single-writer lock.
 *
 * The lock wraps the WHOLE cycle rather than just the push: read-then-write
 * across two tabs is exactly the interleaving that produces a lost update, and
 * the CAS on the server only protects the blob, not this device's state.
 */
export async function runSyncCycle(deps: SyncCycleDeps): Promise<SyncCycleResult> {
  return withSyncOrchestratorLock(() => runSyncCycleUnlocked(deps));
}

/** The cycle itself, lock-free — exported for tests that supply their own serialization. */
export async function runSyncCycleUnlocked(deps: SyncCycleDeps): Promise<SyncCycleResult> {
  const now = deps.now ?? Date.now;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_PUSH_ATTEMPTS;

  const local = await deps.readSnapshot();
  const localPayload: StampedSnapshot = { snapshot: local, meta: toWireMeta(local) };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remote = await pullRemotePayload(deps);
    const baseVersion = remote?.blobVersion ?? 0;
    const merged = remote === null ? localPayload : mergeSnapshots({ local: localPayload, remote: remote.payload });

    // Nothing local to contribute: adopt the remote blob as-is and stop. This
    // is the common case on every boot, and skipping the push is what keeps
    // "open the app" from consuming a blob version.
    if (remote !== null && payloadsEqual(merged, remote.payload)) {
      await deps.applySnapshot({ merged: merged.snapshot });
      const at = now();
      commitState({ deps, blobVersion: baseVersion, at });
      return { blobVersion: baseVersion, pushed: false, attempts: attempt, lastSyncedAt: at };
    }

    const targetVersion = baseVersion + 1;
    const envelope = await buildEnvelope({
      payload: toWirePayload(merged),
      dek: deps.dek,
      aadFields: { accountId: deps.accountId, blobVersion: targetVersion, payloadSchemaVersion: SCHEMA_VERSION },
    });

    // Mirror the service's cap client-side (`PROTOCOL.md` section 8) so the
    // failure names the real problem instead of arriving as an opaque 413.
    if (envelope.ciphertext.byteLength > MAX_BLOB_BYTES) {
      throw new SyncRequestError({
        kind: 'too-large',
        message: `This device's encrypted lists are ${envelope.ciphertext.byteLength} bytes, over the ${MAX_BLOB_BYTES}-byte sync limit.`,
      });
    }

    const result = await deps.http.pushBlob({
      baseVersion,
      envelopeVersion: ENVELOPE_VERSION,
      ciphertext: envelope.ciphertext,
    });
    if (result.status === 'conflict') continue;

    await deps.applySnapshot({ merged: merged.snapshot });
    const at = now();
    commitState({ deps, blobVersion: result.newVersion, at });
    return { blobVersion: result.newVersion, pushed: true, attempts: attempt, lastSyncedAt: at };
  }

  throw new SyncRequestError({
    kind: 'conflict',
    message: `Sync could not settle after ${maxAttempts} attempts — another device is writing continuously.`,
  });
}

/** One cycle against the live browser transport and the current session. Returns null when there is no session to sync. */
export async function runSyncCycleForCurrentSession(
  options: { now?: () => number } = {},
): Promise<SyncCycleResult | null> {
  const session = getSyncSession();
  if (session === null) return null;
  return runSyncCycle({
    accountId: session.accountId,
    dek: session.dek,
    http: createBrowserSyncHttpClient(),
    state: createSyncStateStore({ storage: deviceStorage(), accountId: session.accountId }),
    readSnapshot: readLocalSnapshot,
    applySnapshot: applyMergedSnapshot,
    parseRemoteSnapshot,
    now: options.now,
  });
}

interface RemotePayload {
  blobVersion: number;
  payload: StampedSnapshot;
}

async function pullRemotePayload(deps: SyncCycleDeps): Promise<RemotePayload | null> {
  const pulled = await deps.http.pullBlob();
  // A 404 is how a fresh account looks, not an error (`PROTOCOL.md` section 5.2).
  if (pulled === null) return null;

  const decrypted = await decryptWithSchemaProbe({
    ciphertext: pulled.ciphertext,
    envelopeVersion: pulled.envelopeVersion,
    blobVersion: pulled.blobVersion,
    accountId: deps.accountId,
    dek: deps.dek,
  });

  return {
    blobVersion: pulled.blobVersion,
    payload: {
      snapshot: deps.parseRemoteSnapshot({
        snapshot: decrypted.payload.snapshot,
        schemaVersion: decrypted.schemaVersion,
      }),
      meta: decrypted.payload.syncMeta,
    },
  };
}

/**
 * Decrypts a pulled blob, walking `payloadSchemaVersion` down from this
 * build's current value until the GCM tag verifies (see the module header for
 * why the value cannot simply be read off the wire).
 *
 * Every attempt failing is reported as ONE clear error rather than the last
 * cipher exception: "wrong key or a newer app wrote this" is actionable;
 * "OperationError" is not.
 */
export async function decryptWithSchemaProbe({
  ciphertext,
  envelopeVersion,
  blobVersion,
  accountId,
  dek,
}: {
  ciphertext: Uint8Array;
  envelopeVersion: number;
  blobVersion: number;
  accountId: number;
  dek: Uint8Array;
}): Promise<{ payload: SyncPayload; schemaVersion: number }> {
  for (let schemaVersion = SCHEMA_VERSION; schemaVersion >= 1; schemaVersion -= 1) {
    try {
      const payload = await parseEnvelope({
        envelope: { envelopeVersion, ciphertext },
        dek,
        aadFields: { accountId, blobVersion, payloadSchemaVersion: schemaVersion },
      });
      return { payload, schemaVersion };
    } catch {
      // Wrong AAD guess, or genuinely undecryptable. Keep walking down; the
      // loop's exhaustion below is the only place this becomes an error.
    }
  }
  throw new SyncRequestError({
    kind: 'invalid',
    message:
      'This account’s synced data could not be decrypted on this device. Either the passphrase is wrong, or it was written by a newer version of the app.',
  });
}

function toWirePayload(payload: StampedSnapshot): SyncPayload {
  return { snapshot: payload.snapshot, syncMeta: payload.meta };
}

/** Persists the version this device now agrees with, and when it agreed. */
function commitState({
  deps,
  blobVersion,
  at,
}: {
  deps: SyncCycleDeps;
  blobVersion: number;
  at: number;
}): PersistedSyncState {
  const next: PersistedSyncState = {
    formatVersion: deps.state.load().formatVersion,
    lastBlobVersion: blobVersion,
    lastSyncedAt: at,
  };
  deps.state.save(next);
  return next;
}
