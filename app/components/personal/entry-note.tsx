import { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '#app/components/ui/button';
import { Label } from '#app/components/ui/label';
import { listLocalNotes, putLocalNote } from '#app/lib/local-store';
import { reportError } from '#app/lib/report-error';
import { cn } from '#app/lib/utils';

export interface EntryNoteProps {
  headwordId: string;
}

/**
 * The reader's private note on one word.
 *
 * THE NOTE IS READ ON THE CLIENT, NEVER IN A LOADER. It lives in IndexedDB, so
 * the server has no way to render it and no business knowing it exists. The
 * control renders empty and disabled until the device answers, which is one
 * frame on a warm store.
 *
 * THE NOTE'S ID IS REUSED ACROSS EDITS. There is one note per headword, so a
 * second save must update the row the first save wrote. Minting a fresh id on
 * every save would leave a pile of notes for one word, all but one of them
 * invisible, and push every one of them through sync forever.
 */
export function EntryNote({ headwordId }: EntryNoteProps) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [noteId, setNoteId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    // A late answer for a headword the reader has already navigated away from
    // must not overwrite the note now on screen.
    let isCurrent = true;
    setIsLoaded(false);

    const load = async (): Promise<void> => {
      try {
        const notes = await listLocalNotes();
        if (!isCurrent) return;
        const existing = notes.find((note) => note.headwordId === headwordId);
        setNoteId(existing?.id ?? null);
        setText(existing?.text ?? '');
      } catch (cause) {
        reportError(cause, { scope: 'entry-note-load' });
      }
      // The control is enabled either way: a device that cannot be read is
      // still a device that can be written to, and locking the field would
      // take the feature away over a read that may have failed once.
      if (isCurrent) setIsLoaded(true);
    };

    void load();
    return () => {
      isCurrent = false;
    };
  }, [headwordId]);

  const handleSave = (): void => {
    if (isSaving) return;
    setIsSaving(true);
    const id = noteId ?? crypto.randomUUID();

    const save = async (): Promise<void> => {
      try {
        await putLocalNote({ id, headwordId, text });
        setNoteId(id);
        toast.success(t('entry.noteSaved'));
      } catch (cause) {
        reportError(cause, { scope: 'entry-note-save' });
      } finally {
        setIsSaving(false);
      }
    };

    void save();
  };

  return (
    <section className="rounded-lg border bg-card p-4">
      <Label htmlFor={fieldId} className="text-[11px] font-semibold uppercase tracking-[0.11em] text-primary">
        {t('entry.noteLabel')}
      </Label>
      <textarea
        id={fieldId}
        rows={3}
        value={text}
        disabled={!isLoaded}
        placeholder={t('entry.notePlaceholder')}
        onChange={(event) => setText(event.target.value)}
        className={cn(
          'placeholder:text-muted-foreground border-input dark:bg-input/30 mt-2 w-full min-w-0 rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none md:text-sm',
          'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      />
      <p className="mt-2 text-xs text-muted-foreground">{t('entry.noteHint')}</p>
      <Button type="button" className="mt-3" disabled={!isLoaded || isSaving} onClick={handleSave}>
        {isSaving && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
        {isSaving ? t('entry.notePending') : t('entry.noteSave')}
      </Button>
    </section>
  );
}
