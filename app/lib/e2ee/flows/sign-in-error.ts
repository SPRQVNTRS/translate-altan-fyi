/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/sign-in-error.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * Classifies why a sync sign-in failed, so the form can say something true.
 *
 * ── Why this is not an `error.message` check at the call site ─────────────
 *
 * `PROTOCOL.md` §4 is explicit that clients branch on the STATUS, never on the
 * prose — a service is free to reword an error, and a client that string-matched
 * would break silently when it did. `SyncRequestError.kind` is that status,
 * already normalised.
 *
 * ── Why sign-in has only two answers now ─────────────────────────────────
 *
 * It used to have three: a `403` meant "the credentials are right, the address
 * is simply not confirmed yet". M181 removed addresses and the verification
 * with them, so `POST /v1/auth/login` answers `401` for a wrong handle and a
 * wrong passphrase alike — ONE message for both, by protocol design, because
 * telling them apart would make the form an account-enumeration oracle.
 *
 * `signup-error.ts` is the counterpart and is still a separate function:
 * `POST /v1/auth/signup` answers `403` for two reasons a login can never
 * produce (the instance is closed, or it wants an invite, `PROTOCOL.md`
 * §5.8.1), and it needs the instance's signup mode to tell those apart.
 */
import { SyncRequestError } from '#app/lib/e2ee/client/sync-error';

export type SignInFailure =
  /** `401` — wrong handle or passphrase. One message for both, by protocol design. */
  | 'rejected'
  /** Anything else: transport, an incompatible service, a DEK that will not unwrap. Show what it said. */
  | 'other';

/** @param cause - anything the sign-in call threw. */
export function classifySignInFailure(cause: unknown): SignInFailure {
  if (!(cause instanceof SyncRequestError)) return 'other';
  if (cause.kind === 'unauthorized') return 'rejected';
  return 'other';
}

/**
 * Classifies why a recovery failed.
 *
 * SEPARATE FROM the sign-in classifier above even though both map `401` onto
 * "rejected", because the sentence each produces is different: a sign-in
 * failure sends the user back to their passphrase, a recovery failure sends
 * them back to the recovery code. The service answers ONE `401` for an unknown
 * handle, an account that never set a recovery code, a wrong code and a lost
 * rotation race — it deliberately will not distinguish them, so neither does
 * this.
 */
export type RecoveryFailure = 'rejected' | 'other';

/** @param cause - anything the recovery call threw. */
export function classifyRecoveryFailure(cause: unknown): RecoveryFailure {
  if (!(cause instanceof SyncRequestError)) return 'other';
  if (cause.kind === 'unauthorized') return 'rejected';
  return 'other';
}
