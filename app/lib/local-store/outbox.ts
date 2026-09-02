/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/local-store/outbox.ts @ 68e893a.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 *
 * The write outbox: enqueue sync intents and flush them in order on reconnect.
 * Each record carries a client-generated `clientId` (the store rowId and the
 * idempotency key), so a replay is exactly-once. The flush is the imperative
 * shell around the pure `outbox-machine`: this module owns the store I/O and
 * the network call, the machine owns every decision.
 *
 * Records are stored as a single JSON cell per row, so a record is read/written
 * whole — no per-field cell juggling. The low-level `readOutboxRecords` /
 * `writeOutboxRecord` are exported for tests that drive `flushOutbox` against a
 * real in-memory store.
 *
 * WHAT A RECORD MEANS DIVERGES FROM THE SOURCE — see `types.ts`. Upstream a
 * record was a queued form POST, and the module owned the `fetch` that replayed
 * it. Here the carrier is the sync orchestrator, which is not part of this
 * layer, so the impure boundary is a `run` function: injected per call, or
 * installed once via {@link setOutboxRunner}.
 */
import type { Store } from 'tinybase';
import { z } from 'zod';
import { getOutboxStore } from './persist';
import { OUTBOX_RECORD_CELL, OUTBOX_TABLE } from './store';
import {
  applyFlushOutcome,
  classifyFlushFailure,
  classifyFlushOutcome,
  selectFlushableRecords,
} from './outbox-machine';
import type {
  EnqueueSyncInput,
  FlushOutcome,
  FlushResult,
  FlushSurface,
  OutboxRecord,
  SyncAttemptResult,
} from './types';

/** The queued-record cell as it comes back off the store — a TinyBase cell, not yet JSON text. */
const recordCellSchema = z.string();

/** Carries one record up. The impure boundary the flush loop wraps. */
export type OutboxRunner = (record: OutboxRecord) => Promise<SyncAttemptResult>;

/**
 * The installed carrier, or null when nothing has installed one yet.
 *
 * The sync orchestrator installs itself here, the same way `report-error.ts`
 * lets the server install its log sink: this layer must not import the
 * orchestrator, because every screen imports this layer and the orchestrator
 * reaches the network.
 */
let installedRunner: OutboxRunner | null = null;

/** Installs (or with `null`, removes) the carrier `flushOutbox` uses when no `run` is passed. */
export function setOutboxRunner(run: OutboxRunner | null): void {
  installedRunner = run;
}

/**
 * The stand-in used when no carrier is installed. It reports a transient
 * failure rather than a success: a record must never be removed from the queue
 * on the strength of nobody having tried to send it. The backoff then parks it
 * until a carrier exists.
 */
async function noRunnerInstalled(): Promise<SyncAttemptResult> {
  return { ok: false, status: null };
}

// ---------------------------------------------------------------------------
// Record <-> row (de)serialization
// ---------------------------------------------------------------------------

export function writeOutboxRecord(store: Store, record: OutboxRecord): void {
  store.setRow(OUTBOX_TABLE, record.clientId, { [OUTBOX_RECORD_CELL]: JSON.stringify(record) });
}

function readOutboxRecord(store: Store, rowId: string): OutboxRecord | null {
  const raw = recordCellSchema.safeParse(store.getCell(OUTBOX_TABLE, rowId, OUTBOX_RECORD_CELL));
  if (!raw.success) return null;
  try {
    // SAFETY: this cell is written only by `writeOutboxRecord` above, which
    // stores `JSON.stringify(OutboxRecord)` — the parse of a value this module
    // alone produces. A malformed/foreign value throws and is caught.
    return JSON.parse(raw.data) as OutboxRecord;
  } catch {
    return null;
  }
}

export function readOutboxRecords(store: Store): OutboxRecord[] {
  return store
    .getRowIds(OUTBOX_TABLE)
    .map((rowId) => readOutboxRecord(store, rowId))
    .filter((record): record is OutboxRecord => record !== null);
}

function nextSequence(store: Store): number {
  return readOutboxRecords(store).reduce((max, record) => Math.max(max, record.sequence), 0) + 1;
}

// ---------------------------------------------------------------------------
// Enqueue + read
// ---------------------------------------------------------------------------

/** Queues a sync intent; returns the persisted record. */
export async function enqueueSyncIntent(
  input: EnqueueSyncInput,
  options: { store?: Store; now?: () => number } = {},
): Promise<OutboxRecord> {
  const store = options.store ?? (await getOutboxStore());
  const now = options.now ?? Date.now;
  const record: OutboxRecord = {
    clientId: input.clientId,
    intent: 'sync',
    sequence: nextSequence(store),
    createdAt: now(),
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: '',
  };
  writeOutboxRecord(store, record);
  return record;
}

/** Every queued record, for diagnostics/tests. */
export async function listOutboxRecords({ store }: { store?: Store } = {}): Promise<OutboxRecord[]> {
  return readOutboxRecords(store ?? (await getOutboxStore()));
}

// ---------------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------------

/**
 * Flushes the outbox in strict order. Each ready record is carried up by `run`;
 * a success is removed and the loop continues, any other outcome stops the loop
 * (so a later write never syncs ahead of an earlier failed one). The store,
 * runner, and clock are injectable for tests.
 */
export async function flushOutbox(
  options: { store?: Store; run?: OutboxRunner; now?: () => number } = {},
): Promise<FlushResult> {
  const store = options.store ?? (await getOutboxStore());
  const run = options.run ?? installedRunner ?? noRunnerInstalled;
  const now = options.now ?? Date.now;

  const ordered = selectFlushableRecords(readOutboxRecords(store), now());
  let flushed = 0;
  let stopped = false;
  let surface: FlushSurface = 'none';

  for (const record of ordered) {
    writeOutboxRecord(store, { ...record, status: 'syncing' });

    let outcome: FlushOutcome;
    try {
      outcome = classifyFlushOutcome(await run(record));
    } catch {
      outcome = classifyFlushFailure();
    }

    const transition = applyFlushOutcome({ record, outcome, nowMs: now() });
    if (transition.remove) {
      store.delRow(OUTBOX_TABLE, record.clientId);
      flushed += 1;
    } else if (transition.record) {
      writeOutboxRecord(store, transition.record);
    }
    if (transition.surface !== 'none') surface = transition.surface;
    if (transition.stop) {
      stopped = true;
      break;
    }
  }

  return {
    flushed,
    stopped,
    surface,
    remaining: store.getRowCount(OUTBOX_TABLE),
    nextRetryAt: earliestFailedRetryAt(readOutboxRecords(store)),
  };
}

/** The earliest `nextAttemptAt` among `failed` records, or null when none are waiting on a timer. */
function earliestFailedRetryAt(records: readonly OutboxRecord[]): number | null {
  const failedAt = records.filter((record) => record.status === 'failed').map((record) => record.nextAttemptAt);
  return failedAt.length === 0 ? null : Math.min(...failedAt);
}

/**
 * Single-flight wrapper over the default-store flush, so the reconnect triggers
 * (app start + `online` + `focus`) firing in quick succession share one run
 * instead of racing.
 */
let defaultFlight: Promise<FlushResult> | null = null;
export function flushOutboxOnce(): Promise<FlushResult> {
  if (!defaultFlight) {
    defaultFlight = flushOutbox().finally(() => {
      defaultFlight = null;
    });
  }
  return defaultFlight;
}
