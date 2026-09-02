/**
 * THE DECRYPTED COPY OF EVERYTHING, BUILT ON THIS DEVICE.
 *
 * This button is the answer to "the server cannot read my data, then how do I
 * get it out". The whole export is assembled in the browser from the local
 * store, serialized here, and handed to the user as a file. The server is not
 * in this path at all: it is never asked, it is never told, and it could not
 * help if it were, because all it holds is ciphertext and it has no key for
 * it. The file is plain readable JSON, which is the point, a backup nobody can
 * open is not a backup.
 *
 * IT RENDERS FOR A SIGNED-OUT VISITOR TOO. The data being exported is the
 * DEVICE'S, not an account's: search, lists, history and notes all work with
 * no account at all, so an account has nothing to do with whether the user may
 * have a copy. Gating this on a session would make the app's one data-portability
 * control the one place that demands the sign-up the app promises never to
 * demand.
 *
 * WHAT IT WRITES DOWN is decided by `app/lib/local-store/backup.ts`: all four
 * collections including search history, because a backup that quietly drops a
 * collection is a backup that lies. That is a different question from what
 * goes into a sync blob, which is answered in `app/lib/e2ee/BLOB-CONTENTS.md`.
 *
 * CLIENT ONLY. Every import here is browser-safe, and nothing from a `.server`
 * module is reachable from this file.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';

import { exportBackup, hasAnyLocalData, markExported, serializeBackup } from '#app/lib/local-store';
import { Button } from '#app/components/ui/button';

/** The download's MIME type. The file really is JSON, and saying so is what makes it open in the right thing. */
const EXPORT_MIME_TYPE = 'application/json';

/** `translate-altan-fyi-2026-09-02.json`. A date is enough: nobody exports twice a second, and a clock time reads as noise. */
const FILE_NAME_PREFIX = 'translate-altan-fyi-';

/** Length of the `YYYY-MM-DD` head of an ISO-8601 instant. */
const ISO_DATE_LENGTH = 10;

/**
 * The export card.
 *
 * `hasAnyLocalData` is an IndexedDB read, so it cannot run during the server
 * render and its answer is not known on the first paint. `null` is that third
 * state and it is deliberately not collapsed into `false`: showing "there is
 * nothing to export" to somebody who has data, for the frame before the store
 * answers, would be a lie the user has no reason to doubt.
 */
export function ExportDataButton() {
  const { t } = useTranslation();
  const [hasData, setHasData] = useState<boolean | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    let isMounted = true;
    // A store that cannot be opened is reported as empty rather than thrown:
    // the card is a side feature of the account screen, and it must not be
    // able to take the page down with it.
    const check = async (): Promise<void> => {
      try {
        const found = await hasAnyLocalData();
        if (isMounted) setHasData(found);
      } catch {
        if (isMounted) setHasData(false);
      }
    };
    void check();
    return () => {
      isMounted = false;
    };
  }, []);

  const handleExport = async (): Promise<void> => {
    setIsExporting(true);
    try {
      downloadFile(serializeBackup(await exportBackup()));
      // Stamped only after the file has been handed over, so a failed export
      // does not reset the "days since your last backup" nudge.
      await markExported();
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="rounded-xl border bg-card p-6">
      <h2 className="font-display text-base font-semibold">{t('account.exportTitle')}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t('account.exportBody')}</p>
      {hasData === false && <p className="mt-4 text-sm text-muted-foreground">{t('account.exportEmpty')}</p>}
      <Button type="button" className="mt-4" disabled={hasData !== true || isExporting} onClick={handleExport}>
        {isExporting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {t('account.exportButton')}
      </Button>
    </div>
  );
}

/**
 * Hands a string to the user as a downloaded file.
 *
 * The object URL is revoked immediately after the click. The browser has
 * already taken its own reference to the blob by then, so the download
 * completes, and holding the URL any longer would pin the whole export in
 * memory for the life of the tab.
 */
function downloadFile(json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: EXPORT_MIME_TYPE }));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${FILE_NAME_PREFIX}${new Date().toISOString().slice(0, ISO_DATE_LENGTH)}.json`;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
