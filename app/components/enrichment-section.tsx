import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useFetcher } from 'react-router';
import { Link } from '#app/components/link';
import { Skeleton } from '#app/components/ui/skeleton';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type {
  EnrichmentIdleReason,
  EnrichmentPanel,
  EnrichmentPanelSense,
} from '#app/lib/enrichment/state.server';

/**
 * The three states of the generated explanation and extra examples.
 *
 * `idle` IS ITS OWN STATE, ON PURPOSE.
 *   A section that shows skeletons forever is a lie: skeletons say "this is
 *   arriving", and nothing is arriving, because no request is in flight. The
 *   honest shape for "we could enrich this entry, and have not" is a quiet card
 *   that says so. `pending` is reserved for a request that is genuinely
 *   running, which M171 wires up.
 *
 * `idle` NOW CARRIES A REASON, AND THE TWO READ DIFFERENTLY.
 *   The state alone is not enough to write honest copy. A server holding no key
 *   for the active provider can never finish, so "once this entry is enriched"
 *   would be a promise nobody can keep. The resolver decides which of the two it
 *   is and says so in `panel.reason`, rather than the component guessing from a
 *   null model, which would confuse "no key" with "no senses".
 *
 * POLLING ENDS, IT DOES NOT RUN FOREVER.
 *   A pending panel asks the read-only companion route for the same answer
 *   every few seconds, at most twenty times. After sixty seconds the skeletons
 *   are replaced by a line saying it is taking longer than usual, because
 *   skeletons that outlive the work are the same lie in slower motion.
 */

/** How long between two polls of the companion route. */
const POLL_INTERVAL_MS = 3000;
/** How many polls before the panel stops asking. Twenty at three seconds is one minute. */
const POLL_LIMIT = 20;

/** The house recipe for a label above a block, DESIGN.md section 2. */
const SECTION_LABEL = 'text-[11px] font-semibold uppercase tracking-[0.11em] text-primary';

export interface EnrichmentSectionProps {
  /**
   * The resolved panel. The type comes from a `.server` module, which is safe
   * because a type import is erased before the client bundle is built.
   */
  panel: EnrichmentPanel;
  headwordId: string;
  to: LanguageCode;
}

/** The quiet card for "nothing is arriving", with the reason it is not. */
function IdlePanel({ reason }: { reason: EnrichmentIdleReason }) {
  const { t } = useTranslation();

  return (
    <section className="rounded-lg border border-dashed bg-muted/40 p-4">
      <h2 className="font-display text-base font-semibold">{t('enrichment.title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {reason === 'not-configured' ? t('enrichment.notConfigured') : t('enrichment.idle')}
      </p>
    </section>
  );
}

/** Skeletons while the work runs, and a plain line once it has run long. */
function PendingPanel({ isExhausted }: { isExhausted: boolean }) {
  const { t } = useTranslation();

  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className="font-display text-base font-semibold">{t('enrichment.title')}</h2>
      {/* The spinner vocabulary attaches to the thing that is pending, so the
          skeletons sit under the label rather than floating on the page. */}
      <p className="mt-1 text-sm text-muted-foreground">
        {isExhausted ? t('enrichment.stillWorking') : t('enrichment.pending')}
      </p>
      {!isExhausted && (
        <div className="mt-3 space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      )}
    </section>
  );
}

/** One labelled block inside a sense. */
function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className={SECTION_LABEL}>{label}</p>
      {children}
    </div>
  );
}

/** The notes a model wrote for ONE sense. */
function SenseNotes({ sense, from, to }: { sense: EnrichmentPanelSense; from: LanguageCode; to: LanguageCode }) {
  const { t } = useTranslation();
  const { output } = sense;

  return (
    <div className="flex flex-col gap-4">
      <Labelled label={t('enrichment.translationLabel')}>
        <ul className="mt-1 flex flex-wrap gap-2">
          {output.translation.map((word) => (
            <li key={word} lang={to} className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
              {word}
            </li>
          ))}
        </ul>
      </Labelled>

      <Labelled label={t('enrichment.explanationLabel')}>
        <p lang={to} className="mt-1 text-sm">
          {output.explanation}
        </p>
      </Labelled>

      <Labelled label={t('enrichment.registerLabel')}>
        <p lang={to} className="mt-1 text-sm">
          {output.register}
        </p>
      </Labelled>

      <Labelled label={t('enrichment.usageNotesLabel')}>
        <p lang={to} className="mt-1 text-sm">
          {output.usageNotes}
        </p>
      </Labelled>

      <Labelled label={t('enrichment.examplesLabel')}>
        <ul className="mt-1 space-y-2">
          {output.examples.map((example) => (
            <li key={example.text}>
              <p lang={from} className="text-base">
                {example.text}
              </p>
              <p lang={to} className="text-sm text-muted-foreground">
                {example.translation}
              </p>
            </li>
          ))}
        </ul>
      </Labelled>

      {/* An empty list is not a heading with nothing under it. A model that
          found no mistake worth naming has said something, and the honest way
          to render it is to leave the block out. */}
      {output.commonMistakes.length > 0 && (
        <Labelled label={t('enrichment.commonMistakesLabel')}>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {output.commonMistakes.map((mistake) => (
              <li key={mistake} lang={to} className="text-sm">
                {mistake}
              </li>
            ))}
          </ul>
        </Labelled>
      )}
    </div>
  );
}

/** Every cached sense, in page order, under one attribution line. */
function ReadyPanel({
  senses,
  model,
  from,
  to,
}: {
  senses: EnrichmentPanelSense[];
  model: string;
  from: LanguageCode;
  to: LanguageCode;
}) {
  const { t } = useTranslation();

  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className="font-display text-base font-semibold">{t('enrichment.title')}</h2>
      <div className="mt-3 flex flex-col gap-6">
        {senses.map((sense) => (
          <SenseNotes key={sense.senseId} sense={sense} from={from} to={to} />
        ))}
      </div>
      {/* THIS LINE IS A LEGAL REQUIREMENT, NOT VISUAL NOISE. DO NOT DELETE IT.
          EU AI Act Article 50 puts the disclosure duty on the deployer, and
          these rows are unreviewed, so the reader has to be told on the page
          that a model wrote them and which model that was. */}
      <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
        {t('enrichment.generatedBy', { model })}{' '}
        <Link to="/attribution#llm-generated" className="underline-offset-2 hover:text-foreground hover:underline">
          {t('enrichment.sourceCredit')}
        </Link>
      </p>
    </section>
  );
}

export function EnrichmentSection({ panel, headwordId, to }: EnrichmentSectionProps) {
  const fetcher = useFetcher<EnrichmentPanel>();
  const [attempts, setAttempts] = useState(0);
  const load = fetcher.load;

  // A poll that came back ready WINS over the loader's answer, which was taken
  // before the work finished. Anything else, including a poll still reporting
  // pending, leaves the loader's panel in place.
  const polled = fetcher.data;
  const shown: EnrichmentPanel = polled !== undefined && polled.state === 'ready' ? polled : panel;

  const pollUrl = `/api/enrichment/${headwordId}?to=${to}`;
  const isExhausted = attempts >= POLL_LIMIT;
  const isPolling = shown.state === 'pending' && !isExhausted;

  // ONE INTERVAL, NEVER TWO. The effect depends on a BOOLEAN, not on the
  // attempt count, so ticking the counter does not tear the interval down and
  // start a fresh one on the next render, which would reset the three seconds
  // every time and fire nothing. `fetcher.load` is a stable `useCallback` in
  // React Router, so naming it here does not restart the interval either. The
  // boolean flips exactly twice, on and off, and the cleanup runs on the off.
  useEffect(() => {
    if (!isPolling) return;
    const timer = setInterval(() => {
      setAttempts((previous) => previous + 1);
      void load(pollUrl);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isPolling, pollUrl, load]);

  if (shown.state === 'ready') {
    return <ReadyPanel senses={shown.senses} model={shown.model} from={shown.from} to={to} />;
  }

  if (shown.state === 'pending') {
    return <PendingPanel isExhausted={isExhausted} />;
  }

  return <IdlePanel reason={shown.reason} />;
}
