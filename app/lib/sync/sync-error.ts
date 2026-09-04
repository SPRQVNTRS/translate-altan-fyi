/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/engine/client/sync-error.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 *
 * It moved here from `app/lib/e2ee/client/` in M191 with the rest of the sync
 * client. Nothing about it changed: a status code still decides the kind.
 */
/**
 * The single error type every sync HTTP call throws.
 *
 * Clients branch on the STATUS CODE and never on the message text, so this carries a `kind` derived from the status
 * and keeps the server's prose only for diagnostics. A caller that switches on
 * `error.kind` is following the protocol; one that string-matches `message` is
 * not, and will break the first time a server rewords something.
 *
 * Errors, not booleans: every one of these means an operation did not happen.
 * A `false` return would have to be checked, and the checks are exactly what
 * gets forgotten on the path where a missed failure strands someone's data.
 */

/** Protocol-meaningful failure classes. `conflict` is deliberately NOT here — a 409 is a normal outcome, not an error. */
export type SyncErrorKind =
  /** `400` — the request was malformed. A bug on this side, not a user problem. */
  | 'invalid'
  /** `401` — no valid session. After one failed refresh this means "send the user to sign in again". */
  | 'unauthorized'
  /** `403` — authenticated but not permitted (signups closed, email unverified). */
  | 'forbidden'
  /** `404` — no such resource. Only an error where the protocol doesn't already give 404 a meaning. */
  | 'not-found'
  /** `409` — a conflict the caller could not resolve. (A blob 409 is a CAS outcome and never reaches here.) */
  | 'conflict'
  /** `413` — the document exceeds the size cap. The capacity cliff, reached. */
  | 'too-large'
  /** `429` — throttled. `retryAfterSeconds` carries the server's own advice. */
  | 'throttled'
  /** Network failure, DNS, CORS, or a non-JSON body. The service could not be reached or understood. */
  | 'transport'
  /** Any other non-2xx. Treated as retryable-but-unexplained. */
  | 'server';

export class SyncRequestError extends Error {
  readonly kind: SyncErrorKind;
  /** The HTTP status, when there was one. `null` for a transport failure that never got a response. */
  readonly status: number | null;
  /** From `Retry-After`, in seconds — only ever set on `throttled`. */
  readonly retryAfterSeconds: number | null;

  constructor({
    kind,
    message,
    status = null,
    retryAfterSeconds = null,
  }: {
    kind: SyncErrorKind;
    message: string;
    status?: number | null;
    retryAfterSeconds?: number | null;
  }) {
    super(message);
    this.name = 'SyncRequestError';
    this.kind = kind;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Maps a status code onto its {@link SyncErrorKind}. The only place that mapping is written down. */
export function errorKindForStatus(status: number): SyncErrorKind {
  if (status === 400) return 'invalid';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'too-large';
  if (status === 429) return 'throttled';
  return 'server';
}

/** Narrowing helper so call sites can branch without an `instanceof` dance in every `catch`. */
export function isSyncRequestError(cause: unknown): cause is SyncRequestError {
  return cause instanceof SyncRequestError;
}
