/**
 * The password rule: a length floor and nothing else.
 *
 * ONE RULE, ON PURPOSE. Composition rules (a digit, a symbol, a capital) push
 * people towards `Password1!` rather than towards length, and length is the
 * only thing that measurably helps. `app/lib/auth/password-strength.ts` gives
 * the reader advice on top of this floor and never blocks: a meter that refuses
 * is a meter people work around.
 *
 * Pure: no database, no request, no clock. Unit tested.
 */

/** The floor, in characters. Counted as UTF-16 code units, which is what a form field reports. */
export const MIN_PASSWORD_LENGTH = 10;

/** The i18n key a screen renders when a password is too short. It interpolates `min`. */
export const PASSWORD_TOO_SHORT_KEY = 'account.passwordTooShort';

/**
 * Whether a password clears the floor.
 *
 * @param password the raw password, exactly as typed.
 * @returns true when it is long enough to be accepted.
 */
export function isAcceptablePassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH;
}
