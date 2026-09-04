import type { Route } from './+types/search';
import type { MetaFunction } from 'react-router';
import { DailyNudge } from '#app/components/daily-nudge';
import { Landing, LandingDoors } from '#app/components/landing';
import { RecordSearch } from '#app/components/personal/record-search';
import { SearchPanes } from '#app/components/search-panes';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { resolveRequestLanguage } from '#app/i18n/language-prefs';
import { detectLanguage } from '#app/lib/dictionary/detect-language';
import { suggestDidYouMean } from '#app/lib/dictionary/did-you-mean';
import { entrySensesQuery } from '#app/lib/dictionary/entry.server';
import { loadLandingExample } from '#app/lib/dictionary/landing-example';
import { normalizeQuery } from '#app/lib/dictionary/normalize';
import { resolveTriggeredPanel } from '#app/lib/enrichment/trigger.server';
import type { TitleHandle } from '#app/lib/route-title';
import { searchHeadwords, searchPhrase } from '#app/lib/dictionary/search.server';
import { readAccountHandleForDisplay, requireAccountSession } from '#app/services/account-session.server';
import { getRawDb } from '#drizzle/db';

// `meta()` runs outside the React tree, so it has no `t`. It goes through the
// pure `meta-title` seam instead, which reads the language off the ROOT loader
// rather than the process-wide i18next singleton. See that module for why the
// singleton is a cross-request bug here.
export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: metaTitle(language, 'search.metaTitle') },
    { name: 'description', content: metaTitle(language, 'search.metaDescription') },
  ];
};

/**
 * The name of this screen, for the chrome's `h1`.
 *
 * Search lives at `/`, which the nav catalog does carry, but the same screen is
 * also reachable at `/search`, which it does not. The handle names it once for
 * both, and reuses the catalog's own label so the header and the sidebar can
 * never disagree.
 */
export const handle = { titleKey: 'nav.search' } satisfies TitleHandle;

/**
 * The search itself, from the URL.
 *
 * `q`, `from` and `to` are search parameters and nothing else, so a result page
 * is linkable, shareable and correct under the back button. There is no client
 * state here at all.
 *
 * The dictionary tables are GLOBAL, shared by every reader, so this reads
 * through `getRawDb()`. There is one shared corpus and no organisation to
 * scope it to (ADR-0010).
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') ?? '').trim();

  // THE ACCOUNT GATE, AND IT IS KEYED ON THE REQUEST RATHER THAN ON THE PATH.
  //   This one line is what M184 is for. A typed search is the entrance to
  //   every LLM call this product makes: the single-word branch below hands the
  //   top hit to `resolveTriggeredPanel`, which queues a billed enrichment job,
  //   and opening a word from a phrase result queues another. An empty `q` does
  //   none of that, so it stays open to everyone.
  //
  //   IT SITS HERE, ABOVE EVERYTHING, ON PURPOSE. Before `getRawDb()`, before
  //   the language detection, before `searchPhrase`, before `searchHeadwords`
  //   and before the enrichment call at the foot of this loader. A signed-out
  //   request therefore costs one cookie unseal and one indexed token lookup,
  //   and reaches no dictionary query and no queue.
  //
  //   IT CANNOT BE A LAYOUT MIDDLEWARE, AND IT MUST NOT BE A PATH RULE. `/` and
  //   `/search` are two route ids over THIS ONE FILE (`app/routes.ts`), and the
  //   product's real URL is `/?q=<word>`, the index carrying a query. A rule
  //   hung off `/search` would gate the alias and leave the primary open, which
  //   is precisely the bug this milestone was written to fix; a rule on the
  //   `_app` layout would gate `/` as well and break the public landing render
  //   below. A rule inside the one loader both ids share can do neither, and a
  //   third alias inherits it for free.
  //
  //   `requireAccountSession` THROWS A REDIRECT to `/sign-in`. It does not
  //   return a flag, so there is no way to forget to act on the answer, and the
  //   throw is a `Response` the router turns into an ordinary 302. Nothing here
  //   touches the device's own store: the gate blocks the screen, and a
  //   visitor's local lists and history are untouched by the redirect.
  const account = q === '' ? null : await requireAccountSession(request);

  // WHO IS READING, ASKED SEPARATELY AND ONLY ON THE OPEN BRANCH.
  //   The gate above answers "may this request search", and on the landing
  //   branch it deliberately does not ask. The screen still needs to know
  //   whether somebody is signed in, for one reason: the doors above the pane
  //   invite a reader to create an account they already hold.
  //
  //   IT IS A DISPLAY QUESTION, SO IT IS ANSWERED BY THE DISPLAY READ.
  //   `readAccountHandleForDisplay` unseals the signed cookie and resolves no
  //   token, so the public landing page costs no extra query, and the answer
  //   here is the same one the chrome's header already renders from the ROOT
  //   loader. A stale cookie therefore hides the doors and keeps the name in
  //   the header, which is one wrong answer rather than two disagreeing ones,
  //   and the first search still redirects to `/sign-in` as it always did.
  //
  //   IT GATES NOTHING. Nothing below reads it, and nothing may: the moment a
  //   decision that costs money is taken from this boolean, an unvalidated
  //   cookie has become a credential.
  const signedIn = account !== null || (await readAccountHandleForDisplay(request)) !== null;

  const db = getRawDb();
  // The UI language comes from the request cookie, not from the i18next
  // singleton: that instance is process-wide and would leak one reader's
  // language into another reader's request.
  const uiLanguage = resolveRequestLanguage(request.headers.get('cookie'));
  const direction = await detectLanguage(db, {
    q,
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
    uiLanguage,
  });
  // NO QUERY MEANS THIS IS THE LANDING PAGE, so the loader spends one query on
  // the worked example the pitch below the search box shows. It is a real row of
  // the dictionary, looked up through the same function a visitor's own search
  // uses, which is the point: the landing page cannot keep advertising a
  // dictionary that has stopped answering.
  if (q === '') {
    const example = await loadLandingExample((params) => searchHeadwords(db, params));
    return { q, direction, signedIn, hits: [], phrase: null, didYouMean: null, example, phraseWordsOmitted: 0, panel: null };
  }

  // ONE PIPELINE, TWO BRANCHES, AND THE BRANCH IS DECIDED HERE.
  //   A phrase is not a longer word: it is in no headword column, so the
  //   single-word path can only answer it by coincidence. `searchPhrase`
  //   answers with what the dictionary does know, each word's entry and the
  //   recorded sentences carrying the whole phrase, and the screen says that is
  //   what it is showing.
  //
  //   A spoken query reaches this same line. `VoiceInput` writes the
  //   recogniser's text into the search box and submits the form, so there is
  //   no second query path for speech and nothing here can tell the two apart.
  //
  // WHAT PHRASE-FIRST COSTS: NOTHING NEW AT SEARCH TIME. Verified 2026-09-03 by
  //   reading `searchPhrase` in `app/lib/dictionary/search.server.ts` end to
  //   end: it does NOT enqueue any enrichment job, and it makes no LLM call of
  //   any kind. It runs `searchHeadwords` once per looked-up word plus one
  //   example query, all of them plain SQL. So a translator-shaped box, which
  //   makes this the MAIN path rather than the edge case it used to be, adds no
  //   new provider spend by itself. Said the other way round: phrase-first is
  //   no new LLM cost at search time. The only warm on this whole screen is the
  //   single-word branch's top-hit call below.
  //
  //   The cost surface that DOES move is downstream and is not this route's:
  //   opening a word FROM a phrase result enriches that word, so a long phrase
  //   can cost per word if the reader opens them. What bounds that is M184's
  //   invite gate and budget cap, not anything here. Do not "fix" this by
  //   warming the phrase's words: that is the exact multiplication the comment
  //   on the single-word branch below refuses.
  //
  //   THE WORD LIST IS CAPPED AND THE SCREEN SAYS SO. `searchPhrase` looks up
  //   at most `PHRASE_TOKEN_LIMIT` words, so a pasted paragraph gets entries
  //   for its first few words and silence about the rest. Under the old
  //   one-line box nobody typed a paragraph, so the cap was invisible.
  //   `phraseWordsOmitted` carries the difference out to the pane, which is
  //   what keeps a partly read query from rendering as a whole answer. It is
  //   computed from what the search ACTUALLY looked at rather than from the
  //   constant, so it cannot drift if the cap moves.
  const query = normalizeQuery(q, direction.from);
  if (query.isPhrase) {
    const phrase = await searchPhrase(db, { q, from: direction.from, to: direction.to });
    const phraseWordsOmitted = query.tokens.length - phrase.tokens.length;
    return { q, direction, signedIn, hits: [], phrase, didYouMean: null, example: null, phraseWordsOmitted, panel: null };
  }

  // THE WHOLE POINT OF THE DETECTION. `direction.from` and `direction.to` go
  // into the QUERY, not only into the chip above it. Passing the raw URL
  // parameters here instead would produce a correct-looking direction label
  // sitting over results drawn from the wrong side of the dictionary.
  const hits = await searchHeadwords(db, { q, from: direction.from, to: direction.to });

  // THE THIRD LAYER, AND ONLY ON A TOTAL MISS. Exact and fuzzy both found
  // nothing above the threshold, so the closest word below it is worth
  // offering. It is offered, never applied: the loader does not redirect and
  // does not re-run the search with the suggestion. See `did-you-mean.ts`.
  const didYouMean = hits.length === 0 ? await suggestDidYouMean(db, { query: q, languageCode: direction.from }) : null;

  // THE TOP HIT ONLY, AND NOW IT IS SHOWN RATHER THAN ONLY WARMED.
  //   Warming the whole result page would multiply the provider spend by ten
  //   for a reader who opens one word, and the top hit is the one they open. So
  //   the top hit is still the only word this screen enriches. What changed in
  //   M185/03 is where the answer lands: the output pane renders the panel
  //   itself, so a reader gets the translator-shaped answer without a click
  //   through to `/entry/:headwordId`.
  //
  //   THIS IS THE SAME MACHINE THE ENTRY PAGE RUNS, NOT A SECOND ONE.
  //   `resolveTriggeredPanel` reads the cache and decides whether to queue, and
  //   `entry.$headwordId.tsx` calls exactly this function with exactly these
  //   arguments. A copy here would be two screens quietly disagreeing about the
  //   same word.
  //
  //   IT IS AWAITED WHERE THE OLD WARM WAS NOT, AND IT HAS TO BE. The old call
  //   was fire and forget because nothing on this screen rendered its answer.
  //   This one IS the answer, and the two spend guards inside it decide whether
  //   a job starts at all, so a decision taken after the response had gone
  //   would be no decision. The cost is a handful of local statements, no
  //   provider call: the enqueue behind them is still fire and forget.
  const topHit = hits[0];
  const panel = topHit === undefined
    ? null
    : await resolveTriggeredPanel({
        db,
        request,
        headwordId: topHit.headwordId,
        // The senses the panel covers, read here because a search hit does not
        // carry them: `SearchHit` is a lemma with its glosses and examples. It
        // is one indexed query on the single-word branch only.
        senseIds: (await entrySensesQuery(db, topHit.headwordId)).map((row) => row.senseId),
        from: direction.from,
        to: direction.to,
        // The reader's own votes on the rows the panel renders. It comes from
        // the session the gate above already resolved and validated, rather
        // than from a second read of the same cookie: this branch is only
        // reachable with `q !== ''`, so `account` is never null here, and
        // re-reading would risk two answers to one question in one request.
        accountId: account?.accountId ?? null,
      });

  return { q, direction, signedIn, hits, phrase: null, didYouMean, example: null, phraseWordsOmitted: 0, panel };
}

/**
 * The home screen, laid out the way a translator is.
 *
 * THE SURFACE ITSELF LIVES IN `SearchPanes`, and this route is what feeds it.
 * The split is not decoration: the loader above gates every non-empty query
 * behind an account, so the only way to render an ANSWERED surface without a
 * session is to hand the answer to the component directly. M186's review page
 * did exactly that while the palette and the display face were being chosen,
 * and it rendered THIS component rather than a copy, which is what stopped the
 * reviewed surface and the shipped one from drifting apart. That page is gone
 * now, the decision is applied, and the split is worth keeping for the next
 * time a surface has to be shown to somebody without a session.
 *
 * WHAT STAYS HERE IS EVERYTHING THAT IS NOT THE SURFACE: the day's nudge above
 * it, the history write beside it, and the landing pitch under it. Each one is
 * a side effect or a screen of its own, and none of them is part of what the
 * two panes look like.
 */
export default function SearchRoute({ loaderData }: Route.ComponentProps) {
  const { q, direction, signedIn, hits, phrase, didYouMean, example, phraseWordsOmitted, panel } = loaderData;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 md:max-w-5xl">
      {/* Today's three words, on the home screen and nowhere else. Client only:
          it renders nothing on the server and nothing until the device's own
          store has been read, so the HTML this route sends is unchanged. It
          sits above the two-pane surface, which is where it sat above the
          results area before the relayout: with the answer now beside the box
          rather than under it, "above both panes" is the only position that
          still means the same thing. */}
      <DailyNudge />

      {/* THE DOORS, ABOVE THE PANE, AND ONLY FOR A STRANGER. Under the pitch is
          where they used to be, which on a phone put them below the whole
          search surface: the one thing a visitor without an account needs was
          the last thing they could reach. Above the pane they are on the first
          screen at every width. A signed-in reader sees neither these nor the
          pitch below, since both address somebody who has not joined yet. */}
      {q === '' && !signedIn && <LandingDoors />}

      <SearchPanes
        q={q}
        direction={direction}
        hits={hits}
        phrase={phrase}
        didYouMean={didYouMean}
        phraseWordsOmitted={phraseWordsOmitted}
        panel={panel}
      />

      {/* The history WRITE, and it renders nothing. It is here rather than in
          the loader because the loader runs on the server, which must never
          learn what anybody looked up. It sits beside the surface rather than
          inside it because it is not part of the surface: a review page that
          renders the panes must not record searches nobody made. */}
      <RecordSearch query={q} from={direction.from} to={direction.to} headwordId={hits[0]?.headwordId ?? null} />

      {/* The landing surface. With nothing typed there is no result to show, so
          the screen explains what a search returns and shows one, rather than
          leaving a stranger with an empty box and a full-stop. For a signed-in
          reader the explanation is dropped and the worked example is kept: they
          have already joined, and the example is a demonstration rather than a
          pitch. */}
      {q === '' && <Landing example={example} signedIn={signedIn} />}
    </div>
  );
}
