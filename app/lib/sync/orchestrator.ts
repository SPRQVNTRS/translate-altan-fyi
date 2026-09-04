/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/orchestrator.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * The sync cycle: snapshot, wire meta, pull, merge, push, with the mandatory
 * compare-and-swap retry loop around it.
 *
 * THE DECRYPT AND ENCRYPT STEPS ARE GONE (M191). Upstream the cycle reads
 * "snapshot, pull, decrypt, merge, encrypt, push"; this deployment stores the
 * document as plain JSON, so the two crypto steps are ordinary framing
 * (`engine/envelope/build-envelope.ts`) and the schema-probe loop that walked
 * `payloadSchemaVersion` down until a GCM tag verified went with them: the
 * version is a field on the envelope now and is read rather than guessed.
 *
 * This is the imperative shell (`functional-core`). Every decision it makes,
 * who wins a conflict and whether a push is even needed, is a call into the
 * pure `snapshot-sync.ts`; what lives here is ordering, I/O and the retry
 * policy. Both halves are injected (`SyncCycleDeps`), so a test drives the real
 * algorithm against a fake service without a browser or a database.
 *
 * ── The 409 loop is mandatory, not an optimization ─────────────────────────
 *
 * A client that treats `409` as fatal strands the device permanently out of
 * sync. Losing the CAS means another device wrote first, which is a NORMAL
 * outcome: pull it, merge it, push again. Bounded by `maxAttempts` so a
 * pathologically busy account fails loudly instead of spinning.
 *
 * ── Offline is a no-op, deliberately ──────────────────────────────────────
 *
 * The local store IS the source of truth, so an offline edit is already durable
 * and the next successful cycle carries it up whole. The outbox
 * (`app/lib/local-store/outbox.ts`) queues the INTENT to run a cycle, never the
 * data: a second representation of the same pending work is a second thing that
 * can disagree with the store.
 *
 * ── ONE DEPENDENCY THE SOURCE HAS AND THIS DOES NOT ───────────────────────
 *
 * `assertPulledSnapshot` is gone. It was the veto that refused a pulled
 * owner-private compartment before the cycle wrote anything, and this product
 * has no counterpart for it: there is no sharing and no research enrolment
 * here. `deviceId` is gone too, because here the stamp is applied at the write
 * by `primary-store.ts` and nothing in a cycle mints one.
 */
import { buildEnvelope, parseEnvelope } from '#app/lib/sync/engine/envelope/build-envelope';
import type { DataEnvelope, SyncPayload } from '#app/lib/sync/engine/envelope/types';
import { jsonValueSchema, type JsonValue } from '#app/lib/json';
import { SyncRequestError } from '#app/lib/sync/sync-error';
import { SCHEMA_VERSION, type SyncedSnapshot } from '#app/lib/local-store';
import { mergeSnapshots, payloadsEqual, toWireMeta, type StampedSnapshot } from './snapshot-sync';
import { applyMergedSnapshot, parseRemoteSnapshot, readLocalSnapshot } from './local-store-bridge';
import { createBrowserSyncHttpClient, type SyncHttpClient } from './http-client';
import { createSyncStateStore, deviceStorage, type PersistedSyncState, type SyncStateStore } from './sync-state';
import { getSyncSession } from './sync-session';
import { withSyncOrchestratorLock } from './sync-lock';

/** How many CAS rounds a single cycle will fight for before giving up. */
export const DEFAULT_MAX_PUSH_ATTEMPTS = 5;

/**
 * The largest document this client will try to push, in bytes of its JSON
 * encoding. It mirrors the server's own cap so the failure names the real
 * problem instead of arriving as an opaque 413.
 */
export const MAX_BLOB_BYTES = 2 * 1024 * 1024;

export interface SyncCycleDeps {
  /** Whose document this is. It keys the device's own sync state, nothing more. */
  userId: number;
  http: SyncHttpClient;
  state: SyncStateStore;
  /** The device's synced rows, tombstones included. */
  readSnapshot: () => Promise<SyncedSnapshot>;
  applySnapshot: (input: { merged: SyncedSnapshot }) => Promise<void>;
  parseRemoteSnapshot: (input: { snapshot: JsonValue; schemaVersion: number }) => SyncedSnapshot;
  now?: () => number;
  maxAttempts?: number;
}

export interface SyncCycleResult {
  /** The blob version this device now agrees with. */
  blobVersion: number;
  /** Whether this cycle actually wrote a new document (false when the merge contributed nothing). */
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
 * the CAS on the server only protects the document, not this device's state.
 */
export async function runSyncCycle(deps: SyncCycleDeps): Promise<SyncCycleResult> {
  return withSyncOrchestratorLock(() => runSyncCycleUnlocked(deps));
}

/** The cycle itself, lock-free, exported for tests that supply their own serialization. */
export async function runSyncCycleUnlocked(deps: SyncCycleDeps): Promise<SyncCycleResult> {
  const now = deps.now ?? Date.now;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_PUSH_ATTEMPTS;

  const local = await deps.readSnapshot();
  const localPayload: StampedSnapshot = { snapshot: local, meta: toWireMeta(local) };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remote = await pullRemotePayload(deps);
    const baseVersion = remote?.blobVersion ?? 0;
    const merged = remote === null ? localPayload : mergeSnapshots({ local: localPayload, remote: remote.payload });

    // Nothing local to contribute: adopt the remote document as-is and stop.
    // This is the common case on every boot, and skipping the push is what
    // keeps "open the app" from consuming a version.
    if (remote !== null && payloadsEqual(merged, remote.payload)) {
      await deps.applySnapshot({ merged: merged.snapshot });
      const at = now();
      commitState({ deps, blobVersion: baseVersion, at });
      return { blobVersion: baseVersion, pushed: false, attempts: attempt, lastSyncedAt: at };
    }

    const targetVersion = baseVersion + 1;
    const envelope = buildEnvelope({
      payload: toWirePayload(merged),
      blobVersion: targetVersion,
      payloadSchemaVersion: SCHEMA_VERSION,
    });

    const sizeBytes = new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
    if (sizeBytes > MAX_BLOB_BYTES) {
      throw new SyncRequestError({
        kind: 'too-large',
        message: `This device's lists are ${sizeBytes} bytes, over the ${MAX_BLOB_BYTES}-byte sync limit.`,
      });
    }

    const result = await deps.http.pushBlob({ baseVersion, payload: toStoredPayload(envelope) });
    if (result.status === 'conflict') continue;

    await deps.applySnapshot({ merged: merged.snapshot });
    const at = now();
    commitState({ deps, blobVersion: result.newVersion, at });
    return { blobVersion: result.newVersion, pushed: true, attempts: attempt, lastSyncedAt: at };
  }

  throw new SyncRequestError({
    kind: 'conflict',
    message: `Sync could not settle after ${maxAttempts} attempts: another device is writing continuously.`,
  });
}

/** One cycle against the live browser transport and the current session. Returns null when there is no session to sync. */
export async function runSyncCycleForCurrentSession(
  options: { now?: () => number } = {},
): Promise<SyncCycleResult | null> {
  const session = getSyncSession();
  if (session === null) return null;
  return runSyncCycle({
    userId: session.userId,
    http: createBrowserSyncHttpClient(),
    state: createSyncStateStore({ storage: deviceStorage(), userId: session.userId }),
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
  // A 404 is how a fresh account looks, not an error.
  if (pulled === null) return null;

  const envelope = parseEnvelope(pulled.payload);
  return {
    blobVersion: pulled.blobVersion,
    payload: {
      snapshot: deps.parseRemoteSnapshot({
        snapshot: envelope.payload.snapshot,
        schemaVersion: envelope.payloadSchemaVersion,
      }),
      meta: envelope.payload.syncMeta,
    },
  };
}

/**
 * The payload as the envelope carries it.
 *
 * THE PARSE IS THE WIDENING, and it is deliberate rather than a cast. The
 * envelope does not know the snapshot's real shape, which is what lets the
 * local-store schema evolve without touching this module; proving the snapshot
 * IS JSON at that boundary is cheaper to read than an assertion chain, and it
 * catches the one thing a cast would hide: a store row that quietly grew a
 * value JSON cannot carry.
 */
function toWirePayload(payload: StampedSnapshot): SyncPayload {
  return { snapshot: jsonValueSchema.parse(payload.snapshot), syncMeta: payload.meta };
}

/** The envelope as the wire carries it: an ordinary JSON value the server stores whole. */
function toStoredPayload(envelope: DataEnvelope): JsonValue {
  return jsonValueSchema.parse(envelope);
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
