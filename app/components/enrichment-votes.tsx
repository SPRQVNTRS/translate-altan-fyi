import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useFetcher } from 'react-router';
import { ThumbsDown, ThumbsUp } from 'lucide-react';

import { Link } from '#app/components/link';
import { Button } from '#app/components/ui/button';
import type { VoteOutcome } from '#app/routes/api.enrichment-vote';

/**
 * The two vote controls under ONE cached enrichment.
 *
 * THE BUTTONS ARE SHOWN TO EVERYONE, INCLUDING A READER WITH NO ACCOUNT.
 *   Hiding them from an anonymous visitor would hide the fact that voting
 *   exists at all, and nobody signs in for a feature they were never shown. So
 *   the control is always on the page and the gate speaks only when it is used:
 *   the route answers 401, and the line under the buttons says an account is
 *   needed and offers the way to get one. The refusal is what teaches the
 *   reader; an absent button teaches nothing.
 *
 * A VOTE JUDGES AN ANSWER, NOT A WORD.
 *   `enrichmentId` names one cached model output. It is the only identifier
 *   that crosses the wire, which is what keeps `enrichment_votes` free of any
 *   dictionary term: the row this posts is an opinion about a paragraph of
 *   generated text, never a record that this reader looked this word up.
 *
 * NO ENGLISH IS WRITTEN HERE.
 *   Every line a reader can see comes from `app/locales`. The `invalid` outcome
 *   is deliberately silent: it cannot be produced by these buttons, and copy
 *   invented for it would be one untranslated sentence in a translated page.
 */

/** The two directions a vote can point. There is no neutral vote: not voting is neutral. */
type VoteChoice = -1 | 1;

/** The score as the buttons render it, whether it came from the server or from a click. */
interface VoteTallyView {
  up: number;
  down: number;
  myVote: VoteChoice | null;
}

export interface EnrichmentVotesProps {
  enrichmentId: string;
  up: number;
  down: number;
  myVote: -1 | 1 | null;
}

/**
 * Which locale key answers each outcome, as a table rather than a chain.
 *
 * `recorded` and `flagged` share a key ON PURPOSE. From the reader's side both
 * are the same event, their vote was counted; the review queue is an operator's
 * concern and naming it here would leak an internal workflow into reader copy.
 * `invalid` maps to `null`, which renders nothing.
 */
const OUTCOME_MESSAGE_KEY = {
  unauthenticated: 'enrichment.voteSignIn',
  invalid: null,
  recorded: 'enrichment.voteRecorded',
  improving: 'enrichment.voteImproving',
  flagged: 'enrichment.voteRecorded',
  budget: 'enrichment.budgetReached',
} satisfies Record<VoteOutcome['state'], string | null>;

/**
 * The score the server last confirmed, or `null` when it has confirmed none.
 *
 * The two refusal outcomes carry no counts, because nothing was written, so
 * they must fall back to the loader's figures rather than to zeroes. Zeroes
 * would blank a real score every time a signed-out reader clicked.
 */
function settledTally(outcome: VoteOutcome | undefined): VoteTallyView | null {
  if (outcome === undefined) return null;
  if (outcome.state === 'unauthenticated') return null;
  if (outcome.state === 'invalid') return null;
  return { up: outcome.up, down: outcome.down, myVote: outcome.myVote };
}

/**
 * The vote this submission is carrying, read back out of the request itself.
 *
 * THE OPTIMISTIC FIGURE COMES FROM `fetcher.formData`, NOT FROM STATE.
 *   The in-flight request already holds what the reader clicked, so mirroring
 *   it into a `useState` inside an effect would be a second copy of a fact the
 *   router is already holding, and the two would disagree for one render on
 *   every click.
 *
 * The value is compared as the STRING a form actually sends. A form body has no
 * numbers in it.
 */
function submittedVote(formData: FormData | undefined): VoteChoice | null {
  if (formData === undefined) return null;
  const raw = formData.get('value');
  if (raw === '1') return 1;
  if (raw === '-1') return -1;
  return null;
}

/**
 * The score as it will read once this vote lands.
 *
 * One vote per reader, so casting a vote also RETRACTS the reader's previous
 * one. Adding without subtracting would let a reader who changes their mind
 * count twice for one render, which is the same arithmetic error the upsert in
 * `castVote` exists to prevent on the server.
 */
function applyVote(base: VoteTallyView, next: VoteChoice): VoteTallyView {
  return {
    up: base.up + (next === 1 ? 1 : 0) - (base.myVote === 1 ? 1 : 0),
    down: base.down + (next === -1 ? 1 : 0) - (base.myVote === -1 ? 1 : 0),
    myVote: next,
  };
}

export function EnrichmentVotes(props: EnrichmentVotesProps): ReactNode {
  const { t } = useTranslation();
  const fetcher = useFetcher<VoteOutcome>();

  // The loader's figures are the floor. They survive a reload, which is what
  // makes the reader's own vote persist: `myVote` is read per account on the
  // server, so a fresh page already knows which button is pressed.
  const loaded: VoteTallyView = { up: props.up, down: props.down, myVote: props.myVote };
  const settled = settledTally(fetcher.data) ?? loaded;
  const inFlight = submittedVote(fetcher.formData);
  const shown = inFlight === null ? settled : applyVote(settled, inFlight);

  const isBusy = fetcher.state !== 'idle';
  const outcome = fetcher.data;
  const messageKey = outcome === undefined ? null : OUTCOME_MESSAGE_KEY[outcome.state];
  const isSignInPrompt = outcome?.state === 'unauthenticated';

  function cast(value: VoteChoice): void {
    const body = new FormData();
    body.set('enrichmentId', props.enrichmentId);
    body.set('value', String(value));
    void fetcher.submit(body, { method: 'post', action: '/api/enrichment-vote' });
  }

  return (
    <div className="mt-1">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant={shown.myVote === 1 ? 'secondary' : 'ghost'}
            size="icon-sm"
            aria-label={t('enrichment.voteUp')}
            aria-pressed={shown.myVote === 1}
            disabled={isBusy}
            onClick={() => cast(1)}
          >
            <ThumbsUp aria-hidden="true" />
          </Button>
          {/* The counts sit OUTSIDE the buttons. Inside, the `aria-label` would
              replace them and a screen reader would hear the action and never
              the score. */}
          <span className="text-xs tabular-nums text-muted-foreground">{shown.up}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant={shown.myVote === -1 ? 'secondary' : 'ghost'}
            size="icon-sm"
            aria-label={t('enrichment.voteDown')}
            aria-pressed={shown.myVote === -1}
            disabled={isBusy}
            onClick={() => cast(-1)}
          >
            <ThumbsDown aria-hidden="true" />
          </Button>
          <span className="text-xs tabular-nums text-muted-foreground">{shown.down}</span>
        </div>
      </div>

      {/* THE WHOLE SENTENCE IS THE LINK, and that is not a style choice. A
          separate "Sign in" label would be a word this component invented, and
          `app/locales` has no key for one. Linking the sentence keeps the prompt
          translated and still gives the reader the way in. */}
      {messageKey !== null && isSignInPrompt && (
        <p className="mt-2 text-xs">
          <Link to="/login" className="text-muted-foreground underline underline-offset-2 hover:text-foreground">
            {t(messageKey)}
          </Link>
        </p>
      )}
      {messageKey !== null && !isSignInPrompt && (
        <p className="mt-2 text-xs text-muted-foreground">{t(messageKey)}</p>
      )}
    </div>
  );
}
