import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useFetcher } from 'react-router';
import { EnrichmentVotes } from '#app/components/enrichment-votes';
import { Link } from '#app/components/link';
import { Skeleton } from '#app/components/ui/skeleton';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type {
  EnrichmentIdleReason,
  EnrichmentPanel,
  EnrichmentPanelSense,
  EnrichmentRefusal,
} from '#app/lib/enrichment/state.server';

/**
 * The four states of the generated explanation and extra examples.
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
 * `failed` IS THE SAME HONESTY, FOR THE OTHER WAY WORK ENDS.
 *   A provider outage, or a model that answered nothing usable, leaves the key
 *   with failed rows and nothing running. Without this state the resolver could
 *   only say `pending`, so the page showed skeletons for a minute and then
 *   claimed the work was slow, which is exactly the lie `idle` exists to
 *   prevent. A failed panel says so at once, shows no skeletons, and STOPS
 *   POLLING, because there is nothing left to wait for.
 *
 * A FAILURE CAN STILL CARRY NOTES.
 *   A run that enriched two senses of three failed, but the two were paid for
 *   and are worth reading. A failed panel therefore renders whatever senses did
 *   land, under the same attribution line as a ready one.
 *
 * POLLING ENDS, IT DOES NOT RUN FOREVER.
 *   A pending panel asks the read-only companion route for the same answer
 *   every few seconds, at most twenty times. After sixty seconds the skeletons
 *   are replaced by a line saying it is taking longer than usual, because
 *   skeletons that outlive the work are the same lie in slower motion.
 *
 * A REFUSAL SHOWS NO SKELETONS AND STARTS NO POLL.
 *   The loader sets `panel.refusal` when a spend guard turned the trigger away,
 *   so nothing was queued and nothing is coming. Animating a skeleton over that
 *   would be the exact lie this file's other three rules exist to prevent, and
 *   polling for it would ask a companion route twenty times about work that was
 *   never started. The reader gets one honest line instead, and any senses that
 *   were already cached still render under it, votes and all.
 *
 * EVERY RENDERED SENSE CARRIES ITS VOTE CONTROLS.
 *   The notes are unreviewed model output, so the reader is the only reviewer
 *   there is, and a thumb up or down is what tells the operator which cached
 *   answers are worth re-running. The controls sit inside the sense rather than
 *   at the foot of the panel, because a vote judges ONE cached answer and a
 *   panel can hold several.
 */

/** How long between two polls of the companion route. */
const POLL_INTERVAL_MS = 3000;
/** How many polls before the panel stops asking. Twenty at three seconds is one minute. */
const POLL_LIMIT = 20;

/** The house recipe for a label above a block, DESIGN.md section 2. */
const SECTION_LABEL = 'text-[11px] font-semibold uppercase tracking-[0.11em] text-primary';

/**
 * What a refused trigger says, per guard, as a table rather than a comparison
 * chain. Both lines name the guard in the reader's own terms and both end the
 * same way: the dictionary entry above is complete and stays where it is.
 */
const REFUSAL_MESSAGE_KEY = {
  budget: 'enrichment.budgetReached',
  'rate-limited': 'enrichment.rateLimited',
} satisfies Record<EnrichmentRefusal, string>;

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
      {/* THE TRANSLATION CHIPS ARE MONOSPACED, AND NOTHING ELSE IN THIS PANEL
          IS. They are the answer to "what is this word", so they get the same
          treatment the result rows give a headword and a translation. The
          explanation, the register note and the usage notes under them are
          prose about the word rather than the word, and they stay in the sans
          face. This panel renders in two places, the entry page and the search
          screen's output pane, so the rule holds on both without being written
          twice. */}
      <Labelled label={t('enrichment.translationLabel')}>
        <ul className="mt-1 flex flex-wrap gap-2">
          {output.translation.map((word) => (
            <li key={word} lang={to} className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-xs text-primary">
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

      {/* The controls close the sense they judge. A vote attaches to one cached
          answer, so the score belongs beside that answer's notes and not at the
          foot of a panel that may hold three of them. */}
      <EnrichmentVotes
        enrichmentId={sense.enrichmentId}
        up={sense.up}
        down={sense.down}
        myVote={sense.myVote}
      />
    </div>
  );
}

/**
 * The disclosure line under any rendered notes.
 *
 * THIS LINE IS A LEGAL REQUIREMENT, NOT VISUAL NOISE. DO NOT DELETE IT.
 *   EU AI Act Article 50 puts the disclosure duty on the deployer, and these
 *   rows are unreviewed, so the reader has to be told on the page that a model
 *   wrote them and which model that was. It is a component rather than markup
 *   copied into two panels, because a duty discharged in two places is a duty
 *   one of them will eventually drop.
 */
function GeneratedBy({ model }: { model: string }) {
  const { t } = useTranslation();

  return (
    <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
      {t('enrichment.generatedBy', { model })}{' '}
      <Link to="/attribution#llm-generated" className="underline-offset-2 hover:text-foreground hover:underline">
        {t('enrichment.sourceCredit')}
      </Link>
    </p>
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
      <GeneratedBy model={model} />
    </section>
  );
}

/**
 * The work ended badly. No skeletons, and whatever senses landed anyway.
 *
 * The failure line sits ABOVE the notes: it is the answer to "why is this
 * short", and a reader who stops after the first paragraph has still been told.
 */
function FailedPanel({
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
      <p className="mt-1 text-sm text-muted-foreground">{t('enrichment.failed')}</p>
      {senses.length > 0 && (
        <>
          <div className="mt-3 flex flex-col gap-6">
            {senses.map((sense) => (
              <SenseNotes key={sense.senseId} sense={sense} from={from} to={to} />
            ))}
          </div>
          <GeneratedBy model={model} />
        </>
      )}
    </section>
  );
}

/**
 * A spend guard turned the trigger away, so nothing was queued.
 *
 * ONE COMPONENT FOR BOTH REFUSED STATES, BECAUSE THE READER'S SITUATION IS ONE.
 *   A refusal can land on a pending panel, where the loader wanted to queue and
 *   was stopped, and on a failed one, where it wanted to retry and was stopped.
 *   The difference is a fact about the cache, not about the reader: either way
 *   no work is running, no new notes are coming, and the honest page is a line
 *   saying which guard spoke.
 *
 * NO SKELETON IS DRAWN HERE, EVER. A skeleton is a promise that something is
 * arriving, and this panel exists precisely because nothing is.
 *
 * The senses that WERE cached still render, under the same attribution line and
 * with their own vote controls. They were paid for before the guard closed, and
 * a spend cap that also hid work already bought would punish the reader twice.
 */
function RefusalPanel({
  refusal,
  senses,
  model,
  from,
  to,
}: {
  refusal: EnrichmentRefusal;
  senses: EnrichmentPanelSense[];
  model: string;
  from: LanguageCode;
  to: LanguageCode;
}) {
  const { t } = useTranslation();

  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className="font-display text-base font-semibold">{t('enrichment.title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t(REFUSAL_MESSAGE_KEY[refusal])}</p>
      {senses.length > 0 && (
        <>
          <div className="mt-3 flex flex-col gap-6">
            {senses.map((sense) => (
              <SenseNotes key={sense.senseId} sense={sense} from={from} to={to} />
            ))}
          </div>
          <GeneratedBy model={model} />
        </>
      )}
    </section>
  );
}

/**
 * Which of the two answers the page shows.
 *
 * A poll that came back READY wins over the loader's answer, which was taken
 * before the work finished. A poll that came back FAILED wins for the same
 * reason, over a loader that still says pending: the work is over, badly, and
 * skeletons must stop. The reverse never holds. A poll reporting pending is the
 * older reading of a job that has since finished, so it must not overwrite a
 * loader panel that is already ready or failed.
 *
 * An options object, not two positional panels: they share a type, so an
 * argument swap here would compile and would silently invert the rule.
 */
function pickPanel({ loaded, polled }: { loaded: EnrichmentPanel; polled: EnrichmentPanel }): EnrichmentPanel {
  if (polled.state === 'ready') return polled;
  if (polled.state === 'failed' && loaded.state === 'pending') return polled;
  return loaded;
}

export function EnrichmentSection({ panel, headwordId, to }: EnrichmentSectionProps) {
  const fetcher = useFetcher<EnrichmentPanel>();
  const [attempts, setAttempts] = useState(0);
  const load = fetcher.load;

  const polled = fetcher.data;
  const shown: EnrichmentPanel = polled === undefined ? panel : pickPanel({ loaded: panel, polled });

  const pollUrl = `/api/enrichment/${headwordId}?to=${to}`;
  const isExhausted = attempts >= POLL_LIMIT;
  // ONLY a pending panel polls. `ready` and `failed` are both terminal, so a
  // poll that lands on either one tears the interval down on the next render.
  //
  // A REFUSED PENDING PANEL IS TERMINAL TOO. The loader was stopped before it
  // queued anything, so twenty polls would ask a companion route twenty times
  // about a job that does not exist and would answer `pending` every time.
  const isPolling = shown.state === 'pending' && shown.refusal === null && !isExhausted;

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

  // The refusal is read BEFORE the state, because it is the more specific fact.
  // Both refusable states say the same thing to the reader, and neither of them
  // is waiting for anything, so the branch that draws skeletons must never be
  // reached with a refusal in hand.
  if (shown.state !== 'idle' && shown.refusal !== null) {
    return (
      <RefusalPanel
        refusal={shown.refusal}
        senses={shown.senses}
        model={shown.model}
        from={shown.from}
        to={to}
      />
    );
  }

  if (shown.state === 'failed') {
    return <FailedPanel senses={shown.senses} model={shown.model} from={shown.from} to={to} />;
  }

  if (shown.state === 'pending') {
    return <PendingPanel isExhausted={isExhausted} />;
  }

  return <IdlePanel reason={shown.reason} />;
}
