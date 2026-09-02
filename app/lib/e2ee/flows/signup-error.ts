/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/signup-error.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * Classifies why creating a sync account failed, so the form can say something
 * true rather than "check your details".
 *
 * ── Why this is separate from `sign-in-error.ts` ──────────────────────────
 *
 * They map the SAME statuses onto different meanings. `POST /v1/auth/login`
 * answers `401` for a wrong handle or a wrong passphrase and nothing else. On
 * `POST /v1/auth/signup` a `403` means the instance refused to create an
 * account — either because it is closed, or because it wanted an invite — and
 * a `409` means the handle is taken. One function covering both would have to
 * guess which endpoint it was called for.
 *
 * ── The 403 needs the instance's mode to be readable ──────────────────────
 *
 * `PROTOCOL.md` §4 is explicit that clients branch on the STATUS, never the
 * prose, and the service deliberately returns the same `403` for a missing,
 * unknown, expired and already-spent invite — telling those apart would let a
 * caller probe which tokens exist. So the status alone cannot say whether the
 * user needs an invite or whether the door is simply shut.
 *
 * That is what `signupMode` on the handshake (§5.6) is for, and why it is
 * passed in here rather than inferred. When it is unknown — an older service,
 * or one that could not be reached — the honest answer is the generic refusal,
 * not a guess that would send somebody looking for an invitation that does not
 * exist.
 */
import { SyncRequestError } from '#app/lib/e2ee/client/sync-error';
import type { SignupMode } from '#app/lib/e2ee/protocol';

export type SignupFailure =
  /** `403` on an invite-only instance: no invite, or one that is not (or no longer) valid. */
  | 'invite-required'
  /** `403` on an instance that is not accepting accounts at all. */
  | 'signups-closed'
  /** `409` — that handle already has an account here. The ONE accepted enumeration oracle on this service, and since M181 it leaks an opaque string rather than a person's address. */
  | 'handle-taken'
  /** Anything else: transport, an incompatible service, a malformed request. Show what it said. */
  | 'other';

/**
 * @param cause - anything the signup call threw.
 * @param signupMode - what the handshake reported, or `null` when unknown.
 */
export function classifySignupFailure(cause: unknown, signupMode: SignupMode | null): SignupFailure {
  if (!(cause instanceof SyncRequestError)) return 'other';
  if (cause.kind === 'conflict') return 'handle-taken';
  if (cause.kind !== 'forbidden') return 'other';
  // `closed` is reported as closed; everything else — including an unknown
  // mode — falls back to the generic refusal rather than promising the user
  // that an invite would fix it.
  if (signupMode === 'invite') return 'invite-required';
  return 'signups-closed';
}
