/**
 * The translator's language pair, as two device-local store VALUES.
 *
 * This module has NO upstream counterpart, so it carries no provenance header.
 * It follows `nudge.ts`, which is the template for a device-local value: a
 * validated read, a plain write, and a store handed in so a test and a server
 * caller never resolve the browser singleton.
 *
 * IT IS NOT SYNCED, AND THAT IS DELIBERATE. The pair is a preference like the
 * theme, not something a person wrote: it carries no sync stamp, and the blob
 * projection (`blob-schema.ts`) carries collections only. A shared pair would
 * let a phone set to Turkish retarget the laptop in the middle of a sentence,
 * and the person would have no idea which device had done it.
 *
 * THE READ IS VALIDATED, THE WRITE IS NOT. A tampered or stale store, one
 * written by an older build or by a language this dictionary has stopped
 * serving, yields `null` here rather than a pair the search would then run
 * with. `null` means "this device has no preference", which every caller
 * already has to handle for a first visit.
 *
 * THE COOKIE IS THE OTHER HALF, AND IT LIVES ELSEWHERE.
 * `app/lib/dictionary/language-pair.ts` owns the shape, the parsing and the
 * cookie mirror the server reads while rendering the first byte of HTML. This
 * module is only the durable copy. Both are written together, by
 * `persistLanguagePair` at the foot of this file, so the two cannot drift.
 */
import type { Store } from 'tinybase';
import { z } from 'zod';
import { DETECT, PAIR_LANGUAGES, writeLanguagePairCookie, type LanguagePair } from '#app/lib/dictionary/language-pair';
import { reportError } from '#app/lib/report-error';
import { SOURCE_LANGUAGE_VALUE, TARGET_LANGUAGE_VALUE } from './store';
import { getPrimaryStore } from './persist';

/** The target side: one served language, and never `detect`. */
const targetSchema = z.enum(PAIR_LANGUAGES);
/** The source side: one served language, or the literal that asks for detection. */
const sourceSchema = z.union([z.literal(DETECT), targetSchema]);

interface StoreOption {
  store?: Store;
}

async function resolveStore(store: Store | undefined): Promise<Store> {
  return store ?? (await getPrimaryStore());
}

/**
 * The pair this device last chose, or `null` when it has chosen none.
 *
 * BOTH SIDES OR NEITHER. A store holding a source and no target is not half a
 * preference, it is a store that cannot be trusted, so it reads as `null` and
 * the caller falls back to the default pair rather than to a pair that is half
 * a stranger's and half this device's.
 */
export async function getLanguagePair({ store }: StoreOption = {}): Promise<LanguagePair | null> {
  const resolved = await resolveStore(store);
  const source = sourceSchema.safeParse(resolved.getValue(SOURCE_LANGUAGE_VALUE));
  const target = targetSchema.safeParse(resolved.getValue(TARGET_LANGUAGE_VALUE));
  if (!source.success || !target.success) return null;
  return { source: source.data, target: target.data };
}

/** Remembers the pair on this device, so the next visit opens on it. */
export async function setLanguagePair(pair: LanguagePair, { store }: StoreOption = {}): Promise<void> {
  const resolved = await resolveStore(store);
  resolved.setValue(SOURCE_LANGUAGE_VALUE, pair.source);
  resolved.setValue(TARGET_LANGUAGE_VALUE, pair.target);
}

/**
 * Write the pair to BOTH copies: the cookie the server reads and the store the
 * device keeps. The one writer, and every caller goes through it.
 *
 * IT IS ONE FUNCTION BECAUSE THERE ARE TWO CALLERS. `PersistLanguagePair`
 * writes the pair the loader resolved, and `LanguageBar` writes the pair the
 * reader just picked. Two call sites each repeating "cookie, then store" is how
 * the cookie and the store come to hold different pairs, which is the exact
 * failure the component's own header says it exists to prevent. So the pair of
 * writes lives here, once, and neither caller can perform half of it.
 *
 * THE COOKIE GOES FIRST, AND SYNCHRONOUSLY. It is what the next request renders
 * the bar from, and it is the copy a reader loses if the tab closes during the
 * IndexedDB round trip. The store write is asynchronous because resolving the
 * primary store opens a persister.
 *
 * A FAILED STORE WRITE IS REPORTED AND SWALLOWED, so this never rejects. Losing
 * a preference must not take the screen away from the reader, and no caller
 * has anything useful to do with the failure.
 *
 * @param pair - the pair to remember on this device.
 * @param store - a store to write to, for a test or a server-side caller. Left
 *   out, the browser's primary store is resolved.
 */
export async function persistLanguagePair(pair: LanguagePair, { store }: StoreOption = {}): Promise<void> {
  writeLanguagePairCookie(pair);
  try {
    await setLanguagePair(pair, { store });
  } catch (cause) {
    reportError(cause, { scope: 'persist-language-pair' });
  }
}
