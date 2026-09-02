/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/local-store/types.ts @ 68e893a.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 *
 * Shared shapes for the TinyBase local-first layer. Pure types only — this
 * module has no runtime dependencies (every import is `import type`), so the
 * pure logic module (`outbox-machine`) that consumes it stays trivially
 * unit-testable without a browser or a TinyBase store.
 *
 * WHAT A RECORD MEANS DIVERGES FROM THE SOURCE. Upstream an outbox record was a
 * queued FORM POST to an `/add` route, carrying the verbatim field-set to
 * replay and a display payload for the provisional diary card. Here a record is
 * a queued SYNC INTENT: "the local store changed at this sequence and has not
 * been carried up yet". There is no payload, because the payload is the store
 * itself; the sequence and the idempotency key are the whole record. The
 * lifecycle, the backoff and the strict replay order are unchanged, which is
 * why `outbox-machine.ts` is a near-verbatim copy.
 */

/** Which intent an outbox record replays. There is exactly one today, named rather than implied so a second is a type error rather than a silent widening. */
export type OutboxIntent = 'sync';

/**
 * Lifecycle of a queued write:
 * - `pending`  — enqueued, waiting for the next flush.
 * - `syncing`  — a flush attempt is in flight.
 * - `failed`   — a transient failure; retried after `nextAttemptAt` (backoff).
 * - `blocked`  — a permanent rejection or exhausted retries; kept, never dropped.
 */
export type OutboxStatus = 'pending' | 'syncing' | 'failed' | 'blocked';

/**
 * One queued sync intent. `clientId` is a client-generated UUID that doubles as
 * the store rowId and the idempotency key, so replaying the same record is
 * exactly-once.
 */
export interface OutboxRecord {
  clientId: string;
  intent: OutboxIntent;
  /** Monotonic enqueue order — the flush replays strictly ascending. */
  sequence: number;
  createdAt: number;
  status: OutboxStatus;
  attempts: number;
  /** Epoch ms before which a `failed` record is not retried; 0 = ready now. */
  nextAttemptAt: number;
  /** Last failure reason (never a secret); '' when none. */
  lastError: string;
}

/** Input to `enqueueSyncIntent` — everything but the assigned `sequence`/`createdAt`. */
export interface EnqueueSyncInput {
  clientId: string;
}

/** What a flush attempt should trigger in the UI after it settles. */
export type FlushSurface = 'none' | 'reauth' | 'blocked';

/** Classification of a single flush attempt. */
export type FlushOutcome = 'success' | 'retry' | 'authStop' | 'fatal';

/**
 * The result of one sync attempt, as the flush state machine reasons about it.
 * `status` is `null` when the attempt threw before any HTTP status existed (a
 * dropped connection), which is the same shape a `fetch` rejection has.
 */
export interface SyncAttemptResult {
  ok: boolean;
  status: number | null;
}

/** Summary of a whole flush run. */
export interface FlushResult {
  /** Records confirmed and removed this run. */
  flushed: number;
  /** True when the loop stopped early (retry/auth/blocked) rather than draining. */
  stopped: boolean;
  surface: FlushSurface;
  /** Records still queued after the run. */
  remaining: number;
  /**
   * The earliest `nextAttemptAt` among any `failed` records left queued after
   * this run, or `null` when nothing needs a scheduled retry (drained, or
   * every remaining record is `blocked`/`pending`-behind-an-auth-stop). Lets a
   * caller schedule the next automatic flush instead of waiting indefinitely
   * for the next online/focus event.
   */
  nextRetryAt: number | null;
}
