import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFetcher } from 'react-router';
import { TranslationVotes } from '#app/components/translation-votes';
import { Button } from '#app/components/ui/button';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { TranslationPanel, TranslationRefusal, TranslationRow } from '#app/lib/translation/panel.server';
import {
  initialTranslationPaneState,
  isTranslationPanePolling,
  translationPaneReducer,
  translationPaneRows,
  translationPaneText,
  translationPaneView,
  TRANSLATION_POLL_INTERVAL_MS,
  type TranslationPaneState,
  type TranslationPaneView,
} from '#app/lib/translation/pane-state';

/**
 * What the search pane says about the translation of the word that was typed.
 *
 * ONE STATE MACHINE, ONE STATE VALUE (M193, counsel adjustment J). Every branch
 * below is reached from `translationPaneView`, a single value, and there is no
 * second flag beside it. The inline `EnrichmentSection` under this pane is a
 * different component with its own state, and the two never share a value even
 * though both poll.
 *
 * THE STATE MACHINE ITSELF IS NOT IN THIS FILE. It is four pure transitions in
 * `#app/lib/translation/pane-state`, so it can be tested without a DOM. What is
 * here is the wiring: an interval, a fetch, a retry submission, and the markup.
 *
 * IT NEVER STARTS WORK. The poll is a GET against a route that cannot enqueue,
 * and the ONE thing here that can spend money is the retry button, which is an
 * explicit press by a signed-in reader against a gated POST.
 *
 * NAVIGATING AWAY AND BACK RESUMES FROM THE LOADER. There is no client memory of
 * "I was polling this": a new search re-seeds this pane from the loader's panel,
 * which reports whatever the run actually did while the reader was away.
 */

/** The house recipe for a quiet line inside the answer card. */
const QUIET_LINE = 'text-sm text-muted-foreground';

export interface TranslationPaneController {
  /** The one value the pane renders from. */
  view: TranslationPaneView;
  /** The rows to list. Empty for every view but `ready`. */
  rows: TranslationRow[];
  /** The answer as one string, for the copy button above. Empty when there is no answer. */
  text: string;
  /** Ask the server to try again. Only ever called from the `failed` view. */
  retry: () => void;
  /** Whether a retry is in flight, so the button can say so and refuse a second press. */
  isRetrying: boolean;
  /**
   * Which guard produced a `budget` view, or `null` on every other view.
   *
   * IT IS READ HERE, FROM THE HELD PANEL, RATHER THAN FROM `pane-state.ts`.
   * `translationPaneView` collapses the three refusals to one view on purpose,
   * because the pane shows one line for all of them and the reducer has no
   * business knowing which locale key that line is. The rate-limit refusal is
   * the one exception: it is a different sentence, not a different layout, so
   * this field carries just enough of the panel back out for the render below
   * to choose it.
   */
  refusalReason: TranslationRefusal | null;
}

export interface UseTranslationPaneParams {
  /** The loader's answer. `null` on the branches that have no single word to translate. */
  panel: TranslationPanel | null;
  /** The word being translated, or `null` when the query matched nothing. */
  headwordId: string | null;
  to: LanguageCode;
}

/** The panel a branch with no word to translate renders. */
const NO_ENTRY_PANEL: TranslationPanel = { state: 'no-entry' };

/**
 * The pane's whole behaviour, as a hook, so the card around it can put the copy
 * button on the same answer this pane is showing.
 *
 * WHY THE CONTROLLER IS LIFTED OUT OF THE COMPONENT. The copy button lives in
 * the result card's header, above this pane, and it has to copy the words the
 * pane is CURRENTLY showing, which after a successful poll is not what the
 * loader sent. Reading the answer twice, once for the button and once for the
 * list, is how the two come to disagree.
 */
export function useTranslationPane({ panel, headwordId, to }: UseTranslationPaneParams): TranslationPaneController {
  const loaded = panel ?? NO_ENTRY_PANEL;
  const [state, setState] = useState<TranslationPaneState>(() => initialTranslationPaneState(loaded));

  // RE-SEEDING ON A NEW ANSWER, IN RENDER RATHER THAN IN AN EFFECT. A search for
  // another word arrives as new props on the same component, and an effect that
  // corrected the state afterwards would render one frame of the previous word's
  // answer under the new word. The key deliberately includes the loader panel's
  // STATE and not the panel object, which is a fresh object on every navigation:
  // keying on identity would throw away a poll result the moment anything else
  // on the page re-rendered.
  const seed = `${headwordId ?? ''}:${to}:${loaded.state}`;
  const [seededFrom, setSeededFrom] = useState(seed);
  if (seededFrom !== seed) {
    setSeededFrom(seed);
    setState(initialTranslationPaneState(loaded));
  }

  const isPolling = isTranslationPanePolling(state) && headwordId !== null;
  const pollUrl = headwordId === null ? null : `/api/translation/${headwordId}?to=${to}`;

  // ONE INTERVAL, NEVER TWO. The effect depends on a BOOLEAN, not on the elapsed
  // count, so a tick does not tear the interval down and start a fresh one,
  // which would reset the three seconds every time and fire nothing. The boolean
  // flips exactly twice, on and off, and the cleanup runs on the off.
  useEffect(() => {
    if (!isPolling || pollUrl === null) return;
    const aborter = new AbortController();

    const timer = setInterval(() => {
      setState((previous) => translationPaneReducer(previous, { type: 'tick' }));
      const ask = async (): Promise<void> => {
        const response = await fetch(pollUrl, { signal: aborter.signal, headers: { accept: 'application/json' } });
        // A NON-2XX IS NOT A STATE TRANSITION. It is "ask again next tick": a
        // proxy hiccup or a restarting server must never be rendered to a reader
        // as a failed translation, because the run behind it may be running
        // perfectly well.
        if (!response.ok) throw new Error(`translation poll answered ${response.status}`);
        // SAFETY: the body is whatever `routes/api.translation.$headwordId.ts`
        // serialised, which is a `TranslationPanel` on every path through that
        // loader, including its two unknown-id exits. The reducer below reads
        // one field, `state`, and refuses anything that is not one of the three
        // terminal values, so a body that somehow did not come from that route
        // changes nothing rather than rendering a state the pane cannot draw.
        const polled = (await response.json()) as TranslationPanel;
        setState((previous) => translationPaneReducer(previous, { type: 'polled', panel: polled }));
      };
      void ask().catch(() => {
        setState((previous) => translationPaneReducer(previous, { type: 'poll-failed' }));
      });
    }, TRANSLATION_POLL_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      aborter.abort();
    };
  }, [isPolling, pollUrl]);

  const fetcher = useFetcher<TranslationPanel>();
  const answered = fetcher.data;
  useEffect(() => {
    if (answered === undefined) return;
    setState((previous) => translationPaneReducer(previous, { type: 'adopted', panel: answered }));
  }, [answered]);

  const retry = (): void => {
    if (headwordId === null) return;
    void fetcher.submit(null, { method: 'post', action: `/api/translation/${headwordId}/retry?to=${to}` });
  };

  return {
    view: translationPaneView(state),
    rows: translationPaneRows(state),
    text: translationPaneText(state),
    retry,
    isRetrying: fetcher.state !== 'idle',
    refusalReason: state.panel.state === 'budget' ? state.panel.reason : null,
  };
}

/**
 * The locale key one `budget` view renders.
 *
 * A PURE MAP, so the choice can be asserted without a DOM: this repo has none,
 * and `tests/unit/translation-pane-state.test.ts` calls this function directly
 * rather than rendering the pane to read its text. `rate-limited` is the one
 * refusal with its own sentence: `enrichment.rateLimited` says to wait a few
 * minutes, which is true of that guard alone. `budget` and `daily-cap` both
 * mean nothing more is coming today, so both keep `translation.budget`.
 *
 * @param reason Which guard produced the refusal, or `null` on a view this
 *   function is never called for.
 */
export function translationBudgetKey(reason: TranslationRefusal | null): string {
  return reason === 'rate-limited' ? 'enrichment.rateLimited' : 'translation.budget';
}

/**
 * The "Generated" marker, which explains itself.
 *
 * A BARE LABEL IS NOT A DISCLOSURE. A reader meeting the word "Generated" cold
 * has no way to know whether it means "computed", "recent" or "unreliable", so
 * the marker carries the sentence with it: `title` for a pointer, and a press
 * that reveals the same line for a touch screen, which has no hover at all.
 */
function GeneratedMarker() {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const hint = t('translation.generatedHint');

  return (
    <>
      <button
        type="button"
        title={hint}
        aria-expanded={isOpen}
        onClick={() => setIsOpen((previous) => !previous)}
        className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
      >
        {t('translation.generated')}
      </button>
      {isOpen && <p className={`mt-1 basis-full ${QUIET_LINE}`}>{hint}</p>}
    </>
  );
}

/**
 * One translation: the word, its part of speech, the marker when a model wrote
 * it, and the two buttons that say whether it is right.
 *
 * THE VOTE IS ON THIS ROW AND NOT ON THE CARD. The reader is looking at several
 * words for one query, and only they know which of them is wrong. A single
 * control over the whole answer would collect a judgement nobody could act on.
 */
function TranslationLine({ row, to }: { row: TranslationRow; to: LanguageCode }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      {/* Monospaced, like every other word under examination on this screen.
          The part of speech beside it is prose about the word, so it is not. */}
      <span lang={to} className="font-mono text-xl">
        {row.lemma}
      </span>
      {row.pos !== null && <span className="text-xs text-muted-foreground">{row.pos}</span>}
      {row.generated && <GeneratedMarker />}
      <TranslationVotes translationId={row.translationId} up={row.up} down={row.down} myVote={row.myVote} />
    </li>
  );
}

export interface TranslationPaneProps {
  controller: TranslationPaneController;
  to: LanguageCode;
}

/**
 * The pane itself: one switch over one value.
 *
 * `stalled` IS NOT `failed`, AND THE COPY SAYS SO. The run may still be
 * finishing, so the line asks the reader to come back rather than announcing a
 * failure this screen cannot see. Only a run row that reads failed produces the
 * failure line and the retry button.
 */
export function TranslationPane({ controller, to }: TranslationPaneProps) {
  const { t } = useTranslation();
  const { view, rows } = controller;

  if (view === 'ready') {
    return (
      <ul className="mt-2 flex flex-col gap-2">
        {rows.map((row) => (
          <TranslationLine key={row.translationId} row={row} to={to} />
        ))}
      </ul>
    );
  }

  if (view === 'translating') {
    return (
      <p className={`mt-2 flex items-center gap-2 ${QUIET_LINE}`}>
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t('translation.translating')}
      </p>
    );
  }

  if (view === 'stalled') {
    return <p className={`mt-2 ${QUIET_LINE}`}>{t('translation.stillWorking')}</p>;
  }

  if (view === 'failed') {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <p className={QUIET_LINE}>{t('translation.failed')}</p>
        <Button type="button" variant="outline" size="sm" onClick={controller.retry} disabled={controller.isRetrying}>
          {t('translation.retry')}
        </Button>
      </div>
    );
  }

  if (view === 'budget') {
    return <p className={`mt-2 ${QUIET_LINE}`}>{t(translationBudgetKey(controller.refusalReason))}</p>;
  }

  return <p className={`mt-2 ${QUIET_LINE}`}>{t('translation.noEntry')}</p>;
}
