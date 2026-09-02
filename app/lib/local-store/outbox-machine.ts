/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/local-store/outbox-machine.ts @ 68e893a.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 *
 * The outbox flush state machine — pure, browser-free, and the unit-tested
 * heart of reconnect sync. It classifies a single flush attempt, computes retry
 * backoff, orders the queue, and folds an attempt's outcome into the next record
 * state. All I/O (the actual network call, the store writes) lives in
 * `outbox.ts`; this module never touches either, so its behaviour is fully
 * testable by feeding it plain records and result shapes.
 */
import type { FlushOutcome, FlushSurface, OutboxRecord, SyncAttemptResult } from './types';

/** After this many failed attempts a record is parked as `blocked` (never dropped). */
export const MAX_FLUSH_ATTEMPTS = 8;
/** First retry delay; each subsequent attempt doubles it up to the cap. */
export const BASE_BACKOFF_MS = 5_000;
/** Ceiling on the exponential backoff so a long-parked record still retries hourly-ish. */
export const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Classifies one sync attempt. A 401 is an auth stop, not a retry: re-running
 * it cannot succeed until the user signs in again.
 *
 * A DIVERGENCE FROM THE SOURCE, and the only one in this file. Upstream the
 * outcome came from a FOLLOWED REDIRECT — the add action redirected to the
 * diary on success and the auth middleware redirected to `/login` when the
 * session was gone, so the final URL was what told the two apart. There is no
 * redirect to read here: a sync push is an API call that answers with a status,
 * so the status is what is classified. The four outcomes, and everything
 * downstream of them, are unchanged.
 *
 * `401`/`403` stop the loop and ask for a re-login. `400`/`413` are permanent
 * rejections of this payload — a malformed push, or a blob past the size cap —
 * and retrying them forever would burn the device's battery to no end.
 * Everything else, including a thrown fetch (`status: null`), is transient.
 */
export function classifyFlushOutcome(result: SyncAttemptResult): FlushOutcome {
  if (result.ok) return 'success';
  if (result.status === 401 || result.status === 403) return 'authStop';
  if (result.status === 400 || result.status === 413) return 'fatal';
  return 'retry';
}

/** A thrown `fetch` (network dropped mid-flush) is always transient. */
export function classifyFlushFailure(): FlushOutcome {
  return 'retry';
}

/** Exponential backoff (ms) for the given attempt count, capped. `attempts` is 1-based. */
export function computeBackoffMs(attempts: number): number {
  const raw = BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(raw, MAX_BACKOFF_MS);
}

/**
 * The records eligible to flush right now, in strict enqueue order. `blocked`
 * records are excluded entirely (never auto-retried — see `applyFlushOutcome`).
 * Among the rest, selection STOPS at the first record whose backoff window
 * hasn't elapsed yet: a later-sequence record is never selected while an
 * earlier one is still parked, even across separate flush invocations —
 * `flushOutbox`'s own within-run stop-on-first-failure only protects a SINGLE
 * run; without this prefix-stop here, a fresh run (a new `flushOutboxOnce()`
 * call after the earlier record's own run already parked it) would happily
 * select a later-sequence ready record and flush it ahead of the still-backed-
 * off earlier one, violating the module's strict-ascending-replay invariant.
 */
export function selectFlushableRecords(records: readonly OutboxRecord[], nowMs: number): OutboxRecord[] {
  const ordered = records
    .filter((record) => record.status !== 'blocked')
    .toSorted((a, b) => a.sequence - b.sequence);

  const selected: OutboxRecord[] = [];
  for (const record of ordered) {
    if (record.nextAttemptAt > nowMs) break;
    selected.push(record);
  }
  return selected;
}

/** The next-state decision for one flushed record. */
export interface FlushTransition {
  /** Remove the record — it was confirmed (or idempotently already present). */
  remove: boolean;
  /** The updated record when it is kept; null when removed. */
  record: OutboxRecord | null;
  /** Stop the whole flush loop after this record (preserves strict ordering). */
  stop: boolean;
  surface: FlushSurface;
}

/**
 * Folds a single attempt's outcome into the next record state. A success is
 * removed and the loop continues; every other outcome stops the loop so a later
 * record can never sync ahead of an earlier failed one. A transient failure
 * backs the record off (and blocks it once retries are exhausted); an auth stop
 * keeps the record pending and surfaces a re-login prompt; a fatal rejection
 * parks the record as blocked — always kept, never silently dropped.
 */
export function applyFlushOutcome({
  record,
  outcome,
  nowMs,
}: {
  record: OutboxRecord;
  outcome: FlushOutcome;
  nowMs: number;
}): FlushTransition {
  if (outcome === 'success') {
    return { remove: true, record: null, stop: false, surface: 'none' };
  }
  if (outcome === 'authStop') {
    return { remove: false, record: { ...record, status: 'pending' }, stop: true, surface: 'reauth' };
  }
  if (outcome === 'fatal') {
    return {
      remove: false,
      record: { ...record, status: 'blocked', lastError: 'rejected' },
      stop: true,
      surface: 'blocked',
    };
  }
  const attempts = record.attempts + 1;
  if (attempts >= MAX_FLUSH_ATTEMPTS) {
    return {
      remove: false,
      record: { ...record, status: 'blocked', attempts, lastError: 'max-retries' },
      stop: true,
      surface: 'blocked',
    };
  }
  return {
    remove: false,
    record: {
      ...record,
      status: 'failed',
      attempts,
      nextAttemptAt: nowMs + computeBackoffMs(attempts),
      lastError: 'retry',
    },
    stop: true,
    surface: 'none',
  };
}
