import type { Route } from './+types/lists.$listId';
import { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFetcher } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { Link } from '#app/components/link';
import { Button } from '#app/components/ui/button';
import { Skeleton } from '#app/components/ui/skeleton';
import { deleteLocalListItem, getLocalList, listLocalListItems } from '#app/lib/local-store';

/**
 * One vocabulary list and the words saved into it.
 *
 * A CLIENT LOADER, LIKE `/lists` ITSELF. The list is a row in this browser's
 * IndexedDB, so there is nothing for a server to read and nothing an account
 * would unlock. The service worker does not precache this URL, so a hard reload
 * here with the network down lands on `/offline`; the in-app navigation from
 * `/lists`, which is how a reader actually gets here, works offline.
 *
 * AN ID THIS DEVICE DOES NOT HOLD IS AN ORDINARY MISS, NOT AN ERROR. A list id
 * typed into the URL bar, or opened on a second device that has not synced, is
 * a URL that resolves to nothing here and to something real elsewhere. It
 * renders a warm page at HTTP 200 with a way back, and never throws a 404.
 */
export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  const list = await getLocalList(params.listId);
  if (list === null) return { list: null, items: [] };

  // `listLocalListItems` already filters tombstones out, so a removed word
  // cannot come back through this read.
  const items = (await listLocalListItems())
    .filter((item) => item.listId === list.id)
    .map((item) => ({
      id: item.id,
      lemma: item.lemma,
      translationSnapshot: item.translationSnapshot,
      note: item.note,
    }));

  return { list: { id: list.id, name: list.name }, items };
}

/** The device answers in a frame or two, so the wait is a shape, not a spinner. */
export function HydrateFallback() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

const INTENT = { REMOVE: 'remove' } as const;

const detailFormSchema = z.object({
  intent: z.literal(INTENT.REMOVE),
  id: z.string().min(1),
});

/**
 * Removes one word from the list.
 *
 * SOFT, like every delete in this layer: the row keeps its id and flips
 * `deleted`, so the removal can be pushed to another device. A hard delete
 * would let a peer that still holds the live row resurrect the word on the next
 * pull.
 */
export async function clientAction({ request }: Route.ClientActionArgs) {
  const parsed = detailFormSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return { success: false, error: 'invalid-form' };
  await deleteLocalListItem(parsed.data.id);
  return { success: true };
}

function RemoveItemForm({ itemId }: { itemId: string }) {
  const { t } = useTranslation();
  const fetcher = useFetcher<typeof clientAction>();
  const isSubmitting = fetcher.state !== 'idle';

  // THE CONFIRMATION WAITS FOR THE WRITE, so a removal that failed leaves the
  // word on screen and says nothing, rather than reporting it gone. Each answer
  // is confirmed once: a language change hands back a new `t`.
  const confirmed = useRef<object | null>(null);
  useEffect(() => {
    if (fetcher.data?.success !== true || confirmed.current === fetcher.data) return;
    confirmed.current = fetcher.data;
    toast.success(t('lists.removedItemToast'));
  }, [fetcher.data, t]);

  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value={INTENT.REMOVE} />
      <input type="hidden" name="id" value={itemId} />
      <Button type="submit" variant="ghost" size="sm" disabled={isSubmitting}>
        {isSubmitting && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
        {isSubmitting ? t('lists.removeItemPending') : t('lists.removeItem')}
      </Button>
    </fetcher.Form>
  );
}

interface ListItemView {
  id: string;
  lemma: string;
  translationSnapshot: string;
  note: string;
}

function ItemRow({ item }: { item: ListItemView }) {
  const { t } = useTranslation();

  return (
    <li className="border-b last:border-b-0">
      <div className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-primary/5">
        <div className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{item.lemma}</span>
          <span className="block truncate text-sm text-muted-foreground">{item.translationSnapshot}</span>
        </div>
        <RemoveItemForm itemId={item.id} />
      </div>
      {item.note !== '' && (
        <p className="px-3 pb-2 text-xs text-muted-foreground">
          <span className="font-medium">{t('lists.itemNoteLabel')}</span> {item.note}
        </p>
      )}
    </li>
  );
}

export default function ListDetailRoute({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { list, items } = loaderData;

  if (list === null) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <p className="text-sm text-muted-foreground">{t('lists.detailNotFound')}</p>
        <Link to="/lists" className="text-sm text-primary hover:underline">
          {t('lists.detailBack')}
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-base font-semibold">{list.name}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {t('lists.itemCount', { count: items.length })}
        </span>
      </div>

      {items.length === 0 && (
        <div className="surface-brand-soft rounded-xl border border-dashed p-6">
          <h3 className="font-display text-base font-semibold">{t('lists.detailEmptyTitle')}</h3>
          <p className="mt-2 text-sm text-muted-foreground">{t('lists.detailEmptyBody')}</p>
        </div>
      )}

      {items.length > 0 && (
        <ul className="rounded-lg border bg-card">
          {items.map((item) => (
            <ItemRow key={item.id} item={item} />
          ))}
        </ul>
      )}

      <Link to="/lists" className="text-sm text-primary hover:underline">
        {t('lists.detailBack')}
      </Link>
    </div>
  );
}
