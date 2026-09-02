/**
 * The daily nudge's day boundary: one device-local calendar date, stored as a
 * store VALUE.
 *
 * This module has NO upstream counterpart, so it carries no provenance header.
 *
 * THE READER'S CLOCK IS THE ONLY CLOCK THERE IS. The server cannot read this
 * person's words, so it cannot decide when their day starts either, and the
 * device may be offline from one midnight to the next. The boundary is
 * therefore the device's own calendar date, formatted here and compared as
 * text, so a nudge shown at 23:59 does not reappear at 00:01 as "the same
 * day" and does not stay suppressed for a full 24 hours either.
 *
 * IT IS NOT SYNCED, AND THAT IS DELIBERATE. `nudgeShownOn` is a value rather
 * than an entity, it carries no sync stamp, and the blob projection
 * (`blob-schema.ts`) carries collections only. A shared marker would let a
 * phone opened at breakfast silence the laptop opened at lunch, and the person
 * would simply never see the nudge on their second device.
 *
 * THE DATE IS WRITTEN WHEN THE NUDGE IS SHOWN, not when it is dismissed. Those
 * are the same rule stated once: the nudge appears at most once per local day,
 * so dismissing it is what the reader does to the card in front of them, and
 * the marker is what keeps it away tomorrow morning rather than this afternoon.
 * A nudge that comes back after a dismissal is how an app gets its
 * notifications turned off, and this one has none to turn off.
 */
import type { Store } from 'tinybase';
import { z } from 'zod';
import { NUDGE_SHOWN_ON_VALUE } from './store';
import { getPrimaryStore } from './persist';

/** A local calendar date, `YYYY-MM-DD`, as it comes back off the store. */
const shownOnSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

interface StoreOption {
  store?: Store;
}

async function resolveStore(store: Store | undefined): Promise<Store> {
  return store ?? (await getPrimaryStore());
}

/** Two digits, so `2026-09-03` never comes out as `2026-9-3` and text comparison stays sound. */
function padded(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * The device's local calendar date as `YYYY-MM-DD`.
 *
 * LOCAL GETTERS, NOT `toISOString`. The ISO form is UTC, so a reader in Berlin
 * opening the app at 00:30 would be told it is still yesterday, and one in
 * Auckland would roll over in the middle of their afternoon. The whole point of
 * this value is the reader's own midnight.
 *
 * Pure, and takes its `Date` from the caller, so a test can drive a year of
 * boundaries without touching the system clock.
 */
export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${padded(date.getMonth() + 1)}-${padded(date.getDate())}`;
}

/**
 * Whether the nudge may appear right now.
 *
 * Pure, and the whole once-per-day rule. Any date other than today's means the
 * nudge has not been shown today: that covers the first ever visit (`null`),
 * yesterday, and a device whose clock was moved backwards, all of which should
 * show it rather than swallow it.
 *
 * @param shownOn - the stored local date, or null when the nudge has never been shown here.
 * @param today - the device's local date right now, from {@link localDateKey}.
 */
export function shouldShowNudge({ shownOn, today }: { shownOn: string | null; today: string }): boolean {
  return shownOn !== today;
}

/** The local date the nudge was last shown on this device, or null. */
export async function getNudgeShownOn({ store }: StoreOption = {}): Promise<string | null> {
  const parsed = shownOnSchema.safeParse((await resolveStore(store)).getValue(NUDGE_SHOWN_ON_VALUE));
  return parsed.success ? parsed.data : null;
}

/** Records that the nudge was shown on `today`, so it does not come back until tomorrow. */
export async function markNudgeShown(today: string, { store }: StoreOption = {}): Promise<void> {
  (await resolveStore(store)).setValue(NUDGE_SHOWN_ON_VALUE, today);
}
