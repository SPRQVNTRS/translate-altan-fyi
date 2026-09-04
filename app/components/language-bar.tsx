import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '#app/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#app/components/ui/select';
import type { Direction, LanguageCode } from '#app/lib/dictionary/detect-language';
import {
  DETECT,
  LANGUAGE_NAMES,
  LANGUAGE_OPTIONS,
  isPairLanguage,
  isSourceSelection,
  type LanguagePair,
  type SourceSelection,
} from '#app/lib/dictionary/language-pair';
import { persistLanguagePair } from '#app/lib/local-store';

/** What the bar needs from the screen around it. */
export interface LanguageBarProps {
  /** The pair this page was rendered with, resolved from the URL, then the cookie, then the default. */
  pair: LanguagePair;
  /** The direction the search actually ran in. It is what "detect" resolved TO. */
  direction: Direction;
  /** The query on screen. An empty one is why a change does not submit: see below. */
  q: string;
  /** The one search form. The bar submits it and writes into it, and owns neither. */
  formRef: RefObject<HTMLFormElement | null>;
  className?: string;
}

/**
 * The language pair, as one row above the cards: source, swap, target.
 *
 * IT IS A THREE-CELL GRID, AND THAT IS THE ALIGNMENT FIX. The row used to be a
 * wrapping flex box, which made its two halves equal only by coincidence and
 * dropped the target select onto a second line as the viewport narrowed.
 * Measured at 1280px, the source select was 14px narrower than the card
 * underneath it and the target select began 14px to the right of the card it
 * labelled. `grid-cols-[1fr_auto_1fr]` makes the two halves equal by
 * construction, keeps the swap button between them at its own width, and can
 * never wrap. The row itself is as wide as the cards below it because it is one
 * more block in the same single column.
 *
 * WHY IT EXISTS. The pair used to be a guess plus a "flip" link, and the flip
 * pinned its direction into every later submission. Typing a German word after
 * one tap searched the English side and returned nothing, with nothing on
 * screen saying why. The pair is now stated, not inferred, and this row is
 * where a reader states it.
 *
 * IT IS INSIDE THE SEARCH FORM, AND IT CARRIES THE ONLY `from` AND `to` THERE
 * ARE. Two hidden inputs, always present, always holding what the two selects
 * show. There is no second code path that decides whether to send the pair,
 * which is exactly what the old pinning rule was.
 *
 * `from` CARRIES THE LITERAL `detect` WHEN DETECTION IS WANTED, and the server
 * needs no special case for it: `chooseDirection` in `detect-language.ts`
 * ignores any `from` that is not one of the four served languages and falls
 * through to the exact-hit count and then the character heuristic. That
 * function was read end to end on 2026-09-04 to confirm it, so this claim is a
 * report of the code rather than an assumption about it.
 *
 * THE SELECTION IS LOCAL STATE, AND THE URL IS STILL THE SOURCE OF TRUTH. The
 * state exists so both selects can be edited before a submit. It is SEEDED
 * from the `pair` prop and re-seeded on every navigation, because the caller
 * gives this component a `key` built from the pair: a navigation is a new
 * pair, and a new key is React's own way of saying that the old selection is
 * finished rather than stale.
 */
export function LanguageBar({ pair, direction, q, formRef, className }: LanguageBarProps) {
  const { t } = useTranslation();
  const sourceId = useId();
  const targetId = useId();
  const [source, setSource] = useState<SourceSelection>(pair.source);
  const [target, setTarget] = useState<LanguageCode>(pair.target);
  // Whether the last state change came from the reader rather than from the
  // first render. Only a reader's change may submit: see the effect below.
  const submitOnNextCommit = useRef(false);

  // THE SUBMIT RUNS AFTER THE STATE HAS LANDED, WHICH IS WHY IT IS AN EFFECT.
  //   A `requestSubmit()` called straight from the change handler would submit
  //   the hidden inputs as they still are, one render behind the selection the
  //   reader just made, and search the pair they had a moment ago. Submitting
  //   after the commit is the one ordering where the form and the selection
  //   agree, and the ref is what keeps the first render from searching for a
  //   query nobody typed.
  useEffect(() => {
    if (!submitOnNextCommit.current) return;
    submitOnNextCommit.current = false;
    formRef.current?.requestSubmit();
  }, [source, target, formRef]);

  // EVERY CHANGE OF THE PAIR COMES THROUGH HERE: both selects and the swap
  // button. There is no second place that decides what a pick means.
  //
  // AN EMPTY BOX SUBMITS NOTHING. `/translate` with no query is the landing
  // page, so a submit here would push a history entry and navigate to the page
  // already on screen.
  //
  // THE PICK IS PERSISTED HERE, NOT ONLY ON SUBMIT. Persistence used to hang
  // entirely off `PersistLanguagePair`, which writes the pair the LOADER
  // resolved. With no submit the loader never re-runs, so a pick made on the
  // empty landing page was never written anywhere and died with the tab: the
  // reader picked Espanol, reloaded, and the select was back on English. So
  // the write happens at the moment the pick is made, whether or not a search
  // follows it.
  //
  // IT IS IN THE HANDLER AND NOT IN AN EFFECT WATCHING `source`/`target`,
  // because the write is caused by the reader's action rather than by a
  // render. The state is also RE-SEEDED from the `pair` prop on every
  // navigation (the caller keys this component on the pair), so an effect
  // would write on arrivals nobody asked for.
  //
  // TWO WRITERS NOW EXIST, AND THE ORDER IS DELIBERATE. On a results page this
  // writes the reader's RAW pick immediately, then the form submits and
  // `PersistLanguagePair` writes the loader's RECONCILED pair, which may
  // differ: `reconcilePairWithDirection` repairs a target that collides with
  // the source detection settled on. The reconciled write lands last and wins,
  // which is correct, because the reconciled pair is the one the search
  // actually used. This is not a double write to be tidied away.
  //
  // A FAILED WRITE IS REPORTED AND SWALLOWED INSIDE `persistLanguagePair`, so
  // losing a preference never takes the screen away from the reader.
  const changePair = (next: LanguagePair): void => {
    submitOnNextCommit.current = q !== '';
    setSource(next.source);
    setTarget(next.target);
    void persistLanguagePair(next);
  };

  // WHAT `detect` RESOLVED TO, for the swap and for the trigger's own label. A
  // detected direction is only knowable after a search has run, which is why
  // both uses below are guarded on there being a query.
  const resolvedSource = source === DETECT ? direction.from : source;
  const hasResolvedSource = source !== DETECT || q !== '';

  // The trigger says WHAT WAS DETECTED, not merely that detection is on. The
  // chip this bar replaces showed the reader which side of the dictionary
  // their word had been read as, and a bare "Detect language" over a wrong
  // answer would take that away. The language is named natively, from the one
  // table that names languages.
  //
  // THE LANGUAGE COMES FIRST, THE MARKER SECOND. Measured at 390px the source
  // cell is 149px wide, so the trigger's text truncates. "Detect language
  // (Deutsch)" cut to "Detect langu...", which throws away the one word worth
  // keeping and keeps four that carry nothing. "Deutsch (detected)" truncates
  // to "Deutsch (dete...", which still shows the fact the reader came here
  // for. The dropdown OPTION keeps the plain "Detect language" wording,
  // because as an option it is a choice about what to do next, not a report
  // of what already happened, so it has nothing to lead with.
  const sourceLabel =
    source === DETECT ?
      q === '' ?
        t('search.detectLanguage')
      : t('search.detectedAs', { language: LANGUAGE_NAMES[direction.from] })
    : LANGUAGE_NAMES[source];

  return (
    <div className={className}>
      {/* Hidden and unconditional. The pair the reader can see is the pair the
          next submission carries, whatever else on this screen submits it: the
          button, the Enter key, or the voice control. */}
      <input type="hidden" name="from" value={source} />
      <input type="hidden" name="to" value={target} />

      {/* THREE CELLS, NEVER A WRAP. The two `1fr` tracks are equal at every
          width, so the pair reads as two halves of the card below rather than
          as two boxes that happen to be near it, and the swap button keeps its
          own width in the middle. A phone gets the same row as a desktop, one
          line shorter of nothing. */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <Select
          value={source}
          onValueChange={(next) => {
            // Radix hands back a plain string. Narrow it rather than assert
            // it: an unserved code would reach the dictionary query.
            if (isSourceSelection(next)) changePair({ source: next, target });
          }}
        >
          {/* `w-full min-w-0` fills the grid cell and lets it shrink: a floor
              width would push the third cell off a narrow phone, which is the
              wrapping the grid exists to prevent. A long label truncates
              instead, which is what the last rule below buys.

              THE HEIGHT IS 44px, AND IT NEEDS BOTH CLASSES. The shared trigger
              sets its height through `data-[size=default]:h-9`, and a variant
              utility outranks a plain `h-11`, so the plain one alone would be
              silently overridden. Naming the same data variant is what lets
              tailwind-merge drop the 36px rule rather than stack under it.

              A LONG LABEL ENDS IN AN ELLIPSIS RATHER THAN MID-WORD. The shared
              trigger lays its value out as a flex box, and `text-overflow` does
              nothing to a flex container, so "Detect language (Deutsch)" was
              cut off after "languag" with no sign that anything was missing.
              The value becomes a block, which is what lets it truncate. */}
          <SelectTrigger
            id={sourceId}
            className="h-11 w-full min-w-0 *:data-[slot=select-value]:block *:data-[slot=select-value]:truncate data-[size=default]:h-11"
            aria-label={t('search.sourceLabel')}
          >
            <SelectValue>{sourceLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {/* Detection first, because it is the default and the answer for a
                reader who does not know what they are looking at. */}
            <SelectItem value={DETECT}>{t('search.detectLanguage')}</SelectItem>
            {LANGUAGE_OPTIONS.map((option) => (
              <SelectItem key={option.code} value={option.code}>
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          type="button"
          variant="outline"
          size="icon"
          // 44px square, because `size="icon"` is 36px and a thumb on a phone
          // misses that. It is the middle cell of the row, so it grows without
          // moving either select off its own half.
          className="size-11"
          aria-label={t('search.swapLanguages')}
          // Nothing to swap: detection has not resolved, so the source side has
          // no language yet to move across. Every other state can swap.
          disabled={!hasResolvedSource}
          onClick={() => changePair({ source: target, target: resolvedSource })}
        >
          <ArrowLeftRight className="size-4" aria-hidden="true" />
        </Button>

        <Select
          value={target}
          onValueChange={(next) => {
            if (isPairLanguage(next)) changePair({ source, target: next });
          }}
        >
          {/* The same cell treatment and the same 44px, for the same reasons
              as the source trigger above. */}
          <SelectTrigger
            id={targetId}
            className="h-11 w-full min-w-0 *:data-[slot=select-value]:block *:data-[slot=select-value]:truncate data-[size=default]:h-11"
            aria-label={t('search.targetLabel')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGE_OPTIONS.map((option) => (
              <SelectItem
                key={option.code}
                value={option.code}
                // A translation is an edge between two DIFFERENT languages, so
                // `de -> de` names no edge that exists. The server repairs such
                // a pair anyway; disabling it here is what stops the bar from
                // ever showing a target the search did not use.
                disabled={hasResolvedSource && option.code === resolvedSource}
              >
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
