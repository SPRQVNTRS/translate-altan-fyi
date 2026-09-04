/**
 * A language pick is remembered the moment it is made, and in BOTH copies.
 *
 * THE DEFECT THIS EXISTS FOR. `LanguageBar` only submits the search form when
 * the query box is non-empty, which is right: submitting an empty box would
 * push a history entry and navigate to the page already on screen. But
 * persistence used to hang entirely off `PersistLanguagePair`, which writes the
 * pair the LOADER resolved. With no submit the loader never re-runs, so a pick
 * made on the empty landing page reached neither the cookie nor the device
 * store, and died with the tab. Reproduced on 2026-09-04: pick a target on `/`,
 * `document.cookie` still read `translate-pair=detect:en`, and a reload put the
 * select back on English.
 *
 * WHAT IS ASSERTED, AND AT WHICH LEVEL. `persistLanguagePair` is driven for
 * real against a `createPrimaryStore()` and a stand-in `document`, so the two
 * writes are exercised rather than mocked. The bar's wiring is then checked by
 * reading its source, because this repo has no DOM library and therefore no way
 * to fire a Radix select change and watch what happens. That is the same method
 * `search-panes-language-bar.test.ts` uses on the same file, and for the same
 * reason. A source check is weaker than an event check, so the assertions below
 * name the call and its position rather than looking for loose words a comment
 * could satisfy.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { LANGUAGE_PAIR_COOKIE, parseLanguagePairCookie } from '#app/lib/dictionary/language-pair';
import { createPrimaryStore, getLanguagePair, persistLanguagePair } from '#app/lib/local-store';

/** The bar's own source. The wiring cases below ask questions of its text. */
const BAR_SOURCE = readFileSync(new URL('../../app/components/language-bar.tsx', import.meta.url), 'utf8');

/**
 * Run `body` with a stand-in `document` whose only member is `cookie`, and hand
 * back whatever was last written to it.
 *
 * `writeLanguagePairCookie` guards on `globalThis.document === undefined` and
 * assigns a `Set-Cookie` style string, so a plain property is the whole browser
 * behaviour this function depends on. `defineProperty` is what installs it
 * without a type assertion, and the descriptor is removed again so one case
 * cannot see another's cookie.
 */
async function withDocument(body: () => Promise<void>): Promise<string> {
  Object.defineProperty(globalThis, 'document', { value: { cookie: '' }, configurable: true });
  try {
    await body();
    return globalThis.document.cookie;
  } finally {
    Reflect.deleteProperty(globalThis, 'document');
  }
}

describe('persistLanguagePair writes both copies', () => {
  it('writes the cookie the server renders the bar from', async () => {
    const store = createPrimaryStore();
    const raw = await withDocument(async () => {
      await persistLanguagePair({ source: 'detect', target: 'es' }, { store });
    });

    assert.equal(raw.startsWith(`${LANGUAGE_PAIR_COOKIE}=detect:es;`), true, `the cookie was written as: ${raw}`);
    // Parsed rather than string-matched, so this case pins the pair the server
    // will actually read back rather than one particular serialisation of it.
    assert.deepEqual(parseLanguagePairCookie(raw.split(';')[0] ?? ''), { source: 'detect', target: 'es' });
  });

  it('writes the device store, which is the copy that survives the tab', async () => {
    const store = createPrimaryStore();
    await withDocument(async () => {
      await persistLanguagePair({ source: 'tr', target: 'de' }, { store });
    });

    assert.deepEqual(await getLanguagePair({ store }), { source: 'tr', target: 'de' });
  });

  it('never rejects when the store cannot be opened, so a caller can fire and forget', async () => {
    // No `{ store }`, so the browser singleton is resolved and `persist.ts`'s
    // `assertBrowserWithIndexedDb` throws: exactly what a private window with
    // IndexedDB revoked does, and the failure this swallow exists for. The
    // cookie is written first and unconditionally, so the reader keeps the
    // preference for the next request even when the durable copy is gone.
    const raw = await withDocument(async () => {
      await persistLanguagePair({ source: 'en', target: 'de' });
    });

    assert.equal(raw.startsWith(`${LANGUAGE_PAIR_COOKIE}=en:de;`), true, `the cookie was written as: ${raw}`);
  });
});

describe("the bar persists the reader's pick without waiting for a submit", () => {
  it('calls the shared writer from its change handler', () => {
    const handler = BAR_SOURCE.slice(BAR_SOURCE.indexOf('const changePair'));
    const body = handler.slice(0, handler.indexOf('\n  };'));
    assert.equal(
      body.includes('persistLanguagePair('),
      true,
      'changePair no longer persists the pick, so a pick on the landing page is lost on reload',
    );
  });

  it('persists from the handler and not from an effect watching the selection', () => {
    // The one `useEffect` in this file is the deferred `requestSubmit`. A write
    // moved into an effect would fire on every navigation as well, because the
    // caller keys the component on the pair and the state is re-seeded.
    const effects = [...BAR_SOURCE.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[/g)].map((m) => m[1] ?? '');
    assert.equal(effects.length, 1, 'this file grew a second effect; check it is not the persistence write');
    assert.equal(effects[0]?.includes('persistLanguagePair'), false, 'the pick is persisted from a render, not an action');
  });

  it('still submits only when the query box is non-empty', () => {
    // The fix must not have turned an empty landing page into a navigation to
    // itself on every pick.
    assert.equal(BAR_SOURCE.includes("submitOnNextCommit.current = q !== '';"), true, 'the empty-box submit rule is gone');
  });
});
