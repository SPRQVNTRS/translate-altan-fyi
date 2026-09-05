import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Form, useNavigation } from 'react-router';
import { EnrichmentSection } from '#app/components/enrichment-section';
import { LanguageBar } from '#app/components/language-bar';
import { FavoriteToggle } from '#app/components/personal/favorite-toggle';
import { DictionaryEntries, DidYouMean, PhraseResults } from '#app/components/search-results';
import { TranslationPane, type TranslationPaneController } from '#app/components/translation-pane';
import { Button } from '#app/components/ui/button';
import { Textarea } from '#app/components/ui/textarea';
import { VoiceInput } from '#app/components/voice-input';
import type { Direction } from '#app/lib/dictionary/detect-language';
import type { LanguagePair } from '#app/lib/dictionary/language-pair';
import type { PhraseSearchResult, SearchHit } from '#app/lib/dictionary/search.server';
import type { EnrichmentPanel } from '#app/lib/enrichment/state.server';

/** One rendered state of the translator surface, exactly as the loader answers it. */
export interface SearchPanesProps {
  q: string;
  direction: Direction;
  /** The language pair the bar is set to, resolved from the URL, then the cookie, then the default. */
  pair: LanguagePair;
  hits: SearchHit[];
  phrase: PhraseSearchResult | null;
  didYouMean: string | null;
  /** How many words of a phrase the search never looked at. Zero on every other branch. */
  phraseWordsOmitted: number;
  panel: EnrichmentPanel | null;
  /**
   * The translation pane's whole behaviour, held by the CALLER (M194/02).
   *
   * IT USED TO BE THE LOADER'S PANEL, and the hook was called here. The route
   * needs the answer too, to hand to the history recorder beside this surface,
   * and a second call to the hook would be a second poll of the same run. So
   * the controller is lifted to the one place that has both consumers, and this
   * component takes it as a prop like everything else it renders.
   *
   * A CALLER WITH NO SESSION CALLS THE HOOK ITSELF and passes what it gets. The
   * hook starts no work: the poll is a GET against a route that cannot enqueue,
   * and a `no-entry` panel polls nothing at all.
   */
  translation: TranslationPaneController;
  /**
   * The word the pane above is about, and the id it polls with.
   *
   * It is chosen by the LOADER, exact lemma preferred over the fuzzy top hit,
   * and carried out rather than recomputed here: the panel and the id must not
   * come from two reads of the same array.
   */
  translationHeadwordId: string | null;
  /**
   * What the result region holds while nothing has been searched for.
   *
   * There is no hole to fill any more, since the column is one card under
   * another, but the worked example is still the only thing on an untouched
   * home screen that shows the dictionary answering. It renders where the
   * result card would be, so a first visit shows the question and an answer in
   * the order a reader will meet them. The caller decides what goes there; this
   * component only decides that it goes THERE rather than under everything.
   */
  emptyPane?: ReactNode;
}

/**
 * The translation of a single word used to be computed here, from the loader's
 * top hit, as `singleWordResult`. It is gone (M193/02).
 *
 * WHY, so nobody reinstates it: it could only ever show rows the LOADER already
 * had, and this screen now starts a run for a word that has none. A helper
 * reading `hits[0].translations` would go on rendering an empty answer while the
 * pane beside it polled a run to completion, and the two would disagree on the
 * same card. The answer comes from the pane's own state instead, through
 * `translationPaneText`.
 */

/**
 * A phrase, word by word: each word's first translation, in the order typed.
 *
 * IT IS NOT A SENTENCE, AND THE SCREEN SAYS SO. This dictionary has no
 * grammar, no word order and no agreement: it can say what each word means and
 * nothing more. A field shaped like a translator's that silently returned this
 * as prose would be a lie about the product, so the note beside it is
 * compulsory rather than decorative.
 *
 * A WORD WITH NO ENTRY KEEPS ITS OWN SPELLING. Dropping it would quietly
 * shorten the reader's sentence and leave nothing on screen saying which word
 * went missing.
 *
 * Pure, and exported, so a test can drive it without a browser.
 */
export function phraseResult(phrase: PhraseSearchResult): string {
  return phrase.tokens
    .map((token) => {
      const hit = token.hits[0];
      if (hit === undefined) return token.token;
      return hit.translations[0]?.lemma ?? hit.gloss ?? token.token;
    })
    .join(' ');
}

/** What the read-only answer field renders. */
interface ResultFieldProps {
  /**
   * The answer as one string, for the copy button. Empty when there is nothing
   * to copy yet, which disables the button.
   */
  text: string;
  /**
   * The card's body, on the word branch: the translation pane, which owns every
   * state a translation can be in and renders the answer itself.
   *
   * `null` on the phrase branch, which has no pane and shows `text` directly.
   * The single empty sentence this replaced is gone from both locale files:
   * "no translation for this yet" described a feature that did not exist, and
   * now that one does, the pane says which of five things is actually true.
   */
  body: ReactNode | null;
  /** The word-by-word caveat, on the phrase branch only. */
  note: string | null;
  /**
   * The star, on the single-word branch only.
   *
   * `null` on the phrase branch, and that is a statement about the product
   * rather than a layout choice: a phrase is not one word, it has no headword,
   * and there is nothing for a favourite to be keyed by. The caller decides
   * whether there is a word to keep; this card only decides where the control
   * sits, which is beside the copy button, because both act on the answer.
   */
  favorite: ReactNode | null;
}

/**
 * The answer, as a read-only card directly under the box it was typed in.
 *
 * IT IS THE HEADLINE, AND THE CARDS BELOW IT ARE THE DETAIL. A translator puts
 * the answer where the eye lands, at the size the question was asked in, and
 * everything the dictionary knows beyond that keeps its place underneath.
 *
 * IT MATCHES THE INPUT CARD EXACTLY. Same rounding, same border, same padding,
 * and neither card carries `.surface-brand` any more. That is the rule now, and
 * it is deliberate rather than an omission: a control and its answer that look
 * alike read as one thing, and tinting only the box a reader types into split
 * the pair into a bright half and a plain half stacked under it.
 *
 * COPYING IS GUARDED, NOT ASSUMED. `navigator.clipboard` is undefined on an
 * insecure origin, which local development over plain HTTP on a phone is, so
 * the button disables itself rather than throwing inside a click handler.
 *
 * THE "COPIED" STATE RESETS BY REMOUNTING. The caller keys this component on
 * the answer, so a new answer is a new component with a fresh state rather
 * than an effect that watches a prop and corrects itself afterwards.
 */
function ResultField({ text, body, note, favorite }: ResultFieldProps) {
  const { t } = useTranslation();
  const [isCopied, setIsCopied] = useState(false);
  const canCopy = text !== '' && globalThis.navigator?.clipboard !== undefined;

  // An inner async function rather than a then-chain: the lint gate's
  // `promise(always-return)` rule refuses a `.then` whose body returns nothing,
  // and a copy button's callback has nothing to return.
  const handleCopy = (): void => {
    if (!canCopy) return;
    const copy = async (): Promise<void> => {
      await navigator.clipboard.writeText(text);
      setIsCopied(true);
    };
    // A refused clipboard, which a browser permission prompt can produce,
    // leaves the answer on screen and the button unchanged. There is nothing to
    // tell the reader that they could not act on themselves.
    void copy().catch(() => undefined);
  };

  return (
    <div className="rounded-2xl border p-5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium">{t('search.resultLabel')}</p>
        <div className="flex items-center gap-1">
          {favorite}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={handleCopy}
            disabled={!canCopy}
            aria-label={isCopied ? t('search.copied') : t('search.copy')}
          >
            {isCopied ?
              <Check className="size-4" aria-hidden="true" />
            : <Copy className="size-4" aria-hidden="true" />}
          </Button>
        </div>
      </div>

      {/* Selectable, at reading size. The answer is the one thing on this
          screen a reader takes away with them, by copy button or by hand. The
          word branch hands its whole body to the pane, which renders the same
          words at the same size and can also say what is happening when there
          are none yet. */}
      {body === null && text !== '' && <p className="mt-2 text-xl">{text}</p>}
      {body}
      {note !== null && <p className="mt-3 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

/**
 * The translator surface itself: something to type into, and what came back
 * directly underneath it.
 *
 * ONE COLUMN AT EVERY WIDTH. The language bar, the input card and the result
 * card are three blocks of one flex column, all exactly as wide as each other.
 * This replaced a two-cell grid that was side by side from `md` up, and the
 * reason is measured rather than aesthetic: the bar was a wrapping flex row
 * over a CSS grid, two layout systems that cannot align their vertical edges,
 * and at 1280px each select sat 14px off the card it belonged to. One column
 * means one layout to get right instead of two, and it is the shape a phone
 * gets anyway.
 *
 * THE LANGUAGE BAR IS INSIDE THE FORM, AND SO IS THE INPUT CARD. The form is an
 * ordinary flex column now: with no grid to span, the `display: contents` trick
 * that used to let the form's children be cells of an outer grid buys nothing
 * and is gone. What matters is unchanged, that the bar's two hidden inputs,
 * `from` and `to`, ride every submission this screen makes, including the voice
 * control's.
 *
 * THE RESULT REGION STAYS OUTSIDE THE FORM. It holds the enrichment panel,
 * whose vote buttons are their own controls; inside a GET form they would
 * submit the search.
 *
 * THE PAIR IS STATED, NEVER PINNED BY A SIDE EFFECT. This surface used to write
 * `from` and `to` into hidden inputs whenever the direction had NOT been
 * detected, which meant one tap on the flip chip pinned that direction into
 * every later submission: a German word typed afterwards was searched on the
 * English side and returned nothing, with nothing on screen saying why. The
 * bar replaces both the chip and that rule.
 *
 * THE TWO CARDS MATCH ON PURPOSE, AND NEITHER CARRIES `.surface-brand`. The
 * input card used to be the one element on this screen allowed that class,
 * inherited from the hero card it replaced. That rule is dead. Both cards are a
 * plain `rounded-2xl border p-5`, because the box and the answer are one
 * control and its reply: a tint on the first of two stacked cards makes them
 * read as two unrelated panels rather than as a question and its answer.
 *
 * THE RESULT REGION IS ONE CARD AND THEN THE DETAIL. The read-only answer card
 * is the headline; `SearchResults`, `PhraseResults`, the enrichment panel and
 * the correction keep their place under it, each already a card of its own. The
 * region itself is a plain column, so a card holding cards never happens.
 *
 * WITH NOTHING SEARCHED THE REGION HOLDS `emptyPane`. The caller supplies the
 * worked example; this component only places it, where the answer card would
 * be, so an untouched home screen still shows the dictionary answering.
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
export function SearchPanes({
  q,
  direction,
  pair,
  hits,
  phrase,
  didYouMean,
  phraseWordsOmitted,
  panel,
  translation,
  translationHeadwordId,
  emptyPane,
}: SearchPanesProps) {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const isSearching = navigation.state !== 'idle';
  // The voice control writes into THIS box and submits THIS form. It owns no
  // query state of its own, so a spoken word and a typed one reach the loader
  // by exactly the same route. The box is a `<textarea>` now, which is why
  // `VoiceInput` takes a sink rather than an `HTMLInputElement`: see its props.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

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

  // THE ANSWER, AS ONE STRING, DECIDED HERE AND NOWHERE ELSE. On the word branch
  // it comes from the pane rather than from the loader's hit, because a poll
  // that has just landed holds words the loader could not have known about, and
  // a copy button offering the older set would quietly hand the reader an answer
  // the screen is not showing.
  const resultText = phrase === null ? translation.text : phraseResult(phrase);

  // THE WORD THE STAR WOULD KEEP, LOOKED UP BY THE LOADER'S OWN CHOICE OF
  // HEADWORD. Reading `hits[0]` instead would be the defect the enrichment
  // panel already learned: the loader prefers the exact lemma match over the
  // fuzzy top hit, so the array's first row is not always the word this card is
  // answering, and a favourite keyed by one word and labelled with another is
  // worse than no star at all.
  const savableHit = hits.find((hit) => hit.headwordId === translationHeadwordId);

  return (
    <div className="flex flex-col gap-4">
      {/* GET, so the query lands in the URL and the results page is a place
          rather than the outcome of a POST nobody can link to. A textarea
          submits through GET exactly as the single-line box did: its whole
          value, newlines included, goes into `?q=`.

          An ordinary flex column, with the same gap as the column it sits in,
          so the bar, the input card and the result card below the form are
          three evenly spaced blocks and the form itself is invisible to the
          layout without needing `display: contents` to be. */}
      <Form method="get" ref={formRef} className="flex flex-col gap-4">
        {/* Keyed on the pair, so a navigation re-seeds the two selects. The
            URL is the source of truth across navigations; the bar's own state
            only exists so both sides can be edited before a submit. */}
        <LanguageBar
          key={`${pair.source}:${pair.target}`}
          pair={pair}
          direction={direction}
          q={q}
          formRef={formRef}
        />

        {/* Identical to the result card below, deliberately: see this
            component's own comment on why neither is tinted. */}
        <div className="rounded-2xl border p-5">
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
          {/* THE MIC AND THE SUBMIT SHARE ONE ROW, microphone on the left and
              the primary action on the right. They used to stack, submit
              above `Listen`, which put a secondary control under the primary
              one and made the card taller than the two controls need. The
              label still changes with the state, it does not just gain a
              spinner: a button that still reads "Translate" while a search
              runs is telling the reader nothing happened.

              THE BUTTON STAYS PROMINENT WITHOUT CLAIMING THE WHOLE ROW. It
              used to be full width below `sm` because it had the row to
              itself; sharing the row with the mic control means a full-width
              button would push the mic beneath it, the exact stacking this
              tidy removes. Both controls keep the shared 44px tap height. */}
          <div className="mt-3 flex items-center justify-between gap-2">
            <VoiceInput inputRef={inputRef} formRef={formRef} sourceLanguage={direction.from} />
            <Button type="submit" disabled={isSearching} className="h-11">
              {isSearching && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              {isSearching ? t('search.submitting') : t('search.submit')}
            </Button>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">{t('search.note')}</p>
        </div>
      </Form>

      {/* THE RESULT REGION, DIRECTLY UNDER THE INPUT CARD. The answer card,
          then the same results and the same correction a search always
          rendered, and with nothing searched whatever the caller passed as
          `emptyPane`. It sits OUTSIDE the form above on purpose: the enrichment
          panel's vote buttons are controls, and a control inside a GET form
          submits the search. `aria-live` stays on the
          section: the example is static and server rendered, so it is
          announced by nothing, and moving the attribute inward would leave a
          real answer unannounced. */}
      <section aria-live="polite" className="flex flex-col gap-4">
        {q === '' && emptyPane}
        {q !== '' && (
          <>
            {/* Keyed on the answer, so a new answer arrives with a fresh copy
                button rather than one still reading "Copied". */}
            <ResultField
              key={resultText}
              text={resultText}
              body={phrase === null ? <TranslationPane controller={translation} to={direction.to} /> : null}
              note={phrase === null ? null : t('search.wordByWordNote')}
              // Nothing to keep until there is a word AND an answer: a star
              // over an empty pane would save the empty string as the
              // translation, and a snapshot is forever.
              favorite={
                savableHit !== undefined && resultText !== '' ?
                  <FavoriteToggle
                    headwordId={savableHit.headwordId}
                    // No sense is recorded, because none was chosen. This card
                    // shows one answer for the whole word, so a sense written
                    // here would be a claim the reader never made.
                    senseId={null}
                    lemma={savableHit.lemma}
                    translationSnapshot={resultText}
                    from={direction.from}
                    to={direction.to}
                  />
                : null
              }
            />
            {/* WHAT THE SEARCH ACTUALLY READ, WHEN IT WAS NOT ALL OF IT.
                `searchPhrase` looks up at most `PHRASE_TOKEN_LIMIT` words, and
                a translator-shaped textarea invites a whole pasted paragraph,
                so the cap that was unreachable under a one-line box is now
                ordinary. Without this line the screen answers seven words of a
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
            {/* The phrase branch keeps the old heading: it is answering "what
                did you search for", and its own sections name themselves
                underneath. The word branch's heading moved into
                `DictionaryEntries`, which is the block it actually names. */}
            {phrase !== null && (
              <h2 className="font-display text-base font-semibold">{t('search.resultsFor', { query: q })}</h2>
            )}
            {phrase !== null && <PhraseResults phrase={phrase} from={direction.from} to={direction.to} />}
            {phrase === null && hits.length > 0 && (
              <DictionaryEntries hits={hits} to={direction.to} primaryHeadwordId={translationHeadwordId} />
            )}
            {phrase === null && hits.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('search.noResults', { query: q })}</p>
            )}
            {/* THE ANSWER, IN THE RESULT REGION, FOR THE WORD AT THE TOP.
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
                rewritten here. Writing a second idle sentence here is
                how a healthy provider key comes to read like a dead one.

                IT BLOCKS NOTHING ABOVE IT. The results, the truncation note
                and the correction are already rendered when this arrives, and
                a pending panel is one card at the foot of the column that
                polls itself to `ready` or `failed`. DESIGN.md rule 3: the
                skeleton has a terminal path, and
                `tests/integration/inline-enrichment-panel-resolves.test.ts`
                drives it. */}
            {/* THE SAME WORD BOTH PANELS ARE ABOUT, AND THE ID COMES FROM THE
                LOADER. It used to be read here as `hits[0]`, which was the same
                word the loader had resolved the panel for. It is not any more:
                the loader prefers the EXACT lemma match over the fuzzy top hit
                (M193, decision 1), so reading the array again here would poll
                one word for a panel resolved against another. */}
            {panel !== null && translationHeadwordId !== null && (
              <EnrichmentSection panel={panel} headwordId={translationHeadwordId} to={direction.to} />
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
