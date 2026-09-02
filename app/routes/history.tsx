import type { Route } from './+types/history';
import { useTranslation } from 'react-i18next';
import type { MetaFunction } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { ConfirmAction } from '#app/components/confirm-action';
import { Link } from '#app/components/link';
import { Button } from '#app/components/ui/button';
import { Skeleton } from '#app/components/ui/skeleton';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { clearHistory, listHistory } from '#app/lib/local-store';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: metaTitle(language, 'history.metaTitle') },
    { name: 'description', content: metaTitle(language, 'history.metaDescription') },
  ];
};

/**
 * The searches this device has run.
 *
 * A CLIENT LOADER, AND IT COULD NOT BE ANYTHING ELSE. Search history is the one
 * personal entity that never leaves the device: it has no server table, no sync
 * blob and no endpoint (`app/lib/e2ee/BLOB-CONTENTS.md`). A server loader here
 * would have nothing to read, and asking for one would mean telling the server
 * what somebody looked up.
 *
 * `listHistory` already returns newest first, and it already filters nothing:
 * the cap is applied at the WRITE, in `history.ts`, so what is here is exactly
 * what the device kept.
 *
 * One `now` for the whole page, taken here rather than during render, so every
 * row is measured against the same instant.
 */
export async function clientLoader() {
  const entries = await listHistory();
  return { entries, nowMs: Date.now() };
}

/** The device answers in a frame or two, so the wait is a shape, not a spinner. */
export function HydrateFallback() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

const INTENT = { CLEAR: 'clear' } as const;

const historyFormSchema = z.object({ intent: z.literal(INTENT.CLEAR) });

/**
 * Drops the whole log. A HARD delete, unlike every other delete in this layer:
 * there is no peer to converge with, so there is nothing for a tombstone to
 * tell. "Clear" here means cleared.
 */
export async function clientAction({ request }: Route.ClientActionArgs) {
  const parsed = historyFormSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return { success: false, error: 'invalid-form' };
  await clearHistory();
  return { success: true };
}

/**
 * The units a relative timestamp may be expressed in, coarsest last.
 *
 * `amount` is how many of this unit make up the next one, so the loop below
 * divides its way up the scale and stops at the first unit the age fits inside.
 */
const TIME_DIVISIONS = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
] as const satisfies readonly { amount: number; unit: Intl.RelativeTimeFormatUnit }[];

/** "3 minutes ago" in the reader's language, which is what `Intl` is for. */
function formatRelativeTime(atMs: number, nowMs: number, language: string): string {
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  let duration = (atMs - nowMs) / 1000;
  for (const division of TIME_DIVISIONS) {
    if (Math.abs(duration) < division.amount) return formatter.format(Math.round(duration), division.unit);
    duration /= division.amount;
  }
  return formatter.format(Math.round(duration), 'year');
}

/** The URL that re-runs this search, direction included so the repeat is the same search. */
function repeatSearchHref(entry: { query: string; from: string; to: string }): string {
  const params = new URLSearchParams({ q: entry.query, from: entry.from, to: entry.to });
  return `/search?${params.toString()}`;
}

interface HistoryEntryView {
  id: string;
  query: string;
  from: string;
  to: string;
  at: number;
}

function HistoryRow({ entry, nowMs }: { entry: HistoryEntryView; nowMs: number }) {
  const { t, i18n } = useTranslation();

  return (
    <li className="border-b last:border-b-0">
      <Link
        to={repeatSearchHref(entry)}
        aria-label={t('history.repeat', { query: entry.query })}
        className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-primary/5 hover:text-primary"
      >
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{entry.query}</span>
        <time dateTime={new Date(entry.at).toISOString()} className="text-xs text-muted-foreground tabular-nums">
          {formatRelativeTime(entry.at, nowMs, i18n.language)}
        </time>
      </Link>
    </li>
  );
}

export default function HistoryRoute({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { entries, nowMs } = loaderData;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      {entries.length === 0 && (
        <div className="surface-brand-soft rounded-xl border border-dashed p-6">
          <h2 className="font-display text-base font-semibold">{t('history.emptyTitle')}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t('history.emptyBody')}</p>
        </div>
      )}

      {entries.length > 0 && (
        <div className="flex flex-col gap-3">
          {/* History is chronological and repetitive, so it is set quieter than
              a list: no card and no shadow, just rows separated by a hairline. */}
          <ul>
            {entries.map((entry) => (
              <HistoryRow key={entry.id} entry={entry} nowMs={nowMs} />
            ))}
          </ul>
          {/* THE CAP IS STATED, NOT HIDDEN. The log truncates itself on every
              write, and a reader who is never told that is left to notice their
              own searches going missing. */}
          <p className="px-3 text-xs text-muted-foreground">{t('history.capNote')}</p>
          <div className="px-3">
            <ConfirmAction
              trigger={
                <Button type="button" variant="outline" size="sm">
                  {t('history.clear')}
                </Button>
              }
              title={t('history.clearTitle')}
              description={t('history.clearBody')}
              confirmText={t('history.clearConfirm')}
              confirmPendingText={t('history.clearPending')}
              cancelText={t('lists.deleteCancel')}
              confirmVariant="destructive"
              formData={{ intent: INTENT.CLEAR }}
              // `onSuccess` runs on the action's own answer, so a clear that
              // failed says nothing rather than claiming an empty log.
              onSuccess={() => toast.success(t('history.clearedToast'))}
            />
          </div>
        </div>
      )}
    </div>
  );
}
