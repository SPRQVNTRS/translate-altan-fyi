/**
 * The two doors are on the home page, and the old paths still lead to them
 * (M189).
 *
 * WHY THIS CASE EXISTS
 *   M184 made an account mandatory for every search and left the older rule in
 *   place that `/` must prompt nobody to sign up. The result passed every gate
 *   in the repo: the landing page answered 200, carried a real worked example,
 *   and gave a stranger no way in at all. A status assertion cannot see that,
 *   and neither can a typecheck, a lint or a build. So this case asserts the
 *   DOORS, in the rendered HTML, the way a reader meets them.
 *
 * IT RENDERS THE WHOLE ROUTE WITH THE REAL LOADER'S DATA, AND IT ASSERTS THE
 * ORDER. The doors used to live inside `Landing`, which `search.tsx` renders
 * BELOW the two-pane surface, so on a phone the card a stranger needs sat off
 * the first screen behind a search box they may not use. A test that only
 * asked "is the link in the HTML" passed throughout. So this renders
 * `SearchRoute` itself, through `createRoutesStub` because the surface calls
 * `useNavigation` and needs a data router, and compares the two positions in
 * the document. Asserting the `href` and the `<textarea` rather than the
 * labels is deliberate: the copy is translated and will be rewritten, the
 * destinations and the box are the contract.
 *
 * THE REDIRECT CASES ARE ABOUT WHAT IS ALREADY IN THE WORLD. `/sync/login` and
 * `/sync/setup` are in bookmarks, in browser histories and in at least one
 * invite somebody pasted into a chat, and an invite travels as
 * `?invite=<token>`. So the hop is permanent AND it keeps the query string; a
 * hop that dropped it would read to the invited person as a dead invite.
 *
 * NO ROW IS CREATED, READ DESTRUCTIVELY, OR DELETED. Every case only reads.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else: the
 * landing case drives the real loader, which queries the dictionary for its
 * worked example. The two redirect cases need nothing, and declare the same
 * guard so `tests/unit/integration-tests-self-skip.test.ts` counts them.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { createRoutesStub, RouterContextProvider } from 'react-router';

import enCommon from '#app/locales/en/common.json';
import { closePool, poolInitialized } from '../../drizzle/db';
import SearchRoute, { loader as searchLoader } from '../../app/routes/search';
import { loader as signInRedirectLoader } from '../../app/routes/sync.login-redirect';
import { loader as signUpRedirectLoader } from '../../app/routes/sync.setup-redirect';

const DB_HOST = process.env.DB_HOST;

/** The English catalogue in a bare i18next instance: no cookie detector, no singleton. */
function englishInstance() {
  const instance = createInstance();
  void instance.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { common: enCommon } },
    defaultNS: 'common',
    ns: ['common'],
    interpolation: { escapeValue: false },
  });
  return instance;
}

/**
 * The arguments the router hands a loader, for one URL.
 *
 * The two hops have generated argument types that are nominally different, one
 * per route id, so a shared helper taking "a loader" would not typecheck. This
 * builds the ARGUMENT instead, which both accept.
 */
function loaderArgs(input: { url: string; pattern: string }) {
  const request = new Request(input.url);
  return {
    request,
    url: new URL(request.url),
    params: {},
    pattern: input.pattern,
    context: new RouterContextProvider(),
  };
}

/**
 * The home screen as a browser would receive it, for one loader answer.
 *
 * THROUGH A ROUTER STUB, NOT A BARE `MemoryRouter`. The input pane reads
 * `useNavigation` to show its pending state, and that hook needs a DATA router:
 * a plain `MemoryRouter` throws. The stub carries no loader of its own, so the
 * render is synchronous and `renderToStaticMarkup` sees the finished tree.
 */
function renderRoute(loaderData: Awaited<ReturnType<typeof searchLoader>>): string {
  const Stub = createRoutesStub([
    {
      path: '/',
      Component: () =>
        createElement(SearchRoute, {
          loaderData,
          actionData: undefined,
          params: {},
          // SAFETY: the component destructures `loaderData` and reads nothing
          // else. `matches` is a tuple of the root and layout modules with
          // their own loader data, which this case would have to invent, and
          // inventing it would assert nothing about the order below.
          matches: [] as never,
        }),
    },
  ]);

  return renderToStaticMarkup(
    createElement(I18nextProvider, { i18n: englishInstance() }, createElement(Stub, { initialEntries: ['/'] })),
  );
}

after(async () => {
  // THE POOL FINISHES OPENING BEFORE IT IS CLOSED. `drizzle/db.ts` kicks off
  // `ensureHostIndexes` behind `poolInitialized` at import time, and a short
  // test file can reach `closePool()` first, which turns a passing run into
  // "Cannot use a pool after calling end on the pool" reported as a failure.
  await poolInitialized;
  await closePool();
});

describe('the front door an anonymous visitor is shown', () => {
  it(
    'puts the way in above the search box, not below it',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const request = new Request('https://translate.altan.fyi/');
      const loaderData = await searchLoader({
        request,
        url: new URL(request.url),
        params: {},
        pattern: '/',
        context: new RouterContextProvider(),
      });

      // The landing branch, identified by what it returned rather than by what
      // it was asked. A redirect here would have thrown instead.
      assert.equal(loaderData.q, '', 'a request with no query did not take the landing branch');
      assert.equal(loaderData.signedIn, false, 'a request carrying no cookie was reported as signed in');

      const html = renderRoute(loaderData);
      const doorAt = html.indexOf('href="/sign-up"');
      const boxAt = html.indexOf('<textarea');

      assert.notEqual(
        doorAt,
        -1,
        'The home page offers an anonymous visitor no way to create an account. Every search needs one since ' +
          'M184, so this page is a wall: the reader sees a working demonstration and no door.',
      );
      assert.ok(html.includes('href="/sign-in"'), 'The home page offers a returning reader no way to sign in.');
      assert.notEqual(boxAt, -1, 'the home page rendered no search box at all, so this ordering claim means nothing');
      assert.ok(
        doorAt < boxAt,
        'The way in is below the search box in the document. On a phone the panes stack, so the card a visitor ' +
          'without an account needs is then off the first screen, behind a box they cannot usefully use.',
      );
    },
  );

  it(
    'shows a signed-in reader neither the doors nor the pitch',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const request = new Request('https://translate.altan.fyi/');
      const anonymous = await searchLoader({
        request,
        url: new URL(request.url),
        params: {},
        pattern: '/',
        context: new RouterContextProvider(),
      });

      // THE SIGNED-IN RENDER, FROM THE ANONYMOUS LOADER'S OWN DATA. Only the
      // one flag differs, so nothing else can explain a difference below, and
      // the case needs no account and no cookie to state its claim.
      const html = renderRoute({ ...anonymous, signedIn: true });

      assert.ok(
        !html.includes('href="/sign-up"'),
        'A reader who is signed in is still being invited to create an account.',
      );
      assert.ok(
        html.includes('<textarea'),
        'The signed-in home page lost the search box, which is the one thing it is for.',
      );
      assert.ok(
        html.includes('href="/entry/'),
        'The signed-in home page lost the worked example. It is a demonstration rather than a pitch, and it is ' +
          'all that is left on an empty screen once the doors and the three sentences are gone.',
      );
    },
  );

  it(
    'sends /sync/login on to /sign-in, permanently',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const response = await signInRedirectLoader(
        loaderArgs({ url: 'https://translate.altan.fyi/sync/login', pattern: '/sync/login' }),
      );

      assert.equal(response.status, 301);
      assert.equal(response.headers.get('location'), '/sign-in');
    },
  );

  it(
    'sends /sync/setup on to /sign-up and keeps the query string',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const response = await signUpRedirectLoader(
        loaderArgs({ url: 'https://translate.altan.fyi/sync/setup?x=1', pattern: '/sync/setup' }),
      );

      assert.equal(response.status, 301);
      assert.equal(
        response.headers.get('location'),
        '/sign-up?x=1',
        'The hop dropped the query string. An invite travels as `?invite=<token>`, so a reader following one ' +
          'would land on a signup form with nothing to admit them, which reads as a dead invite.',
      );
    },
  );
});
