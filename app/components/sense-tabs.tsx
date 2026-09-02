import { useId, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '#app/components/link';
import { SourceLink } from '#app/components/source-link';
import { cn } from '#app/lib/utils';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { EntrySense } from '#app/lib/dictionary/entry.server';

/**
 * The senses of one headword, as a tab list.
 *
 * NOTHING IS SELECTED UNTIL THE READER PICKS.
 *   A word with several senses has several different translations, and the
 *   first one in the list is not the likeliest, it is just the first. Selecting
 *   it by default would show a confident, well set, wrong answer, which is the
 *   worst thing a dictionary can do. Until a pick is made the panel says so.
 *   With exactly one sense there is nothing to choose, so the chips disappear
 *   and the panel renders directly.
 *
 * ACTIVATION IS MANUAL, NOT FOLLOW-FOCUS.
 *   Arrow keys move focus between chips; Enter or Space selects. A follow-focus
 *   tab list would select the first chip the moment the reader tabbed into the
 *   group, which is the same wrong answer through a side door.
 */

/** The short label a chip shows: this sense's gloss in the reader's language. */
function senseLabel(sense: EntrySense, uiLanguage: string, fallback: string): string {
  const inUiLanguage = sense.glosses.find((gloss) => gloss.languageCode === uiLanguage);
  if (inUiLanguage) return inUiLanguage.gloss;
  const first = sense.glosses[0];
  return first ? first.gloss : fallback;
}

export interface SenseTabsProps {
  senses: EntrySense[];
  /** The target language, carried into every translation link. */
  to: LanguageCode;
  /**
   * The sense the reader has picked, or null when they have not picked yet.
   *
   * OWNED BY THE ENTRY ROUTE, not by this component. The "save to list" button
   * beside these chips has to save the sense the reader chose, and two copies
   * of that answer would eventually disagree. Lifting the state does NOT change
   * the two rules above: null is still the starting value, and only
   * `onSelectSense` moves off it.
   */
  selectedSenseId: string | null;
  /** Called when the reader picks a sense. Only a click or Enter/Space calls it, never focus. */
  onSelectSense: (senseId: string) => void;
}

/** The glosses, translations and credits of one sense. */
function SensePanel({ sense, to }: { sense: EntrySense; to: LanguageCode }) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-4">
      {sense.glosses.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.11em] text-primary">{t('entry.glossesLabel')}</p>
          <ul className="mt-1 space-y-1">
            {sense.glosses.map((gloss) => (
              <li key={`${gloss.sourceSlug}:${gloss.languageCode}:${gloss.gloss}`} className="text-sm">
                <span lang={gloss.languageCode}>{gloss.gloss}</span>{' '}
                <SourceLink
                  sourceSlug={gloss.sourceSlug}
                  sourceName={gloss.sourceName}
                  sourceLicence={gloss.sourceLicence}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.11em] text-primary">
          {t('entry.translationsLabel')}
        </p>
        {sense.translations.length === 0 && (
          <p className="mt-1 text-sm text-muted-foreground">{t('entry.noTranslations')}</p>
        )}
        {sense.translations.length > 0 && (
          <ul className="mt-1 space-y-1">
            {sense.translations.map((translation) => (
              <li key={`${translation.sourceSlug}:${translation.headwordId}`} className="text-base">
                <Link
                  to={`/entry/${translation.headwordId}?to=${to}`}
                  lang={translation.languageCode}
                  className="hover:text-primary"
                >
                  {translation.lemma}
                </Link>{' '}
                <SourceLink
                  sourceSlug={translation.sourceSlug}
                  sourceName={translation.sourceName}
                  sourceLicence={translation.sourceLicence}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function SenseTabs({ senses, to, selectedSenseId, onSelectSense }: SenseTabsProps) {
  const { t, i18n } = useTranslation();
  const groupId = useId();
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);

  if (senses.length === 0) return null;

  const onlySense = senses.length === 1 ? senses[0] : undefined;
  if (onlySense) {
    return <SensePanel sense={onlySense} to={to} />;
  }

  const selected = senses.find((sense) => sense.senseId === selectedSenseId);
  // With nothing selected the first chip is the tab stop, which is the standard
  // roving-tabindex entry point. It is focusable, not selected.
  const tabIndexFor = (index: number, isSelected: boolean): number => {
    if (selectedSenseId === null) return index === 0 ? 0 : -1;
    return isSelected ? 0 : -1;
  };

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = (index + step + senses.length) % senses.length;
    chipRefs.current[next]?.focus();
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Radix has no tabs primitive in this repo, and a manual-activation tab
          list with no default selection is not what a stock one does anyway. */}
      <div role="tablist" aria-label={t('entry.sensesLabel')} className="flex flex-wrap gap-2">
        {senses.map((sense, index) => {
          const isSelected = sense.senseId === selectedSenseId;
          return (
            <button
              key={sense.senseId}
              type="button"
              role="tab"
              id={`${groupId}-tab-${sense.senseId}`}
              aria-selected={isSelected}
              aria-controls={`${groupId}-panel`}
              tabIndex={tabIndexFor(index, isSelected)}
              ref={(node) => {
                chipRefs.current[index] = node;
              }}
              onKeyDown={(event) => moveFocus(event, index)}
              onClick={() => onSelectSense(sense.senseId)}
              className={cn(
                'rounded-full px-2 py-0.5 text-xs transition-colors',
                isSelected ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary hover:bg-primary/20',
              )}
            >
              {senseLabel(sense, i18n.language, t('entry.sensesLabel'))}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${groupId}-panel`}
        aria-labelledby={selected ? `${groupId}-tab-${selected.senseId}` : undefined}
        tabIndex={0}
      >
        {!selected && <p className="text-sm text-muted-foreground">{t('entry.pickSense')}</p>}
        {selected && <SensePanel sense={selected} to={to} />}
      </div>
    </div>
  );
}
