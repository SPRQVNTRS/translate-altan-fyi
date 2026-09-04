import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '#app/components/link';
import { SourceLink } from '#app/components/source-link';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { PhraseSearchResult, SearchHit, SearchHitExample } from '#app/lib/dictionary/search.server';

/**
 * How many examples a result row shows. A row is a summary, so it carries
 * enough to recognise the word and no more; the entry page shows the rest.
 */
const ROW_EXAMPLE_LIMIT = 2;

/**
 * The marker on an example whose translation is NOT in the target language.
 *
 * The query prefers examples translated into the language the reader asked
 * for, and falls back to any language only when the headword has none. A
 * fallback is still useful, but it is not what was asked for, so it says so
 * rather than quietly looking like a match.
 *
 * It lives here because the search row and the entry page show the same two
 * example lists, and one marker written twice would drift into two.
 */
export function ExampleLanguageBadge({ languageCode }: { languageCode: string }) {
  const { t } = useTranslation();
  const code = languageCode.toUpperCase();
  const label = t('entry.exampleTranslationLanguage', { language: code });

  return (
    <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground" title={label}>
      {/* The code is the whole visible badge, and two letters are not a
          sentence, so the full label is what assistive tech reads. */}
      <span aria-hidden="true">{code}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** One example sentence under a result row, quiet, with its source credit. */
function ResultExample({ example, to }: { example: SearchHitExample; to: LanguageCode }) {
  return (
    <li className="text-sm">
      <span lang={example.languageCode} className="text-muted-foreground">
        {example.text}
      </span>
      {example.translationText !== null && example.translationLanguageCode !== null && (
        <>
          <span lang={example.translationLanguageCode} className="text-muted-foreground/80">
            {' '}
            {example.translationText}
          </span>
          {example.translationLanguageCode !== to && (
            <ExampleLanguageBadge languageCode={example.translationLanguageCode} />
          )}
        </>
      )}{' '}
      <SourceLink
        sourceSlug={example.sourceSlug}
        sourceName={example.sourceName}
        sourceLicence={example.sourceLicence}
        externalId={example.externalId}
      />
    </li>
  );
}

/**
 * The target-language translations of one hit, comma separated.
 *
 * THE TRANSLATIONS ARE MONOSPACED, THE PROSE AROUND THEM IS NOT. Each one is a
 * word being quoted rather than a sentence being read, and the mono face is
 * what says so, exactly as it says so for the headword above. The separating
 * commas stay outside the span deliberately: they are punctuation belonging to
 * this list, not to any word in it.
 *
 * A GLOSS IS NOT A TRANSLATION AND IS NOT MONOSPACED. It is an explanatory
 * sentence, so it stays in the sans face with the rest of the prose. Setting it
 * in mono would claim it is a word you could write down as the answer.
 */
function ResultTranslations({ hit }: { hit: SearchHit }) {
  const { t } = useTranslation();

  if (hit.translations.length > 0) {
    return (
      <p className="text-base">
        {hit.translations.map((translation, index) => (
          <Fragment key={`${translation.sourceSlug}:${translation.headwordId}`}>
            {index > 0 && ', '}
            <span lang={translation.languageCode} className="font-mono">
              {translation.lemma}
            </span>
          </Fragment>
        ))}
      </p>
    );
  }

  // A gloss is an explanation rather than a translation, so it is the second
  // choice, not an equal one. Saying so is cheaper than pretending.
  if (hit.gloss !== null) {
    return <p className="text-sm text-muted-foreground">{hit.gloss}</p>;
  }

  return <p className="text-sm text-muted-foreground">{t('search.noTranslationYet')}</p>;
}

/** One result row: the word, what it means, and a couple of examples. */
function ResultRow({ hit, to }: { hit: SearchHit; to: LanguageCode }) {
  const { t } = useTranslation();
  const examples = hit.examples.slice(0, ROW_EXAMPLE_LIMIT);

  return (
    <li className="rounded-lg border bg-card p-4 shadow-sm transition-all duration-200 hover:border-primary/40 hover:shadow-md">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {/* The lemma is the link, not the whole card: the row also carries
            source links, and an anchor inside an anchor is invalid HTML.

            IT IS MONOSPACED, AND IT USED TO BE IN THE DISPLAY FACE. The word
            under examination is the subject of this whole screen, and the mono
            face sets it apart from every sentence around it the way quotation
            marks would, without the punctuation. The display face still owns
            the chrome (the wordmark, the page titles, the section headings);
            it no longer owns the word. */}
        <Link
          to={`/entry/${hit.headwordId}?to=${to}`}
          lang={hit.languageCode}
          className="font-mono text-lg font-semibold tracking-tight hover:text-primary"
        >
          {hit.lemma}
        </Link>
        {hit.pos !== null && <span className="text-xs text-muted-foreground">{hit.pos}</span>}
        {hit.matchKind === 'fuzzy' && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {t('search.matchFuzzy')}
          </span>
        )}
      </div>
      <div className="mt-1">
        <ResultTranslations hit={hit} />
      </div>
      {examples.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.11em] text-primary">
            {t('search.examplesLabel')}
          </p>
          <ul className="mt-1 space-y-1">
            {examples.map((example) => (
              <ResultExample key={example.id} example={example} to={to} />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

export interface SearchResultsProps {
  hits: SearchHit[];
  /** The target language, carried into each entry link so the entry opens the same way round. */
  to: LanguageCode;
}

/** The result list. Empty and no-query states belong to the route, not here. */
export function SearchResults({ hits, to }: SearchResultsProps) {
  return (
    <ul className="flex flex-col gap-3">
      {hits.map((hit) => (
        <ResultRow key={hit.headwordId} hit={hit} to={to} />
      ))}
    </ul>
  );
}

export interface DidYouMeanProps {
  /** The headword to offer, in its written form. Never the reader's own query. */
  suggestion: string;
  /** The direction the failed search ran in, carried into the corrected search. */
  from: LanguageCode;
  to: LanguageCode;
}

/**
 * The "did you mean" offer: a LINK, never an applied correction.
 *
 * The correction lives entirely in the href. Clicking it is a normal navigation
 * to a normal search URL, so the reader can see what was searched, share it,
 * and go back to their own spelling with the browser's back button. Nothing
 * here rewrites the query on the reader's behalf, and there is no redirect
 * anywhere on this path.
 *
 * `suggestion` comes from `suggestDidYouMean`, which returns `null` rather than
 * the query it was given, so this component cannot render the reader's own
 * misspelling back at them as advice.
 */
export function DidYouMean({ suggestion, from, to }: DidYouMeanProps) {
  const { t } = useTranslation();
  const href = `/search?q=${encodeURIComponent(suggestion)}&from=${from}&to=${to}`;

  return (
    <p className="text-sm text-muted-foreground">
      {t('search.didYouMeanLabel')}{' '}
      {/* The suggestion is a WORD inside a sentence, so it carries the same
          mono treatment the result rows give a headword. That is also what
          makes it visibly a different kind of thing from the label in front of
          it, which is ordinary prose. */}
      <Link
        to={href}
        lang={from}
        className="font-mono font-medium text-primary underline underline-offset-4 hover:no-underline"
        aria-label={t('search.didYouMeanAction', { suggestion })}
      >
        {suggestion}
      </Link>
    </p>
  );
}

export interface PhraseResultsProps {
  phrase: PhraseSearchResult;
  from: LanguageCode;
  to: LanguageCode;
}

/**
 * The phrase answer: what each word means, and the sentences that carry the
 * whole phrase.
 *
 * IT SAYS WHAT IT IS. The note above the word list states that there is no
 * entry for the phrase itself, because a bare list of word entries under a
 * phrase query reads as a translation of the phrase, and it is not one.
 */
export function PhraseResults({ phrase, from, to }: PhraseResultsProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="font-display text-base font-semibold">{t('search.phraseWordsHeading')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('search.phraseWordsNote')}</p>
      </div>

      {phrase.tokens.map((match) => (
        <div key={match.token} className="flex flex-col gap-2">
          {/* The token is one of the reader's own words, so it is monospaced
              like every other headword on the screen. It keeps the section
              label's size and colour, because that is the job it does here: it
              names the block of results underneath it. It does NOT keep the
              recipe's `uppercase`, which would rewrite the reader's word. */}
          <p className="font-mono text-[11px] font-semibold tracking-[0.11em] text-primary" lang={from}>
            {match.token}
          </p>
          {match.hits.length > 0 && <SearchResults hits={match.hits} to={to} />}
          {match.hits.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('search.phraseTokenNoResults', { token: match.token })}</p>
          )}
        </div>
      ))}

      <div>
        <h3 className="font-display text-base font-semibold">{t('search.phraseExamplesHeading')}</h3>
        {phrase.examples.length > 0 && (
          <ul className="mt-2 space-y-1">
            {phrase.examples.map((example) => (
              <ResultExample key={example.id} example={example} to={to} />
            ))}
          </ul>
        )}
        {phrase.examples.length === 0 && (
          <p className="mt-1 text-sm text-muted-foreground">{t('search.phraseNoExamples')}</p>
        )}
      </div>
    </div>
  );
}
