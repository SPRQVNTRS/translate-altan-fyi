import { useRef, type KeyboardEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Form, useNavigation } from 'react-router';
import { DirectionChip } from '#app/components/direction-chip';
import { EnrichmentSection } from '#app/components/enrichment-section';
import { DidYouMean, PhraseResults, SearchResults } from '#app/components/search-results';
import { Button } from '#app/components/ui/button';
import { Textarea } from '#app/components/ui/textarea';
import { VoiceInput } from '#app/components/voice-input';
import type { Direction } from '#app/lib/dictionary/detect-language';
import type { PhraseSearchResult, SearchHit } from '#app/lib/dictionary/search.server';
import type { EnrichmentPanel } from '#app/lib/enrichment/state.server';

/** One rendered state of the translator surface, exactly as the loader answers it. */
export interface SearchPanesProps {
  q: string;
  direction: Direction;
  hits: SearchHit[];
  phrase: PhraseSearchResult | null;
  didYouMean: string | null;
  /** How many words of a phrase the search never looked at. Zero on every other branch. */
  phraseWordsOmitted: number;
  panel: EnrichmentPanel | null;
}

/**
 * The translator surface itself: something to type into on one side, what came
 * back on the other.
 *
 * TWO PANES, ONE FORM. The input pane is the `<textarea>` and its controls; the
 * output pane is the region the answer renders in. They are two cells of one
 * grid, side by side from `md` up and stacked below it, which is the SAME
 * breakpoint `AppWrapper` switches the sidebar and the drawer on. A second
 * breakpoint scheme would let the panes split while the chrome had not, which
 * is the one arrangement neither layout was designed for.
 *
 * THE INPUT PANE CARRIES `.surface-brand`, and it is the only thing on this
 * screen allowed to. That is a design rule, and it is inherited from the hero
 * card the input pane replaces: the output pane must not carry it, and nor may
 * anything else here.
 *
 * THE OUTPUT PANE HAS NO CARD OF ITS OWN. `SearchResults` and `PhraseResults`
 * already render cards, and a card holding cards is a frame around a frame. The
 * pane is a plain column, so with nothing searched it is simply empty rather
 * than an empty box explaining its own emptiness.
 *
 * IT IS PURE OVER ITS PROPS, AND IT IS A COMPONENT RATHER THAN ROUTE MARKUP FOR
 * ONE REASON. The search route is gated: any non-empty `q` needs an account, so
 * the only way to render an answered surface without a session is to hand it
 * the answer directly. M186's palette review page did that, and it rendered
 * THIS component, so what the operator judged was the surface the product
 * actually ships rather than a copy of it that could drift. The review page has
 * been deleted now that the decision is applied. The seam stays: it is what any
 * future sessionless render of this surface would use.
 */
export function SearchPanes({ q, direction, hits, phrase, didYouMean, phraseWordsOmitted, panel }: SearchPanesProps) {
  const { t } = useTranslation();
  // The word the inline panel belongs to. It is read once here rather than as
  // `hits[0]` at the render site, so the panel and the id it polls with cannot
  // be taken from two different reads of the same array.
  const topHit = hits[0];
  const navigation = useNavigation();
  const isSearching = navigation.state !== 'idle';
  // The voice control writes into THIS box and submits THIS form. It owns no
  // query state of its own, so a spoken word and a typed one reach the loader
  // by exactly the same route. The box is a `<textarea>` now, which is why
  // `VoiceInput` takes a sink rather than an `HTMLInputElement`: see its props.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // A detected direction is a guess, so it is NOT pinned into the next
  // submission: retyping should let the guess change. A direction the reader
  // chose by flipping the chip IS pinned, because they asked for it.
  const isDirectionPinned = !direction.detected;

  // ENTER STILL SEARCHES. A `<textarea>` takes Enter as a newline, so the box
  // that used to submit on Enter would silently stop doing it. Shift keeps the
  // newline, which is the convention every message box uses, and the submit
  // goes through `requestSubmit` on the same form the button and the voice
  // control use, so there is still exactly one way a query leaves this screen.
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    formRef.current?.requestSubmit();
  };

  return (
    <div className="grid items-start gap-6 md:grid-cols-2">
      <div className="surface-brand rounded-2xl border p-5">
        {/* GET, so the query lands in the URL and the results page is a place
            rather than the outcome of a POST nobody can link to. A textarea
            submits through GET exactly as the single-line box did: its whole
            value, newlines included, goes into `?q=`. */}
        <Form method="get" ref={formRef}>
          <label htmlFor="search-word" className="text-sm font-medium">
            {t('search.fieldLabel')}
          </label>
          <Textarea
            ref={inputRef}
            id="search-word"
            name="q"
            rows={4}
            defaultValue={q}
            placeholder={t('search.placeholder')}
            autoComplete="off"
            className="mt-2"
            onKeyDown={handleKeyDown}
          />
          {isDirectionPinned && (
            <>
              <input type="hidden" name="from" value={direction.from} />
              <input type="hidden" name="to" value={direction.to} />
            </>
          )}
          {/* The button sits under the box rather than beside it, because
              beside it is where the box now goes: a pane-wide textarea has no
              room for a control on the same line at mobile widths. The label
              changes with the state, it does not just gain a spinner. A
              button that still reads "Search" while a search runs is telling
              the reader nothing happened. */}
          <div className="mt-3 flex justify-end">
            <Button type="submit" disabled={isSearching}>
              {isSearching && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              {isSearching ? t('search.submitting') : t('search.submit')}
            </Button>
          </div>
          <VoiceInput className="mt-3" inputRef={inputRef} formRef={formRef} sourceLanguage={direction.from} />
        </Form>
        <p className="mt-3 text-sm text-muted-foreground">{t('search.note')}</p>
      </div>

      {/* THE OUTPUT PANE. What renders inside it is unchanged by this
          relayout: the same results, the same correction, moved from under the
          box to beside it. */}
      <section aria-live="polite" className="flex flex-col gap-4">
        {q !== '' && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-base font-semibold">{t('search.resultsFor', { query: q })}</h2>
              <DirectionChip direction={direction} query={q} />
            </div>
            {/* WHAT THE SEARCH ACTUALLY READ, WHEN IT WAS NOT ALL OF IT.
                `searchPhrase` looks up at most `PHRASE_TOKEN_LIMIT` words, and
                a translator-shaped textarea invites a whole pasted paragraph,
                so the cap that was unreachable under a one-line box is now
                ordinary. Without this line the pane answers seven words of a
                thirty word paste with the confident shape of a full answer,
                and nothing on screen says the other twenty three were never
                looked at. It renders above the word list rather than below it,
                because a caveat under the answer is read after the reader has
                already believed the answer. */}
            {phrase !== null && phraseWordsOmitted > 0 && (
              <p role="note" className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
                {t('search.phraseTruncatedNote', { lookedUp: phrase.tokens.length })}
              </p>
            )}
            {phrase !== null && <PhraseResults phrase={phrase} from={direction.from} to={direction.to} />}
            {phrase === null && hits.length > 0 && <SearchResults hits={hits} to={direction.to} />}
            {phrase === null && hits.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('search.noResults', { query: q })}</p>
            )}
            {/* THE ANSWER, IN THE OUTPUT PANE, FOR THE WORD AT THE TOP.
                A translator's output area is where the interesting part
                belongs, so the top hit's enrichment panel renders here rather
                than only behind a click through to `/entry/:headwordId`. That
                page is unchanged and still linkable: history and lists point
                at it, and it is where the reader goes for a word that is NOT
                the top hit.

                IT IS THE SAME COMPONENT THE ENTRY PAGE RENDERS, fed by the
                same shared state machine. So the honest idle line, which
                distinguishes "no model is connected to this server" from
                "nothing has been asked for yet", is inherited rather than
                rewritten here. Writing a second idle sentence in this pane is
                how a healthy provider key comes to read like a dead one.

                IT BLOCKS NOTHING ABOVE IT. The results, the truncation note
                and the correction are already rendered when this arrives, and
                a pending panel is one card at the foot of the column that
                polls itself to `ready` or `failed`. DESIGN.md rule 3: the
                skeleton has a terminal path, and
                `tests/integration/inline-enrichment-panel-resolves.test.ts`
                drives it. */}
            {panel !== null && topHit !== undefined && (
              <EnrichmentSection panel={panel} headwordId={topHit.headwordId} to={direction.to} />
            )}
            {/* The correction is a link and nothing else. It renders under the
                empty-result message rather than in place of it, so the reader
                can see that their own spelling found nothing before they are
                offered another one. */}
            {didYouMean !== null && <DidYouMean suggestion={didYouMean} from={direction.from} to={direction.to} />}
          </>
        )}
      </section>
    </div>
  );
}
