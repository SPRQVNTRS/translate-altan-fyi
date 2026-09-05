import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useFetcher } from 'react-router';
import { ThumbsDown, ThumbsUp } from 'lucide-react';

import { Link } from '#app/components/link';
import { Button } from '#app/components/ui/button';
import { applyVote, submittedVote, type VoteChoice, type VoteTallyView } from '#app/lib/votes/optimistic';
import type { TranslationVoteOutcome } from '#app/routes/api.translation-vote';

/**
 * The two vote controls on ONE translated word.
 *
 * A VOTE JUDGES ONE EDGE, NOT THE WHOLE ANSWER.
 *   Seven Turkish words for `umwerfen` are seven separate claims, and a reader
 *   who thinks one of them is wrong is saying so about that one. `translationId`
 *   names a single dictionary edge and is the only identifier that crosses the
 *   wire, which is what keeps `translation_votes` free of any dictionary term:
 *   the row this posts is an opinion about an assertion, never a record that
 *   this reader looked this word up.
 *
 * IT IS DELIBERATELY SMALLER THAN `EnrichmentVotes`.
 *   That control sits once under a paragraph of study notes and can afford a
 *   block. This one sits on EVERY row of an answer, so it is two icon buttons
 *   and two numbers on the same baseline as the word, and the confirmation line
 *   the enrichment control prints after every vote is left out: seven copies of
 *   "your vote was counted" under seven words is noise, and the pressed button
 *   already says it.
 *
 * THE BUTTONS ARE SHOWN TO EVERYONE, INCLUDING A READER WITH NO ACCOUNT.
 *   Hiding them from a signed-out visitor would hide the fact that voting exists
 *   at all, and nobody signs in for a feature they were never shown. So the
 *   control is always on the page and the gate speaks only when it is used.
 *
 * NO ENGLISH IS WRITTEN HERE. Every line a reader can see comes from
 * `app/locales`. The `invalid` outcome is deliberately silent: it cannot be
 * produced by these buttons, and copy invented for it would be one untranslated
 * sentence in a translated page.
 */

export interface TranslationVotesProps {
  translationId: string;
  up: number;
  down: number;
  myVote: -1 | 1 | null;
}

/**
 * The score the server last confirmed, or `null` when it has confirmed none.
 *
 * The two refusal outcomes carry no counts, because nothing was written, so they
 * must fall back to the loader's figures rather than to zeroes. Zeroes would
 * blank a real score every time a signed-out reader clicked.
 */
function settledTally(outcome: TranslationVoteOutcome | undefined): VoteTallyView | null {
  if (outcome === undefined) return null;
  if (outcome.state === 'unauthenticated') return null;
  if (outcome.state === 'invalid') return null;
  return { up: outcome.up, down: outcome.down, myVote: outcome.myVote };
}

export function TranslationVotes(props: TranslationVotesProps): ReactNode {
  const { t } = useTranslation();
  const fetcher = useFetcher<TranslationVoteOutcome>();

  // The loader's figures are the floor. They survive a reload, which is what
  // makes the reader's own vote persist: `myVote` is read per account in the
  // corpus query, so a fresh page already knows which button is pressed.
  const loaded: VoteTallyView = { up: props.up, down: props.down, myVote: props.myVote };
  const settled = settledTally(fetcher.data) ?? loaded;
  const inFlight = submittedVote(fetcher.formData);
  const shown = inFlight === null ? settled : applyVote(settled, inFlight);

  const isBusy = fetcher.state !== 'idle';
  const isSignInPrompt = fetcher.data?.state === 'unauthenticated';

  function cast(value: VoteChoice): void {
    const body = new FormData();
    body.set('translationId', props.translationId);
    body.set('value', String(value));
    void fetcher.submit(body, { method: 'post', action: '/api/translation-vote' });
  }

  return (
    <span className="flex items-center gap-1">
      <Button
        type="button"
        variant={shown.myVote === 1 ? 'secondary' : 'ghost'}
        size="icon-sm"
        aria-label={t('translationVote.up')}
        aria-pressed={shown.myVote === 1}
        disabled={isBusy}
        onClick={() => cast(1)}
      >
        <ThumbsUp aria-hidden="true" />
      </Button>
      {/* The counts sit OUTSIDE the buttons. Inside, the `aria-label` would
          replace them and a screen reader would hear the action and never the
          score. */}
      <span className="text-xs tabular-nums text-muted-foreground">{shown.up}</span>

      <Button
        type="button"
        variant={shown.myVote === -1 ? 'secondary' : 'ghost'}
        size="icon-sm"
        aria-label={t('translationVote.down')}
        aria-pressed={shown.myVote === -1}
        disabled={isBusy}
        onClick={() => cast(-1)}
      >
        <ThumbsDown aria-hidden="true" />
      </Button>
      <span className="text-xs tabular-nums text-muted-foreground">{shown.down}</span>

      {/* THE WHOLE SENTENCE IS THE LINK, and that is not a style choice. A
          separate "Sign in" label would be a word this component invented, and
          `app/locales` has no key for one. Linking the sentence keeps the prompt
          translated and still gives the reader the way in.

          IT APPEARS ONLY AFTER A REFUSED CLICK, and only on the row that was
          clicked. A prompt printed under every word would turn an answer into a
          sign-up wall, which is exactly what the enrichment control's own
          comment forbids. */}
      {isSignInPrompt && (
        <Link
          to="/sign-in"
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {t('translationVote.signIn')}
        </Link>
      )}
    </span>
  );
}
