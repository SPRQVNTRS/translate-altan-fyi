/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/setup-flow.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * Pure state machine for the sync-setup wizard (M117/08 item 5) — the
 * details-entry -> account-card -> confirm-saved dance the
 * design/counsel review called table stakes for a paid, unrecoverable-by-
 * design feature. No React, no crypto, no fetch: this file only decides
 * which screen is showing and how it responds to an event. The actual
 * engine calls (Argon2id/HKDF/AES-GCM — `app/lib/sync/engine/`) and the
 * key-record PUT requests are the imperative shell around this reducer,
 * living in `CreateAccountFlow`
 * (`#app/components/account/create-account-flow.tsx`) — mirrors the `tao-of-node-react`
 * "useReducer over chained useState" pattern: invalid combinations (e.g.
 * "generating" AND an error message) are unrepresentable because they're
 * different `kind`s, not independent booleans.
 */

/** Minimum passphrase length (M117/08) — a sync passphrase protects data with no server-side recovery, so it's held to a higher floor than a login password. */
export const MIN_SYNC_PASSPHRASE_LENGTH = 12;

/**
 * A translation lookup, threaded in as a parameter (M129/05).
 *
 * This module must stay pure and importable from `node:test`, so it never
 * imports the i18next singleton — the caller (a React component) passes its
 * own `t` down.
 */
export type Translate = (key: string, params?: Readonly<Record<string, string | number | boolean | Date>>) => string;

/**
 * Validates a candidate password.
 *
 * The interface says "password" and the protocol says "passphrase". They are
 * the same string: this is the one place the two vocabularies meet, so the
 * name faces the UI and the constant it checks keeps the wire's word.
 *
 * @param password - the raw, untrimmed password input.
 * @param t - translation lookup for the rejection message.
 * @returns an error message when invalid, or `null` when the password is acceptable.
 */
export function validatePassword(password: string, t: Translate): string | null {
  if (password.trim().length < MIN_SYNC_PASSPHRASE_LENGTH) {
    return t('account.passwordTooShort', { min: MIN_SYNC_PASSPHRASE_LENGTH });
  }
  return null;
}

/**
 * What a provisioning attempt can END in — the contract between the ceremony
 * and whatever is doing the actual work (`sync-actions.ts`).
 *
 * ONE outcome, since M181. The old second branch existed for an instance that
 * withheld the session until an address was confirmed; with no address there
 * is nothing to confirm, so a signup either produces an account with a session
 * or throws.
 *
 * Both fields are carried because both are shown, together, on one account
 * card. The handle is not decoration: a user who saves the recovery code and
 * never registers that the handle is equally required to get back in has saved
 * half a credential.
 */
export type SyncSetupOutcome = { status: 'ready'; handle: string; recoveryCode: string };

export type SyncSetupState =
  /** The one form: the invite code and the password. */
  | { kind: 'enter-details'; error: string | null }
  | { kind: 'generating' }
  /** THE READY SCREEN: sign-in name and recovery code on one screen, behind one save confirmation. */
  | { kind: 'show-account-card'; handle: string; recoveryCode: string; hasConfirmedSaved: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'complete' };

export type SyncSetupAction =
  | { type: 'detailsRejected'; message: string }
  | { type: 'detailsSubmitted' }
  | { type: 'setupSucceeded'; handle: string; recoveryCode: string }
  | { type: 'setupFailed'; message: string }
  | { type: 'confirmSavedToggled'; checked: boolean }
  | { type: 'finishRequested' }
  | { type: 'retried' };

/**
 * The state a wizard starts in.
 *
 * `resume` is the setup-COMPLETION path: the account already exists and both
 * the handle and the passphrase have already been typed (on the sign-in form),
 * so there is nothing to ask for and the ceremony opens straight into
 * `generating`. Everything
 * after that — the recovery-code display and its un-skippable acknowledgment —
 * is the same ceremony as first-time setup, because a code produced by a
 * repair is exactly as unrecoverable as one produced by a signup.
 */
export function initialSyncSetupState(options?: { resume?: boolean }): SyncSetupState {
  return options?.resume === true ? { kind: 'generating' } : INITIAL_SYNC_SETUP_STATE;
}

export const INITIAL_SYNC_SETUP_STATE: SyncSetupState = { kind: 'enter-details', error: null };

/**
 * Whether the wizard is holding something the user MUST still see, so no
 * surrounding screen may swap it out.
 *
 * ── The bug this exists to prevent ───────────────────────────────────────
 *
 * `createSyncAccount` opens the sync session as part of provisioning. The
 * settings route rendered `session.account === null ? <setup> : <connected>`,
 * so the instant provisioning finished — while this reducer was still moving
 * from `generating` to `show-account-card` — the route swapped panels and
 * unmounted the wizard mid-transition. The recovery code was generated,
 * written to the server, and never displayed. It is shown exactly once and is
 * the only data-preserving recovery path there is, so that is a silent,
 * permanent loss of the user's only backup key.
 *
 * Both halves were individually correct; the composition was not. Hence a
 * PURE predicate here rather than a boolean threaded through components: the
 * rule is stated once, tested directly, and `resolveSyncScreen`
 * (`setup-screen.ts`) is the only thing allowed to act on it.
 *
 * - `generating` — the session flips to signed-in DURING this state. Protected.
 * - `show-account-card` — the one and only display of the handle beside the
 *   recovery code. Protected.
 * - `enter-details` — nothing shown yet, and no session exists to swap to.
 * - `error` — nothing to protect; if an account was created anyway, letting
 *   the connected panel take over is the more useful outcome than trapping
 *   the user in a wizard for an account that already exists.
 * - `complete` — the user has acknowledged. Handing over is correct.
 */
export function isSyncSetupCeremonyActive(state: SyncSetupState): boolean {
  return state.kind === 'generating' || state.kind === 'show-account-card';
}

/**
 * Advances the setup wizard. Every transition below is a deliberate,
 * exhaustive choice — an action that doesn't apply to the current `kind` is
 * a no-op (returns `state` unchanged) rather than throwing, since a stray
 * late-arriving action (e.g. a slow fetch resolving after the user already
 * hit "retry") should never crash the UI.
 */
export function syncSetupReducer(state: SyncSetupState, action: SyncSetupAction): SyncSetupState {
  if (action.type === 'detailsRejected' && state.kind === 'enter-details') {
    return { kind: 'enter-details', error: action.message };
  }
  if (action.type === 'detailsSubmitted' && state.kind === 'enter-details') {
    return { kind: 'generating' };
  }
  if (action.type === 'setupSucceeded' && state.kind === 'generating') {
    return {
      kind: 'show-account-card',
      handle: action.handle,
      recoveryCode: action.recoveryCode,
      hasConfirmedSaved: false,
    };
  }
  if (action.type === 'setupFailed' && state.kind === 'generating') {
    return { kind: 'error', message: action.message };
  }
  if (action.type === 'confirmSavedToggled' && state.kind === 'show-account-card') {
    return { ...state, hasConfirmedSaved: action.checked };
  }
  // The confirm-saved dance (D5 / counsel End User review): setup can only
  // complete once the user has explicitly acknowledged they saved the account
  // card — the button that dispatches this is disabled until then, but the
  // reducer re-checks so a forged/replayed action can't skip it either.
  if (action.type === 'finishRequested' && state.kind === 'show-account-card' && state.hasConfirmedSaved) {
    return { kind: 'complete' };
  }
  if (action.type === 'retried' && state.kind === 'error') {
    return { kind: 'enter-details', error: null };
  }
  return state;
}
