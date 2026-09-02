/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/error-text.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * Turns whatever a sync operation threw into a sentence a user can act on.
 *
 * ── Why this is not just `error instanceof Error ? error.message : fallback` ─
 *
 * That is what every sync surface used to do inline, and it produced a screen
 * showing a bare "Try again" button with NO explanation — the least useful
 * possible failure state, because it tells the user neither what happened nor
 * whether retrying could ever help.
 *
 * The reason is the class of thing WebCrypto throws. `crypto.subtle` rejects
 * with a `DOMException`, and while modern engines do make `DOMException`
 * inherit from `Error`, that is not something to bet a blank error screen on —
 * and it is not the only non-`Error` throwable in reach: a rejected worker
 * message, a structured-clone failure, or a library that throws a plain object
 * or a string all land here too. Anything with a usable `message` should
 * produce one.
 *
 * Pure and total: it never throws, and it never returns an empty string.
 */
import { z } from 'zod';

/** A thrown value that is itself the message. */
const thrownString = z.string();

/**
 * A throwable carrying a displayable `message` that is not (or does not appear
 * to be) an `Error` in this realm: a cross-realm `Error`, a `DOMException` in
 * an engine where it does not extend `Error`, or a plain `{ message }` object.
 */
const thrownWithMessage = z.object({ message: z.string() });

/**
 * Extracts a displayable message, falling back only when there genuinely is
 * nothing to show.
 *
 * @param cause - anything a `catch` produced.
 * @param fallback - already-translated copy for the "no message at all" case.
 */
export function describeErrorForUser(cause: unknown, fallback: string): string {
  const message = readMessage(cause);
  return message === null ? fallback : message;
}

function readMessage(cause: unknown): string | null {
  // Covers Error, DOMException, and every subclass — the common case.
  if (cause instanceof Error) return nonEmpty(cause.message);
  // A thrown string is rare but trivially displayable.
  const thrown = thrownString.safeParse(cause);
  if (thrown.success) return nonEmpty(thrown.data);
  // Duck-typed: a DOMException in an engine where it does not extend Error, a
  // cross-realm Error (a worker's, a different iframe's) whose `instanceof`
  // check fails against THIS realm's constructor, or a plain `{ message }`.
  const carrier = thrownWithMessage.safeParse(cause);
  if (carrier.success) return nonEmpty(carrier.data.message);
  return null;
}

function nonEmpty(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
