import { useEffect, useRef } from 'react';
import { serializeLanguagePair, type LanguagePair } from '#app/lib/dictionary/language-pair';
import { persistLanguagePair } from '#app/lib/local-store';

/** The pair this render settled on, as the route resolved it. */
export interface PersistLanguagePairProps {
  pair: LanguagePair;
}

/**
 * Remembers the language pair on this device, and renders nothing.
 *
 * IT WRITES BOTH COPIES, AND THAT IS THE WHOLE JOB. TinyBase is the durable
 * store and the cookie is the mirror the server can read while producing the
 * first byte of HTML. Writing them together is what stops a device from
 * rendering one pair on the server and holding another in its store. The two
 * writes live in `persistLanguagePair`, not here, because `LanguageBar` needs
 * them too. See `app/lib/dictionary/language-pair.ts` for why there are two
 * copies at all.
 *
 * IT IS THE SECOND WRITER, AND IT IS THE ONE THAT WINS. `LanguageBar` writes
 * the reader's RAW pick the moment they make it, so a pick on the landing page
 * survives a reload even though nothing is submitted there. On a results page
 * the form then submits, this loader runs, and the pair arriving here is the
 * RECONCILED one, which can differ: `reconcilePairWithDirection` repairs a
 * target that collides with the source detection settled on. This write lands
 * last and overwrites the bar's, which is correct, because the reconciled pair
 * is the pair the search actually used and the one the results on screen were
 * produced with. The apparent double write is the ordering, not a bug in it.
 *
 * IT SITS IN THE ROUTE, BESIDE `RecordSearch`, AND NOT INSIDE `SearchPanes`.
 * For the same reason that one does: `SearchPanes` is rendered by anything
 * that needs to show this surface without a session, and a sessionless render
 * of a surface must not write to the device.
 *
 * ONCE PER DISTINCT PAIR. A parent re-render for an unrelated reason must not
 * reopen the store, because resolving the primary store starts an IndexedDB
 * persister. The ref holds the pair actually written, so only a genuine change
 * writes again.
 *
 * A FAILED WRITE IS REPORTED AND SWALLOWED. The screen in front of the reader
 * is correct either way; losing the preference must not take the answer away
 * from them.
 */
export function PersistLanguagePair({ pair }: PersistLanguagePairProps): null {
  const { source, target } = pair;
  const lastWritten = useRef<string | null>(null);

  useEffect(() => {
    const next = { source, target };
    const key = serializeLanguagePair(next);
    if (lastWritten.current === key) return;
    lastWritten.current = key;
    void persistLanguagePair(next);
  }, [source, target]);

  return null;
}
