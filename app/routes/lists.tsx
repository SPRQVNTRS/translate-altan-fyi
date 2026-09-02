import type { Route } from './+types/lists';
import { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFetcher, type MetaFunction } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { ConfirmAction } from '#app/components/confirm-action';
import { Link } from '#app/components/link';
import { Button } from '#app/components/ui/button';
import { Input } from '#app/components/ui/input';
import { Label } from '#app/components/ui/label';
import { Skeleton } from '#app/components/ui/skeleton';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import {
  deleteLocalList,
  deleteLocalListItem,
  getLocalList,
  listLocalListItems,
  listLocalLists,
  putLocalList,
} from '#app/lib/local-store';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: metaTitle(language, 'lists.metaTitle') },
    { name: 'description', content: metaTitle(language, 'lists.metaDescription') },
  ];
};

/**
 * The vocabulary lists on THIS DEVICE.
 *
 * THERE IS NO SERVER LOADER HERE, ON PURPOSE. Lists live in IndexedDB, they
 * belong to nobody but this browser profile, and they must be readable with the
 * network off. The service worker deliberately never caches route data, so a
 * screen with a server loader is a screen that is blank offline. It also needs
 * no account: this app is anonymous by default and nothing on this path may ask
 * for one.
 */
export async function clientLoader() {
  const [lists, items] = await Promise.all([listLocalLists(), listLocalListItems()]);
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.listId, (counts.get(item.listId) ?? 0) + 1);
  }
  return {
    lists: lists
      .map((list) => ({ id: list.id, name: list.name, itemCount: counts.get(list.id) ?? 0 }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
  };
}

/** The device answers in a frame or two, so the wait is a shape, not a spinner. */
export function HydrateFallback() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

const INTENT = {
  CREATE: 'create',
  RENAME: 'rename',
  DELETE: 'delete',
} as const;

/**
 * The three mutations, decoded rather than inspected.
 *
 * A blank or whitespace-only name fails `min(1)` AFTER the trim, so it never
 * reaches a write: a nameless list is not a list, and creating one would give
 * the reader a row they cannot identify and cannot easily remove.
 */
const listsFormSchema = z.discriminatedUnion('intent', [
  z.object({ intent: z.literal(INTENT.CREATE), name: z.string().trim().min(1) }),
  z.object({ intent: z.literal(INTENT.RENAME), id: z.string().min(1), name: z.string().trim().min(1) }),
  z.object({ intent: z.literal(INTENT.DELETE), id: z.string().min(1) }),
]);

export async function clientAction({ request }: Route.ClientActionArgs) {
  const parsed = listsFormSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return { success: false, error: 'invalid-form' };
  const form = parsed.data;

  if (form.intent === INTENT.CREATE) {
    await putLocalList({
      id: crypto.randomUUID(),
      name: form.name,
      // No language pair is known on this screen. It will come from the search
      // direction once a list can be created from a result, and an empty string
      // is the honest placeholder until then. A language picker here would be a
      // question nobody asked.
      languagePair: '',
    });
    return { success: true };
  }

  if (form.intent === INTENT.RENAME) {
    const existing = await getLocalList(form.id);
    if (!existing) return { success: false, error: 'not-found' };
    await putLocalList({ id: existing.id, name: form.name, languagePair: existing.languagePair });
    return { success: true };
  }

  // EVERY ITEM OF THE LIST IS TOMBSTONED TOO. `deleteLocalList` is a SOFT
  // delete: the list row survives so the deletion can be pushed to another
  // device. Its items are separate rows with their own stamps, so leaving them
  // live orphans them, they belong to a list that no longer exists, no screen
  // will ever show them, and sync will carry them between devices forever.
  const items = await listLocalListItems();
  for (const item of items) {
    if (item.listId === form.id) await deleteLocalListItem(item.id);
  }
  await deleteLocalList(form.id);
  return { success: true };
}

function CreateListForm() {
  const { t } = useTranslation();
  const fetcher = useFetcher<typeof clientAction>();
  const isSubmitting = fetcher.state !== 'idle';
  // The action answers with success alone, so the name is kept from the submit
  // that asked for it. The confirmation names the list back to the reader, and
  // reading the field at confirmation time would name whatever is in it now.
  const submittedName = useRef('');

  // THE CONFIRMATION WAITS FOR THE WRITE. `fetcher.data` is the result of the
  // mutation, so a failed write leaves the toast unsaid rather than promising
  // a list that was never created. Each answer is confirmed once: a language
  // change hands back a new `t` and re-runs this over the same answer.
  const confirmed = useRef<object | null>(null);
  useEffect(() => {
    if (fetcher.data?.success !== true || confirmed.current === fetcher.data) return;
    confirmed.current = fetcher.data;
    toast.success(t('lists.createdToast', { name: submittedName.current }));
  }, [fetcher.data, t]);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    submittedName.current = new FormData(event.currentTarget).get('name')?.toString().trim() ?? '';
  };

  return (
    <fetcher.Form method="post" className="flex flex-col gap-2" onSubmit={handleSubmit}>
      <input type="hidden" name="intent" value={INTENT.CREATE} />
      <Label htmlFor="new-list-name">{t('lists.createLabel')}</Label>
      <div className="flex gap-2">
        <Input
          id="new-list-name"
          name="name"
          type="text"
          placeholder={t('lists.createPlaceholder')}
          autoComplete="off"
          required
        />
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          {isSubmitting ? t('lists.createPending') : t('lists.createSubmit')}
        </Button>
      </div>
    </fetcher.Form>
  );
}

function RenameListForm({ listId }: { listId: string }) {
  const { t } = useTranslation();
  const fetcher = useFetcher<typeof clientAction>();
  const isSubmitting = fetcher.state !== 'idle';
  const fieldId = `rename-${listId}`;
  const submittedName = useRef('');

  const confirmed = useRef<object | null>(null);
  useEffect(() => {
    if (fetcher.data?.success !== true || confirmed.current === fetcher.data) return;
    confirmed.current = fetcher.data;
    toast.success(t('lists.renamedToast', { name: submittedName.current }));
  }, [fetcher.data, t]);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    submittedName.current = new FormData(event.currentTarget).get('name')?.toString().trim() ?? '';
  };

  return (
    <fetcher.Form method="post" className="flex flex-col gap-2" onSubmit={handleSubmit}>
      <input type="hidden" name="intent" value={INTENT.RENAME} />
      <input type="hidden" name="id" value={listId} />
      <Label htmlFor={fieldId} className="sr-only">
        {t('lists.renameLabel')}
      </Label>
      <div className="flex gap-2">
        <Input id={fieldId} name="name" type="text" placeholder={t('lists.renameLabel')} autoComplete="off" required />
        <Button type="submit" variant="outline" size="sm" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          {isSubmitting ? t('lists.renamePending') : t('lists.renameSubmit')}
        </Button>
      </div>
    </fetcher.Form>
  );
}

function ListRow({ list }: { list: { id: string; name: string; itemCount: number } }) {
  const { t } = useTranslation();

  return (
    <li className="border-b last:border-b-0">
      <div className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-primary/5">
        <Link
          to={`/lists/${list.id}`}
          aria-label={t('lists.openList', { name: list.name })}
          className="min-w-0 flex-1 hover:text-primary"
        >
          <span className="block text-sm font-medium">{list.name}</span>
          <span className="block truncate text-sm text-muted-foreground">
            {t('lists.itemCount', { count: list.itemCount })}
          </span>
        </Link>
        <ConfirmAction
          trigger={
            <Button type="button" variant="ghost" size="sm">
              {t('lists.deleteTrigger')}
            </Button>
          }
          title={t('lists.deleteTitle')}
          description={t('lists.deleteBody')}
          confirmText={t('lists.deleteConfirm')}
          confirmPendingText={t('lists.deletePending')}
          cancelText={t('lists.deleteCancel')}
          confirmVariant="destructive"
          formData={{ intent: INTENT.DELETE, id: list.id }}
          onSuccess={() => toast.success(t('lists.deletedToast'))}
        />
      </div>
      <div className="px-3 pb-3">
        <RenameListForm listId={list.id} />
      </div>
    </li>
  );
}

export default function ListsRoute({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { lists } = loaderData;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <section className="rounded-lg border bg-card p-4">
        <h2 className="font-display text-base font-semibold">{t('lists.title')}</h2>
        <div className="mt-4">
          <CreateListForm />
        </div>
      </section>

      {lists.length === 0 && (
        <div className="surface-brand-soft rounded-xl border border-dashed p-6">
          <h2 className="font-display text-base font-semibold">{t('lists.emptyTitle')}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t('lists.emptyBody')}</p>
        </div>
      )}

      {lists.length > 0 && (
        <ul className="rounded-lg border bg-card">
          {lists.map((list) => (
            <ListRow key={list.id} list={list} />
          ))}
        </ul>
      )}
    </div>
  );
}
