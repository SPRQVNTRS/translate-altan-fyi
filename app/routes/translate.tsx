import type { Route } from './+types/translate';
import { redirect, type MetaFunction } from 'react-router';
import { DailyNudge } from '#app/components/daily-nudge';
import { LandingDoors, LandingExampleCard, LandingPrivacyNote } from '#app/components/landing';
import { PersistLanguagePair } from '#app/components/persist-language-pair';
import { RecordSearch } from '#app/components/personal/record-search';
import { SearchPanes } from '#app/components/search-panes';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { resolveRequestLanguage } from '#app/i18n/language-prefs';
import { detectLanguage } from '#app/lib/dictionary/detect-language';
import { suggestDidYouMean } from '#app/lib/dictionary/did-you-mean';
import { entrySensesQuery } from '#app/lib/dictionary/entry.server';
import { loadLandingExample } from '#app/lib/dictionary/landing-example';
import { reconcilePairWithDirection, resolveLanguagePair } from '#app/lib/dictionary/language-pair';
import { normalizeForLanguage, normalizeQuery } from '#app/lib/dictionary/normalize';
import { resolveTriggeredPanel } from '#app/lib/enrichment/trigger.server';
import { resolveTriggeredTranslationPanel, type TranslationPanel } from '#app/lib/translation/panel.server';
import type { TitleHandle } from '#app/lib/route-title';
import { searchHeadwords, searchPhrase } from '#app/lib/dictionary/search.server';
import { resolveUser } from '#app/middleware/auth';
import type { AuthenticatedUser } from '#app/middleware/helpers';
import { SIGN_IN_PATH } from '#app/lib/auth/paths';
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
 * also reachable at `/translate`, which it does not. The handle names it once for
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
/**
 * The signed-in user, or a redirect to the sign-in page carrying `?next=`.
 *
 * IT THROWS RATHER THAN RETURNING A FLAG, so a caller cannot forget to act on
 * the answer, and the throw is a `Response` the router turns into an ordinary
 * 302.
 *
 * @param request the incoming request.
 * @returns the signed-in user.
 * @throws a `redirect` Response when nobody is signed in.
 */
async function requireSignedIn(request: Request): Promise<AuthenticatedUser> {
  const user = await resolveUser(request);
  if (user !== null) return user;
  const url = new URL(request.url);
  throw redirect(`${SIGN_IN_PATH}?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
}

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
  //   `/translate` are two route ids over THIS ONE FILE (`app/routes.ts`), and the
  //   product's real URL is `/?q=<word>`, the index carrying a query. A rule
  //   hung off `/translate` would gate the alias and leave the primary open, which
  //   is precisely the bug this milestone was written to fix; a rule on the
  //   `_app` layout would gate `/` as well and break the public landing render
  //   below. A rule inside the one loader both ids share can do neither, and a
  //   third alias inherits it for free.
  //
  //   IT THROWS A REDIRECT to `/sign-in`, carrying `?next=` so the reader lands
  //   back on the search they asked for. It does not return a flag, so there is
  //   no way to forget to act on the answer, and the
  //   throw is a `Response` the router turns into an ordinary 302. Nothing here
  //   touches the device's own store: the gate blocks the screen, and a
  //   visitor's local lists and history are untouched by the redirect.
  const user = q === '' ? null : await requireSignedIn(request);

  // WHO IS READING, ASKED SEPARATELY AND ONLY ON THE OPEN BRANCH.
  //   The gate above answers "may this request search", and on the landing
  //   branch it deliberately does not ask. The screen still needs to know
  //   whether somebody is signed in, for one reason: the doors above the pane
  //   invite a reader to create an account they already hold.
  //
  //   IT IS THE SAME READ THE ROOT LOADER ALREADY MADE, so the two cannot
  //   disagree about whether the header shows an address while the pane shows
  //   the doors.
  //
  //   IT GATES NOTHING. Nothing below reads it, and nothing may: the moment a
  //   decision that costs money is taken from this boolean, an unvalidated
  //   cookie has become a credential.
  const signedIn = user !== null || (await resolveUser(request)) !== null;

  const db = getRawDb();
  // The UI language comes from the request cookie, not from the i18next
  // singleton: that instance is process-wide and would leak one reader's
  // language into another reader's request.
  const cookieHeader = request.headers.get('cookie');
  const uiLanguage = resolveRequestLanguage(cookieHeader);
  // THE PAIR THE BAR IS SET TO, WHICH IS NOT THE SAME QUESTION AS THE
  //   DIRECTION THE SEARCH RAN IN. The pair carries the reader's own statement,
  //   `detect` included; the direction is what that statement resolved to once
  //   the query was looked at. The screen needs both: the bar shows the
  //   statement, and the results show the resolution.
  //
  //   THE URL WINS, THEN THE COOKIE, THEN THE DEFAULT. A shared result link has
  //   to render the pair it was captured with rather than the pair the device
  //   opening it prefers. The cookie is the device's own mirror of the TinyBase
  //   store, and it exists because the server renders this bar in the first
  //   byte of HTML and cannot read IndexedDB.
  const pair = resolveLanguagePair({
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
    cookieHeader,
  });
  const direction = await detectLanguage(db, {
    q,
    // `detect` is not a served language, so `chooseDirection` ignores it and
    // falls through to the exact-hit count and the character heuristic. That is
    // the whole server-side handling of detection, and it needs no branch here.
    from: pair.source,
    to: pair.target,
    uiLanguage,
  });
  // NO QUERY MEANS THIS IS THE LANDING PAGE, so the loader spends one query on
  // the worked example the pitch below the search box shows. It is a real row of
  // the dictionary, looked up through the same function a visitor's own search
  // uses, which is the point: the landing page cannot keep advertising a
  // dictionary that has stopped answering.
  if (q === '') {
    const example = await loadLandingExample((params) => searchHeadwords(db, params));
    // NOT RECONCILED, AND THAT IS RIGHT. `direction` here is only what an empty
    // query would resolve to if it were searched; nothing below this branch
    // reads it, and no search ran to have used it. Reconciling `pair` against a
    // direction nobody searched with would report a target for a search that
    // never happened.
    return {
      q,
      direction,
      pair,
      signedIn,
      hits: [],
      phrase: null,
      didYouMean: null,
      example,
      phraseWordsOmitted: 0,
      panel: null,
      // Nothing was searched for, so there is no word to translate and no pane
      // to feed. It is NOT `no-entry`, which is the answer to a real query that
      // matched no headword.
      translationPanel: null,
      translationHeadwordId: null,
    };
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
  // THE PAIR THE BAR SHOWS FOR THIS ANSWER, RECONCILED WITH THE SEARCH THAT
  //   ACTUALLY RAN. `pair` above is the reader's own statement and `direction`
  //   is what that statement resolved to; from here on the two branches below
  //   have run a real search, so the bar has to show the side that search used,
  //   not the side the reader merely stated. See `reconcilePairWithDirection`
  //   for the collision this fixes.
  const resolvedPair = reconcilePairWithDirection(pair, direction);

  const query = normalizeQuery(q, direction.from);
  if (query.isPhrase) {
    const phrase = await searchPhrase(db, { q, from: direction.from, to: direction.to });
    const phraseWordsOmitted = query.tokens.length - phrase.tokens.length;
    return {
      q,
      direction,
      pair: resolvedPair,
      signedIn,
      hits: [],
      phrase,
      didYouMean: null,
      example: null,
      phraseWordsOmitted,
      panel: null,
      // A phrase triggers no generation at all (decision 8). The pane is not
      // rendered on this branch, and passing it a panel would be the first step
      // towards a phrase costing one model call per word.
      translationPanel: null,
      translationHeadwordId: null,
    };
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
  // WHICH WORD THE TWO PANELS ARE ABOUT, DECIDED ONCE (decision 1).
  //   `searchHeadwords` returns exact matches before fuzzy ones, but "first hit"
  //   and "the word the reader typed" are not the same thing: a query can match
  //   a longer headword ahead of its own exact lemma once the fuzzy branch
  //   contributes. The exact lemma is preferred and `hits[0]` is the fallback,
  //   and the choice is read ONCE here and carried out to the pane, so the panel
  //   and the id the pane polls with cannot come from two reads of one array.
  //
  //   THE COMPARISON GOES THROUGH THE SAME NORMALISER THE IMPORTER USED to write
  //   `headwords.lemma_normalized`. Comparing raw lemmas would miss the German
  //   and Turkish rows whose stored form differs from their spelling, which is
  //   exactly the set of words this milestone is about.
  const topHit = hits[0];
  const chosenHit = hits.find((hit) => normalizeForLanguage(hit.lemma, direction.from) === query.normalized) ?? topHit;

  // The senses the enrichment panel covers, read here because a search hit does
  // not carry them: `SearchHit` is a lemma with its glosses and examples. It is
  // one indexed query on the single-word branch only.
  const senseIds =
    chosenHit === undefined ? [] : (await entrySensesQuery(db, chosenHit.headwordId)).map((row) => row.senseId);

  // THE TWO PANELS TOGETHER, IN ONE `Promise.all`. They ask different questions
  // of different tables and neither one's answer feeds the other, so running
  // them in sequence would add a round trip to the single-word branch for
  // nothing. Both are AWAITED rather than fired behind the response, and for the
  // same reason: the spend guards inside each of them decide whether a job
  // starts at all, and a decision taken after the response has gone is no
  // decision.
  const [panel, translationPanel] = await Promise.all([
    chosenHit === undefined ? null : (
      resolveTriggeredPanel({
        db,
        request,
        headwordId: chosenHit.headwordId,
        senseIds,
        from: direction.from,
        to: direction.to,
        // The reader's own votes on the rows the panel renders. It comes from
        // the session the gate above already resolved and validated, rather
        // than from a second read of the same cookie: this branch is only
        // reachable with `q !== ''`, so `user` is never null here, and
        // re-reading would risk two answers to one question in one request.
        accountId: user?.id ?? null,
      })
    ),
    // NO HEADWORD AT ALL IS `no-entry`, AND ONLY THE LOADER CAN SAY SO. Both
    // functions in `panel.server.ts` are given a headword id, so neither of them
    // can see this case. Nothing is queued for it: decision 8 says a query with
    // no matching headword creates nothing.
    chosenHit === undefined ?
      ({ state: 'no-entry' } satisfies TranslationPanel)
    : resolveTriggeredTranslationPanel(db, {
        request,
        headwordId: chosenHit.headwordId,
        from: direction.from,
        to: direction.to,
      }),
  ]);

  return {
    q,
    direction,
    pair: resolvedPair,
    signedIn,
    hits,
    phrase: null,
    didYouMean,
    example: null,
    phraseWordsOmitted: 0,
    panel,
    translationPanel,
    translationHeadwordId: chosenHit?.headwordId ?? null,
  };
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
 * it, the hero above that for a stranger, the history write beside it, and the
 * one privacy line under it. The worked example is the exception. It is handed
 * to `SearchPanes` as `emptyPane` rather than rendered here, because it belongs
 * where the answer card goes: a reader meets the box and then an answer, which
 * is the order the screen is read in.
 */
export default function TranslateRoute({ loaderData }: Route.ComponentProps) {
  const {
    q,
    direction,
    pair,
    signedIn,
    hits,
    phrase,
    didYouMean,
    example,
    phraseWordsOmitted,
    panel,
    translationPanel,
    translationHeadwordId,
  } = loaderData;

  // ONE COLUMN, ONE WIDTH, AT EVERY VIEWPORT. `max-w-2xl` and nothing wider:
  // the surface below used to widen to `max-w-5xl` from `md` up so a second
  // column had room, and there is no second column now. Letting one column of
  // content grow to five columns' worth of width puts a reading line where no
  // eye tracks it.
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      {/* Today's three words, on the home screen and nowhere else. Client only:
          it renders nothing on the server and nothing until the device's own
          store has been read, so the HTML this route sends is unchanged.

          IT IS ONLY FOR A SIGNED-IN READER, and not because a stranger would
          dislike it: reading the device's store OPENS `translate-primary` in
          IndexedDB and starts a persister polling it. Rendering this for
          everybody put that database back moments after sign-out deleted it,
          and again on every reload of this page, which a browser walk found on
          2026-09-04. A stranger also has no saved words for it to pick from,
          so the card could never have anything to show. It sits above the
          translator surface, which is the top of the single column: the day's
          words are context for the screen rather than part of the question the
          box asks. */}
      {signedIn && <DailyNudge />}

      {/* THE HERO, ABOVE THE SURFACE, AND ONLY FOR A STRANGER. It is the
          section heading under the shell's own h1, and it carries the two doors
          beneath it. Below the surface is where the doors used to be, which put
          the one thing a visitor without an account needs behind the whole
          search column. A signed-in reader sees neither this nor the privacy
          line below: both address somebody who has not joined yet. */}
      {q === '' && !signedIn && <LandingDoors />}

      <SearchPanes
        q={q}
        direction={direction}
        pair={pair}
        hits={hits}
        phrase={phrase}
        didYouMean={didYouMean}
        phraseWordsOmitted={phraseWordsOmitted}
        panel={panel}
        translationPanel={translationPanel}
        translationHeadwordId={translationHeadwordId}
        // THE WORKED EXAMPLE, WHERE THE ANSWER CARD GOES. With nothing typed
        // there is no answer to show, so that place in the column shows one. It
        // is passed for a signed-in reader too: it is a demonstration rather
        // than a pitch, and it is the only thing on an empty home screen that
        // shows the dictionary answering.
        emptyPane={example === null ? undefined : <LandingExampleCard example={example} />}
      />

      {/* The history WRITE, and it renders nothing. It is here rather than in
          the loader because the loader runs on the server, which must never
          learn what anybody looked up. It sits beside the surface rather than
          inside it because it is not part of the surface: a review page that
          renders the panes must not record searches nobody made. */}
      {/* The language pair WRITE, and it renders nothing. It is here rather
          than inside `SearchPanes` for the reason `RecordSearch` is: a
          sessionless render of the surface must not write to the device. It
          writes both copies, the device store and the cookie the server reads
          on the next request. */}
      <PersistLanguagePair pair={pair} />

      <RecordSearch query={q} from={direction.from} to={direction.to} headwordId={hits[0]?.headwordId ?? null} />

      {/* ONE LINE, AND IT IS NOT A PITCH. The three sentences that described
          the product under the surface are gone: the hero above already says
          what this is, and saying it twice more is what made this screen read
          as three loose blocks. What is left is the privacy sentence, which
          carries both halves, and it is for a stranger only. */}
      {q === '' && !signedIn && <LandingPrivacyNote />}
    </div>
  );
}
