/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/recovery-flow.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * The recovery fork — a pure state machine, and what is left of the old reset
 * flow once the mailed link went away.
 *
 * ── What changed, and why the file was renamed rather than wrapped ────────
 *
 * `reset-flow.ts` asked ONE question: "do you have your recovery code?" A
 * "no" was allowed, because `POST /v1/auth/reset` restored LOGIN without ever
 * touching the data — producing a working, empty account whose existing blob
 * was permanently undecryptable. The whole machine existed to make that branch
 * unskippable and explicit.
 *
 * M181 deleted the reset endpoint. The recovery code is now the second
 * AUTHENTICATOR, so there is no longer a "no" branch to gate: without the code
 * there is no way in at all, and inventing one would mean the server could
 * open the data. What the flow must still do is state that plainly, before the
 * user goes looking for a door that does not exist. Hence a rename and not a
 * wrapper — leaving a "reset" name on a flow that no longer resets by mail is
 * how the mailed-link mental model survives its own deletion.
 *
 * It keeps `setup-flow.ts`'s shape on purpose: the same `kind`-discriminated
 * union, and the same "an action that doesn't apply to this state is a no-op,
 * never a throw", so a late-arriving async result cannot crash a screen the
 * user has already moved on from.
 */

/** Every screen the recovery flow can be on. Invalid combinations are unrepresentable — they are different `kind`s. */
export type RecoveryFlowState =
  /** The one form: handle, recovery code, new passphrase. */
  | { kind: 'entering'; error: string | null }
  | { kind: 'submitting' }
  /** Failed, and re-enterable: the values are still in the form, and a mistyped code is the likeliest cause. */
  | { kind: 'failed'; message: string }
  | { kind: 'complete' };

export type RecoveryFlowAction =
  | { type: 'submitted' }
  | { type: 'rejected'; message: string }
  | { type: 'failed'; message: string }
  | { type: 'succeeded' }
  | { type: 'retried' };

export const INITIAL_RECOVERY_FLOW_STATE: RecoveryFlowState = { kind: 'entering', error: null };

/**
 * Whether the flow may submit from `state`.
 *
 * Exported and used by BOTH the reducer and the component's disabled state, so
 * "can this be submitted" has exactly one definition. Two definitions is how a
 * button ends up enabled on a screen the reducer would refuse.
 *
 * It deliberately says nothing about whether the FIELDS are filled: that is
 * the form's own `required` business, and duplicating it here would put the
 * same rule in two places again.
 */
export function canSubmitRecovery(state: RecoveryFlowState): boolean {
  return state.kind === 'entering';
}

export function recoveryFlowReducer(state: RecoveryFlowState, action: RecoveryFlowAction): RecoveryFlowState {
  if (action.type === 'rejected' && state.kind === 'entering') {
    return { kind: 'entering', error: action.message };
  }
  if (action.type === 'submitted' && canSubmitRecovery(state)) {
    return { kind: 'submitting' };
  }
  if (action.type === 'failed' && state.kind === 'submitting') {
    return { kind: 'failed', message: action.message };
  }
  if (action.type === 'succeeded' && state.kind === 'submitting') {
    return { kind: 'complete' };
  }
  if (action.type === 'retried' && state.kind === 'failed') {
    return { kind: 'entering', error: null };
  }
  return state;
}
