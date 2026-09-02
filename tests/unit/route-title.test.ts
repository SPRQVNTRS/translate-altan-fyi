import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { UIMatch } from 'react-router';
import { z } from 'zod';
import { routeTitle, type TitleHandle } from '#app/lib/route-title';

/**
 * The chrome's `h1` comes from `routeTitle(useMatches(), t)`, so these cases are
 * written against the REAL router shape rather than a convenient one.
 *
 * The fixtures are typed `UIMatch`, which is what `useMatches()` returns. That
 * is the whole point of this file: the first version of `routeTitle` read a
 * field called `data`, React Router 8 calls it `loaderData`, and every match
 * therefore answered `undefined`. The `titleKey` branch never touches loader
 * data, so `/search` looked correct while `/entry/:headwordId` silently fell
 * back to the wordmark. A fixture that invented its own field name would have
 * passed against the broken code, so `UIMatch` is what pins the name here.
 */

/** The entry route's handle, copied shape for shape from the route module. */
const EntryTitleSchema = z.object({ entry: z.object({ lemma: z.string() }).nullish() });
const entryHandle = {
  title: (data) => {
    const parsed = EntryTitleSchema.safeParse(data);
    if (!parsed.success) return null;
    return parsed.data.entry?.lemma ?? null;
  },
} satisfies TitleHandle;

/** The search route's handle, likewise. */
const searchHandle = { titleKey: 'nav.search' } satisfies TitleHandle;

/** What that loader actually returns for a found entry, trimmed to the fields under test. */
const entryLoaderData = {
  entry: { lemma: 'Haus', languageCode: 'de', pos: 'noun', senses: [] },
  examples: [],
  direction: null,
  to: 'en',
};

const rootMatch: UIMatch = { id: 'root', pathname: '/', params: {}, loaderData: { language: 'en' }, handle: undefined };
const layoutMatch: UIMatch = { id: '_app', pathname: '/', params: {}, loaderData: undefined, handle: undefined };

/** The key-echoing translator: a returned key proves which branch answered. */
const echo = (key: string): string => key;

describe('routeTitle', () => {
  it('returns the headword lemma for the entry route handle and its loader data', () => {
    const entryMatch: UIMatch = {
      id: 'routes/entry.$headwordId',
      pathname: '/entry/1f91d9dc-946d-412b-a23e-c4a639f27dae',
      params: { headwordId: '1f91d9dc-946d-412b-a23e-c4a639f27dae' },
      loaderData: entryLoaderData,
      handle: entryHandle,
    };

    assert.equal(routeTitle([rootMatch, layoutMatch, entryMatch], echo), 'Haus');
  });

  it('falls back when the entry is missing, so the header degrades rather than blanks', () => {
    const missingMatch: UIMatch = {
      id: 'routes/entry.$headwordId',
      pathname: '/entry/unknown',
      params: { headwordId: 'unknown' },
      loaderData: { entry: null, examples: [], direction: null, to: 'en' },
      handle: entryHandle,
    };

    assert.equal(routeTitle([rootMatch, layoutMatch, missingMatch], echo), undefined);
  });

  it('resolves a static titleKey through the translator', () => {
    const searchMatch: UIMatch = {
      id: 'routes/search',
      pathname: '/search',
      params: {},
      loaderData: { q: '', direction: null, hits: [] },
      handle: searchHandle,
    };

    assert.equal(routeTitle([rootMatch, layoutMatch, searchMatch], echo), 'nav.search');
  });

  it('takes the deepest match that supplies a title', () => {
    const shallow: UIMatch = { id: '_app', pathname: '/', params: {}, loaderData: undefined, handle: searchHandle };
    const deep: UIMatch = {
      id: 'routes/entry.$headwordId',
      pathname: '/entry/x',
      params: {},
      loaderData: entryLoaderData,
      handle: entryHandle,
    };

    assert.equal(routeTitle([rootMatch, shallow, deep], echo), 'Haus');
  });

  it('ignores a match whose handle is not a title handle at all', () => {
    const breadcrumbMatch: UIMatch = {
      id: 'routes/dashboard',
      pathname: '/dashboard',
      params: {},
      loaderData: undefined,
      handle: { breadcrumb: 'Dashboard' },
    };

    assert.equal(routeTitle([rootMatch, breadcrumbMatch], echo), undefined);
  });
});
