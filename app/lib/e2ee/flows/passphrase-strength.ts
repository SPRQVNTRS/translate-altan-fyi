/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/passphrase-strength.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * A cheap, honest passphrase strength HINT — deliberately not a gate.
 *
 * The hard floor stays where it was: 12 characters (`setup-flow.ts`'s
 * `MIN_SYNC_PASSPHRASE_LENGTH`), enforced by `validateSyncPassphrase`. This
 * module adds a signal on top of it, and never blocks. Counsel's reasoning,
 * worth keeping written down: a strength meter that REFUSES pushes people
 * towards whatever pattern satisfies it (`Password1!`) rather than towards
 * length, and a user locked out of a feature by a scolding widget usually
 * picks something worse and writes it down. A hint that says "longer is what
 * actually helps" nudges in the right direction and gets out of the way.
 *
 * No zxcvbn, no dictionary, no dependency: this is a rough estimate rendered
 * as three words, and pulling in a ~400 KB dictionary to make it slightly less
 * rough would cost every visitor of a local-first app who never touches sync.
 * Length dominates the real entropy of a human-chosen passphrase anyway.
 *
 * Pure — takes a string, returns a verdict. Copy lives in the catalogs.
 */
import { MIN_SYNC_PASSPHRASE_LENGTH } from './setup-flow';

export type PassphraseStrength = 'weak' | 'fair' | 'strong';

/** Length at which a multi-word passphrase is doing real work; below it, character variety is carrying too much. */
const STRONG_LENGTH = 20;
const FAIR_LENGTH = 16;

/**
 * Rates a candidate passphrase.
 *
 * Three bands, and the boundaries say what the hint is for:
 *  - `weak` is reserved for input BELOW the hard minimum — the state the form
 *    already refuses. A short passphrase with symbols in it is still short,
 *    and calling it anything better would be the exact false reassurance this
 *    feature cannot afford: nothing recovers the data behind it.
 *  - `fair` is the default once the floor is cleared. It has passed the only
 *    rule; the hint's whole job from here is "longer helps".
 *  - `strong` needs real length, or moderate length plus genuine variety.
 *
 * Character classes are a weak signal and are treated as one — they can only
 * lift something that is already reasonably long, never rescue something
 * short. Length is what actually moves the number.
 */
export function ratePassphrase(passphrase: string): PassphraseStrength {
  const value = passphrase.trim();
  if (value.length < MIN_SYNC_PASSPHRASE_LENGTH) return 'weak';
  if (value.length >= STRONG_LENGTH) return 'strong';

  const classes = countCharacterClasses(value);
  const words = value.split(/\s+/).filter((word) => word.length > 0).length;
  if (value.length >= FAIR_LENGTH && (classes >= 3 || words >= 3)) return 'strong';
  return 'fair';
}

function countCharacterClasses(value: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((pattern) => pattern.test(value)).length;
}

/** The i18n key for a strength verdict — one place, so the three cases can never drift apart across surfaces. */
export function passphraseStrengthKey(strength: PassphraseStrength): string {
  return `sync.passphrase.strength.${strength}`;
}
