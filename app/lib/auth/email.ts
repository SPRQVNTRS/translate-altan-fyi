/**
 * The one normal form of an address, and the one check on its shape.
 *
 * EVERY WRITE OF `users.email` GOES THROUGH {@link normalizeEmail}, and the
 * unique index is over that form. A hand-rolled `toLowerCase()` at one call
 * site is how two rows for the same person appear, so the form is defined once
 * here and nowhere else.
 *
 * Pure: no database, no request, no clock. Unit tested.
 */
import { z } from 'zod';

/** The shape check. Deliberately the loose one: the mailed link is the real proof, not a regular expression. */
const emailSchema = z.string().trim().toLowerCase().email().max(254);

/**
 * The stored form of an address: trimmed and lower-cased.
 *
 * @param raw whatever the form field carried.
 * @returns the normalized address.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * The normalized address, or `null` when it is not one.
 *
 * @param raw whatever the form field carried.
 * @returns the normalized address, or `null` when the shape is wrong.
 */
export function parseEmail(raw: string): string | null {
  const parsed = emailSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
