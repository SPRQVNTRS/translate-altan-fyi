/**
 * Guards the exclusion rules in `public/sw.js`, the hand-rolled service worker.
 *
 * This app exists to tell you what a word means, and a cached answer is
 * indistinguishable from a live one. A service worker that serves yesterday's
 * loader response shows a wrong translation with full confidence, in a screen
 * that looks completely normal, and the user has no way to tell. So the worker
 * must never cache route data: no react-router `.data` request, no `/api/`
 * call, and nothing carrying a query string. Those three exclusions are the
 * whole safety property, and each one is a single line that a refactor can
 * delete without breaking anything visible.
 *
 * The assertions run against the file's TEXT. The worker is plain browser JS
 * that references `self` and `caches`, so node cannot import it, and no bundler
 * or typechecker ever reads it either. That last part is why the syntax check
 * at the end of this file matters: a stray typo in `sw.js` reaches production
 * silently, and the only symptom is that the worker never installs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, Script } from 'node:vm';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WORKER_FILE = 'public/sw.js';
const WORKER_PATH = join(REPO_ROOT, WORKER_FILE);

/** Written as an escape on purpose, so this file does not trip the em dash rule. */
const EM_DASH = '\u2014';

/** The routes the worker precaches on install, so the app boots with no network. */
const REQUIRED_SHELL_PATHS = ['/', '/lists', '/history', '/settings', '/account', '/offline'];

/** Read once. A missing file is reported by the first test rather than crashing on import. */
const source = existsSync(WORKER_PATH) ? readFileSync(WORKER_PATH, 'utf8') : '';

/**
 * One no-cache rule, paired with the source text that implements it. The
 * failure message names the rule, because "string not found" tells the next
 * reader nothing about what they broke.
 */
type Rule = {
  rule: string;
  needle: string;
};

const NO_CACHE_RULES: readonly Rule[] = [
  {
    rule: 'react-router route data (a `.data` request) must never be cached, it is a live loader response',
    needle: "endsWith('.data')",
  },
  {
    rule: 'API calls must never be cached, `/api/` is live data by definition',
    needle: "startsWith('/api/')",
  },
  {
    rule: 'a URL with a query string names a specific answer, never a shell, so it must never be cached',
    needle: "url.search !== ''",
  },
  {
    rule: 'the account screens must never be cached, each one renders a different page for a different reader',
    needle: 'AUTH_PATHS.has(url.pathname)',
  },
  {
    rule: 'the exclusions must be applied in the fetch handler, a classifier nobody calls protects nothing',
    needle: 'isUncacheable(url)',
  },
];

/**
 * Live API paths the worker must refuse to cache, checked through the worker's
 * OWN classifier rather than by searching its text.
 *
 * WHY THIS IS NOT ANOTHER NEEDLE. The rules above assert that a line of source
 * still exists; this asserts what that line DOES. `/api/translation/:id` is a
 * poll that reports whether a run has finished, and `/api/translation/:id/retry`
 * starts one: a cached answer to either is a reader watching a spinner for a run
 * that finished a minute ago, or a retry that appears to work and never happens.
 * Neither path is named in `sw.js`, and neither should be, because the `/api/`
 * prefix rule already covers every one of them. What has to be guarded is that
 * it still does, for these paths, whatever the rule is rewritten into.
 */
const ORIGIN = 'https://example.test';

const REQUIRED_UNCACHEABLE_PATHS = [
  '/api/translation/99a991dc-8e80-4b65-82e5-effbbaf84269',
  '/api/translation/99a991dc-8e80-4b65-82e5-effbbaf84269/retry',
  '/api/enrichment/99a991dc-8e80-4b65-82e5-effbbaf84269',
];

/**
 * The globals `sw.js` touches while it loads, plus the two slots this test uses
 * to ask the worker a question and read the answer back out.
 */
interface WorkerSandbox {
  self: { addEventListener: (name: string) => void; location: { origin: string } };
  caches: { open: () => Promise<Record<string, never>>; keys: () => Promise<string[]> };
  URL: typeof URL;
  fetch: () => Promise<never>;
  /** The URLs to classify, read by the appended line below. */
  probes: string[];
  /** What the worker's own classifier said about each one, written by that line. */
  verdicts: boolean[];
}

/**
 * Ask the REAL worker whether it would cache each URL.
 *
 * The worker is browser JavaScript that node cannot import, so it runs in a vm
 * context with the globals it touches at load stubbed out. The classifier is not
 * pulled out of the context and called from here: one appended line calls it
 * INSIDE the context and writes the answers back, which keeps this test free of
 * any claim about the shape of a value it did not create.
 *
 * A worker that no longer declares `isUncacheable` throws a ReferenceError here,
 * which is the correct failure: the rule check above asserts the call site
 * exists, and this one asserts the thing it calls still does.
 */
function classifyWithWorker(worker: string, urls: readonly string[]): boolean[] {
  const sandbox: WorkerSandbox = {
    self: { addEventListener: () => undefined, location: { origin: ORIGIN } },
    caches: { open: () => Promise.resolve({}), keys: () => Promise.resolve([]) },
    URL,
    fetch: () => Promise.reject(new Error('the unit tier makes no requests')),
    probes: [...urls],
    verdicts: [],
  };
  const context = createContext(sandbox);
  const probe = `${worker}
;verdicts = probes.map(function (path) { return isUncacheable(new URL(path)); });`;
  new Script(probe, { filename: WORKER_FILE }).runInContext(context);
  return sandbox.verdicts;
}

/** Every account path the worker must refuse to cache. A path missing from the list is a page that would be cached. */
const REQUIRED_AUTH_PATHS = [
  '/sign-in',
  '/sign-up',
  '/sign-out',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
];

/** The no-cache rules a given worker source no longer implements. */
function findBrokenRules(worker: string): Rule[] {
  return NO_CACHE_RULES.filter((entry) => !worker.includes(entry.needle));
}

/** The string literals inside a named array literal in the worker source. */
function parseArrayLiteral(worker: string, name: string): string[] {
  // `new Set([...])` and a bare `[...]` both count: the worker uses whichever
  // shape reads best, and this test is about the CONTENTS.
  const declaration = new RegExp(`${name}\\s*=\\s*(?:new Set\\()?\\[([\\s\\S]*?)\\]`).exec(worker);
  if (!declaration) return [];
  const body = declaration[1] ?? '';
  return [...body.matchAll(/['"`]([^'"`]*)['"`]/g)].map((match) => match[1] ?? '');
}

/** The string literals inside the worker's `APP_SHELL` array literal. */
function parseAppShell(worker: string): string[] {
  return parseArrayLiteral(worker, 'APP_SHELL');
}

function lineOf(worker: string, needle: string): number {
  const lines = worker.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] ?? '').includes(needle)) return index + 1;
  }
  return -1;
}

describe('service worker exclusions', () => {
  it('reads a non-empty public/sw.js', () => {
    assert.ok(existsSync(WORKER_PATH), `${WORKER_FILE} is missing, the PWA has no offline shell`);
    // A guard over an empty string would pass nothing but still look green.
    assert.ok(source.length > 500, `${WORKER_FILE} holds only ${source.length} characters`);
  });

  it('excludes route data, API calls and query strings from every cache', () => {
    const broken = findBrokenRules(source);
    const report = broken.map((entry) => `  ${entry.rule}\n    expected to find: ${entry.needle}`).join('\n');
    assert.deepEqual(broken, [], `${WORKER_FILE} no longer enforces its no-stale-answers rules:\n${report}`);
  });

  it('precaches every app shell route', () => {
    const shell = parseAppShell(source);
    assert.ok(shell.length > 0, `could not parse the APP_SHELL array out of ${WORKER_FILE}`);
    const missing = REQUIRED_SHELL_PATHS.filter((path) => !shell.includes(path));
    assert.deepEqual(
      missing,
      [],
      `${WORKER_FILE} APP_SHELL is missing ${missing.join(', ')}, those routes will not open offline. Found: ${shell.join(', ')}`,
    );
  });

  it('names every account screen in the no-cache list', () => {
    const listed = parseArrayLiteral(source, 'AUTH_PATHS');
    assert.ok(listed.length > 0, `could not parse the AUTH_PATHS array out of ${WORKER_FILE}`);
    const missing = REQUIRED_AUTH_PATHS.filter((path) => !listed.includes(path));
    assert.deepEqual(
      missing,
      [],
      `${WORKER_FILE} AUTH_PATHS is missing ${missing.join(', ')}, those pages would be served from cache to the next reader. Found: ${listed.join(', ')}`,
    );
  });

  it('keeps the account screens out of the precached shell', () => {
    // Precaching one would defeat the exclusion above from the other side: the
    // install step writes it into the cache before any fetch is classified.
    const shell = parseAppShell(source);
    const overlap = shell.filter((path) => REQUIRED_AUTH_PATHS.includes(path));
    assert.deepEqual(overlap, [], `${WORKER_FILE} precaches account screens: ${overlap.join(', ')}`);
  });

  it('refuses to cache the translation poll, the retry and the enrichment poll', () => {
    // The last probe is a shell route the worker MUST cache. Without it this
    // case would be green against a classifier that returns true for every
    // input, which caches nothing and breaks the app offline instead.
    const probes = [...REQUIRED_UNCACHEABLE_PATHS, '/lists'];
    const verdicts = classifyWithWorker(source, probes.map((path) => `${ORIGIN}${path}`));
    const cached = REQUIRED_UNCACHEABLE_PATHS.filter((_path, index) => verdicts[index] !== true);
    assert.deepEqual(
      cached,
      [],
      `${WORKER_FILE} would cache ${cached.join(', ')}. A cached poll shows a finished run as still running, and a cached retry never reaches the server.`,
    );
    assert.equal(verdicts.at(-1), false, `${WORKER_FILE} now refuses to cache /lists, so the shell cannot open offline`);
  });

  it('uses no em dash', () => {
    const lines = source.split('\n');
    const hits = lines
      .map((line, index) => ({ line: index + 1, text: line.trim() }))
      .filter((entry) => entry.text.includes(EM_DASH))
      .map((entry) => `  ${WORKER_FILE}:${entry.line}  ${entry.text}`);
    assert.deepEqual(hits, [], `Never use em dashes in copy, use a comma instead.\n${hits.join('\n')}`);
  });

  it('parses as JavaScript', () => {
    // No bundler, typechecker or test ever compiles this file, so a syntax error
    // ships and the worker silently never installs. Compiling without running it
    // is the whole check: `self` and `caches` do not exist in node.
    try {
      assert.ok(new Script(source, { filename: WORKER_FILE }));
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      assert.fail(`${WORKER_FILE} is not valid JavaScript: ${reason}`);
    }
  });

  it('locates the rules it asserts on (guards the text search itself)', () => {
    // A text guard that matches the wrong line is a guard that cannot fail.
    for (const entry of NO_CACHE_RULES) {
      assert.ok(lineOf(source, entry.needle) > 0, `${entry.needle} not found in ${WORKER_FILE}`);
    }
    assert.deepEqual(parseAppShell("const APP_SHELL = ['/', '/offline'];"), ['/', '/offline']);
    assert.deepEqual(parseAppShell('const NOT_THE_SHELL = [];'), []);
    // A worker that dropped the API exclusion must be reported, or the rule
    // check above is green no matter what the real file says.
    const withoutApiRule = source.replace("startsWith('/api/')", "startsWith('/assets/')");
    assert.deepEqual(
      findBrokenRules(withoutApiRule).map((entry) => entry.needle),
      ["startsWith('/api/')"],
    );
  });
});
