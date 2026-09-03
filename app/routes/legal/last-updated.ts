/**
 * When the legal documents last changed, as ONE date in ONE place.
 *
 * A date typed into each page as prose is two problems at once: two documents
 * drift to different dates, and a translated page carries either an English
 * date or a hand-typed German one that nobody remembers to update. Here it is
 * an ISO date formatted for the reader's language, so "September 2, 2026" and
 * "2. September 2026" are the same fact rendered twice.
 *
 * Bump it on a MATERIAL change to any of the three pages. All three tell the
 * reader they can rely on this date, so a stale one is a small lie.
 *
 * Follows `openplate/app/routes/legal/last-updated.ts`.
 */

/** The date all three legal pages print. ISO, UTC, one source. */
export const LEGAL_LAST_UPDATED = '2026-09-02';

/**
 * Formats the ISO date for a reader.
 *
 * @param isoDate a `YYYY-MM-DD` date, normally `LEGAL_LAST_UPDATED`.
 * @param language the active i18n language code; anything unknown falls back to `en`.
 * @returns the date as a long-form string in that language.
 */
export function formatLegalDate(isoDate: string, language: string): string {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  return new Intl.DateTimeFormat(language || 'en', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}
