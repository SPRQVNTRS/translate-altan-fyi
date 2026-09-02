/**
 * The recovery-code confirmation gate.
 *
 * WHY THIS IS A MODULE AND NOT AN INLINE COMPARISON. Setup may not complete
 * until the user has retyped the recovery code they were shown, and the whole
 * value of that step is that it cannot be satisfied by a code the user only
 * looked at. A comparison written inline in a component is a comparison no
 * test can reach, so the rule would be asserted by review instead of by the
 * suite. It lives here, pure, and `tests/unit/sync-ui.test.ts` drives it into
 * the reducer.
 *
 * WHY IT DECODES RATHER THAN COMPARING TEXT. The code is displayed grouped
 * (`XXXXX-XXXXX-...`) and a person retyping it may regroup it, lower-case it,
 * or leave the hyphens out. `parseRecoveryCode` already canonicalises all of
 * that, and comparing the decoded BYTES means the gate accepts every spelling
 * of the right code and no spelling of a wrong one. A `String.includes` or a
 * loose prefix check would accept a partially typed code, which is exactly the
 * "I have a copy" claim this step exists to disprove.
 *
 * WHY THE LOOP HAS NO EARLY EXIT. The comparison runs over every byte and
 * accumulates the difference, so the time it takes does not depend on how many
 * leading bytes were right. The length check above it does leak the length,
 * which is fixed and public for this code format, so it costs nothing.
 */
import { parseRecoveryCode } from '#app/lib/e2ee/client/recovery-kek';

/** Everything the decoder ignores: the display hyphens, spaces, anything a person might type between groups. */
const SEPARATORS = /[^0-9A-Za-z]/g;

/** The code as the decoder sees it, so a length comparison counts code characters and not formatting. */
function canonicaliseForLength(value: string): string {
  return value.replace(SEPARATORS, '');
}

/**
 * Whether a retyped recovery code matches the one that was shown.
 *
 * @param typed - what the user entered, in any grouping or case.
 * @param expected - the formatted code the app displayed once.
 */
export function isRecoveryCodeConfirmed({ typed, expected }: { typed: string; expected: string }): boolean {
  // The character count is checked BEFORE the bytes, and this is not belt and
  // braces. Base32 packs five bits per character, so a code with one extra
  // character on the end decodes to exactly the same bytes: the leftover bits
  // never fill a byte and are dropped. Comparing only the decoded bytes would
  // therefore accept a code the user did not type. The test suite caught this
  // rather than a reviewer, which is the argument for the gate living in a
  // testable function.
  if (canonicaliseForLength(typed).length !== canonicaliseForLength(expected).length) return false;

  const typedBytes = parseRecoveryCode(typed);
  const expectedBytes = parseRecoveryCode(expected);
  if (typedBytes === null || expectedBytes === null) return false;
  if (typedBytes.length !== expectedBytes.length) return false;

  let difference = 0;
  for (let index = 0; index < typedBytes.length; index += 1) {
    difference |= (typedBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }
  return difference === 0;
}
