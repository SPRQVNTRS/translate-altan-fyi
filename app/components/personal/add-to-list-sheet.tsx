import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '#app/components/ui/button';
import { Input } from '#app/components/ui/input';
import { Label } from '#app/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '#app/components/ui/sheet';
import { listLocalListItems, listLocalLists, putLocalList, putLocalListItem } from '#app/lib/local-store';
import type { LocalList } from '#app/lib/local-store';
import { reportError } from '#app/lib/report-error';

/** The save that is in flight, if any: into a list that exists, or into one being made now. */
type RunningSaveKind = 'existing' | 'new';
type SaveKind = 'idle' | RunningSaveKind;

export interface AddToListSheetProps {
  headwordId: string;
  lemma: string;
  /** The sense the reader picked, or null when the word has exactly one and there was nothing to pick. */
  senseId: string | null;
  /** The translation as it reads right now, stored as a snapshot. */
  translationSnapshot: string;
  /**
   * How many senses the word has.
   *
   * The props above cannot tell "one sense, so there was nothing to pick" apart
   * from "several senses and the reader has not picked yet": `senseId` is null
   * in both. Only the second is a reason to block the save, so the count is
   * passed rather than guessed.
   */
  senseCount: number;
}

/**
 * Saves one word, at one meaning, into a vocabulary list on this device.
 *
 * THE TRIGGER IS BLOCKED UNTIL A MEANING IS CHOSEN. `sense-tabs.tsx` explains
 * why a dictionary must not select a meaning on the reader's behalf: the first
 * sense is not the likeliest, it is just the first, and showing it confidently
 * is the worst thing a dictionary can do. Saving one into a study list is that
 * same defect made durable, so the button gives the reason instead.
 *
 * THE LISTS ARE READ WHEN THE SHEET OPENS, not when the page mounts. A list
 * created on `/lists` a moment ago must be here, and a component that read
 * IndexedDB once at mount would show a stale set. Reading on open also keeps
 * the device untouched during the server render, which has no IndexedDB at all.
 */
export function AddToListSheet({ headwordId, lemma, senseId, translationSnapshot, senseCount }: AddToListSheetProps) {
  const { t } = useTranslation();
  const groupId = useId();
  const newListFieldId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [lists, setLists] = useState<LocalList[]>([]);
  const [selectedListId, setSelectedListId] = useState<string | null>(null);
  const [newListName, setNewListName] = useState('');
  // WHICH SAVE IS RUNNING, not merely that one is. Both buttons carry a
  // progressive label, and the two labels say different things, so a plain
  // boolean would make the idle button narrate the other button's work.
  const [saving, setSaving] = useState<SaveKind>('idle');
  const isSaving = saving !== 'idle';

  const isBlocked = senseCount > 1 && senseId === null;

  const handleOpenChange = (open: boolean): void => {
    setIsOpen(open);
    if (!open) return;

    const loadLists = async (): Promise<void> => {
      try {
        setLists(await listLocalLists());
      } catch (cause) {
        reportError(cause, { scope: 'add-to-list-open' });
      }
    };

    void loadLists();
  };

  /**
   * Writes the entry, unless the same word at the same meaning is already in
   * that list.
   *
   * THE DUPLICATE CHECK IS ON THE TRIPLE, NOT ON THE HEADWORD. Two senses of
   * one word are two different things to learn, and collapsing them would
   * quietly refuse the second one.
   *
   * `translationSnapshot` is a SNAPSHOT, and stays one: the entry records the
   * translation as it read when the reader chose to learn it. Re-enrichment may
   * improve the dictionary later, and it must not silently rewrite somebody's
   * study material underneath them.
   */
  const saveTo = async (list: LocalList): Promise<void> => {
    const items = await listLocalListItems();
    const isAlreadySaved = items.some(
      (item) => item.listId === list.id && item.headwordId === headwordId && item.senseId === senseId,
    );
    if (isAlreadySaved) {
      toast.info(t('addToList.alreadySaved'));
      return;
    }
    await putLocalListItem({
      id: crypto.randomUUID(),
      listId: list.id,
      headwordId,
      senseId,
      lemma,
      translationSnapshot,
      note: '',
    });
    toast.success(t('addToList.saved', { list: list.name }));
  };

  const runSave = (kind: RunningSaveKind, resolveList: () => Promise<LocalList | null>): void => {
    if (isSaving) return;
    setSaving(kind);

    const save = async (): Promise<void> => {
      try {
        const list = await resolveList();
        if (list === null) return;
        await saveTo(list);
        setIsOpen(false);
        setNewListName('');
      } catch (cause) {
        reportError(cause, { scope: 'add-to-list-save' });
      } finally {
        setSaving('idle');
      }
    };

    void save();
  };

  const handleSaveToExisting = (): void => {
    runSave('existing', async () => lists.find((list) => list.id === selectedListId) ?? null);
  };

  const handleCreateAndSave = (): void => {
    const name = newListName.trim();
    if (name === '') return;
    runSave('new', async () =>
      putLocalList({
        id: crypto.randomUUID(),
        name,
        // No language pair is known here yet. It will come from the search
        // direction that led to this entry once that is threaded through, and
        // an empty string is the honest placeholder until then. A language
        // picker on a save sheet would be a question nobody asked.
        languagePair: '',
      }),
    );
  };

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>
        <Button type="button" variant="outline" disabled={isBlocked} title={isBlocked ? t('entry.pickSense') : ''}>
          {t('addToList.trigger')}
        </Button>
      </SheetTrigger>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>{t('addToList.title')}</SheetTitle>
          <SheetDescription>{t('addToList.description')}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-6 overflow-y-auto px-4 pb-4">
          {lists.length > 0 && (
            <div className="flex flex-col gap-2">
              <p id={groupId} className="text-sm font-medium">
                {t('addToList.pickLabel')}
              </p>
              <div role="radiogroup" aria-labelledby={groupId} className="flex flex-col">
                {lists.map((list) => (
                  <label
                    key={list.id}
                    className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-primary/5"
                  >
                    <input
                      type="radio"
                      name="listId"
                      value={list.id}
                      checked={selectedListId === list.id}
                      onChange={() => setSelectedListId(list.id)}
                      className="accent-primary"
                    />
                    <span className="text-sm font-medium">{list.name}</span>
                  </label>
                ))}
              </div>
              <Button
                type="button"
                className="mt-2 self-start"
                disabled={selectedListId === null || isSaving}
                onClick={handleSaveToExisting}
              >
                {isSaving && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
                {saving === 'existing' ? t('addToList.savePending') : t('addToList.trigger')}
              </Button>
            </div>
          )}

          <div className="flex flex-col gap-2 border-t pt-6">
            <Label htmlFor={newListFieldId}>{t('addToList.newListLabel')}</Label>
            <Input
              id={newListFieldId}
              value={newListName}
              placeholder={t('addToList.newListPlaceholder')}
              autoComplete="off"
              onChange={(event) => setNewListName(event.target.value)}
            />
            <Button
              type="button"
              className="mt-2 self-start"
              disabled={newListName.trim() === '' || isSaving}
              onClick={handleCreateAndSave}
            >
              {isSaving && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              {saving === 'new' ? t('addToList.createPending') : t('addToList.create')}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
