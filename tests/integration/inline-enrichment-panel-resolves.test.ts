/**
 * The output pane's inline enrichment panel, from `pending` to a terminal
 * state, driven against a real Postgres with the provider faked.
 *
 * WHAT THIS FILE HOLDS IN PLACE, AND WHY A RENDER TEST WOULD NOT
 *   M185/03 moved the enrichment panel into the search screen's output pane, so
 *   a reader now meets the `pending` state on the FIRST screen of the product
 *   rather than one click inside it. DESIGN.md rule 3 says a skeleton must have
 *   a terminal path that is actually reachable, and the only honest way to show
 *   that is to walk the path: start the panel, run the work, and ask again
 *   through the very route the panel polls. A test that rendered the component
 *   and asserted three grey bars would prove the spinner exists, which is the
 *   opposite of the claim.
 *
 *   Each case therefore ends on a state the UI STOPS on. `EnrichmentSection`
 *   polls while, and only while, `state === 'pending'` with no refusal, so
 *   `ready` and `failed` are exactly the two answers that tear the interval
 *   down. Asserting them here is asserting that the spinner ends.
 *
 * THE SEARCH LOADER IS THE SUBJECT, NOT A HELPER BENEATH IT
 *   Every case calls `app/routes/translate.tsx`'s own loader, because the claim is
 *   about the output pane and not about the shared module underneath it. A test
 *   against `resolveTriggeredPanel` alone would stay green if the search route
 *   stopped returning a panel at all.
 *
 * NO PROVIDER IS EVER REACHED
 *   `registry.withProvider` installs a fake port in `before()` and restores the
 *   real one in `after()`. The provider keys set below are dummies that exist
 *   only so the registry's configuration check passes; their VALUES are never
 *   used, because no real client is ever built. A developer with a live key in
 *   their environment cannot make this file spend money.
 *
 * ISOLATION, AND WHAT IS PUT BACK
 *   Every dictionary row this run creates carries a random suffix and is deleted
 *   in `after()`, in foreign-key-safe order. The rate limiter is a SHARED table
 *   in a database that is also a developer's dev database, so every request
 *   carries a fresh random documentation-range address and every counter row it
 *   creates is deleted by key. Nothing pre-existing is read, written or deleted,
 *   and the seeded `languages` rows are only ever referenced.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else: no API key
 * and no server on :3456. Every case gates on it, which
 * `tests/unit/integration-tests-self-skip.test.ts` enforces one for one.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { RouterContextProvider } from 'react-router';
import { z } from 'zod';

import { abuseCounters, enrichments, headwords, senseVersions, senses, sources } from '../../drizzle/schema';
import { pool } from '../../drizzle/db';
import { getRawDb } from '../../drizzle/db';
import { counterKey } from '../../app/lib/abuse/rate-limit.server';
import type { EnrichmentPanel } from '../../app/lib/enrichment/trigger.server';
import type { JsonValue } from '../../app/lib/json';
import { registry } from '../../app/lib/llm/registry.server';
import { PROMPT_VERSION } from '../../app/prompts/enrichment/version';
import { loader as pollEnrichment } from '../../app/routes/api.enrichment.$headwordId';
import { loader as translateLoader } from '../../app/routes/translate';
import { runEnrichHeadword } from '../../app/workflows/operations/enrichment/enrich-headword';
import { createFakeLlmPort, llmError, llmValue, type FakeLlmPort } from '../fixtures/fake-llm-port';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

/** Every row this run creates carries this suffix, so cleanup can be exact. */
const RUN = randomUUID().slice(0, 8);
/** The direction under test. Both codes are languages the migration seeds. */
const FROM = 'de';
const TO = 'en';

/** The provider keys, set to a dummy so the registry's configuration check passes. */
const KEY_VARS = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;
const DUMMY_KEY = 'stub-key-not-a-real-credential';
const savedKeys = new Map<string, string | undefined>();

/** One seeded word: the lemma a reader types, and the ids behind it. */
interface SeededWord {
  lemma: string;
  headwordId: string;
  senseId: string;
}

let sourceId = '';
let fake: FakeLlmPort = createFakeLlmPort();
/** The signed-in reader every case in this file searches as. */
let session: TestUserSession | null = null;

/** Every headword this run created, so `after()` deletes exactly those rows. */
const createdHeadwordIds: string[] = [];
/** Every rate-limit bucket this run touched, so `after()` deletes exactly those rows. */
const createdCounterKeys: string[] = [];

/** One octet of a documentation-range address. */
function octet(): number {
  return 1 + Math.floor(Math.random() * 250);
}

/**
 * One search request, from an address no other test and no developer shares.
 *
 * A FRESH ADDRESS PER REQUEST IS THE ISOLATION. The hourly bucket is shared
 * state in a shared database, so a fixed address here would count this file's
 * requests against whatever else is using the dev database this hour, and would
 * eventually refuse a trigger for reasons that have nothing to do with the code
 * under test.
 */
function searchRequest(q: string): Request {
  const ip = `198.51.${octet()}.${octet()}`;
  createdCounterKeys.push(counterKey('ip', ip));
  const url = `https://kenning.altan.fyi/translate?q=${encodeURIComponent(q)}&from=${FROM}&to=${TO}`;
  // SIGNED IN, SINCE M184. A typed search requires an account: the loader
  // redirects a signed-out caller to `/sign-in` before it reads the
  // dictionary, so an anonymous request here would assert nothing about the
  // panel. The session is a real invited account, created in `before()`,
  // because the gate resolves the access token against the database and a
  // hand-built cookie would simply be another signed-out request.
  assert.ok(session !== null, 'the fixture account was not created, so no case in this file drives the loader');
  return new Request(url, { headers: { 'x-forwarded-for': ip, cookie: session.cookie } });
}

/**
 * The panel the OUTPUT PANE would render for `q`, through the search route's
 * own loader.
 *
 * The extra members of the loader's argument are the ones the router supplies
 * and this route reads none of; they are passed so the call is the shape the
 * framework makes, not a narrower one this test invented.
 */
async function panelForSearch(q: string): Promise<EnrichmentPanel | null> {
  const request = searchRequest(q);
  const data = await translateLoader({
    request,
    url: new URL(request.url),
    params: {},
    pattern: '/translate',
    context: new RouterContextProvider(),
  });
  return data.panel;
}

/**
 * The polled body, decoded rather than trusted.
 *
 * ONLY WHAT THE CASES READ. A full Zod transcription of the four-member panel
 * union, whose `output` field is free-form model JSON, would be a second
 * definition of `state.server.ts` that could drift from it silently. The two
 * facts these cases assert are the state the UI stops on and whether any notes
 * came with it, so those are the two fields decoded here, and an answer that
 * does not carry them fails at this boundary rather than deeper in.
 */
const polledPanelSchema = z.object({
  state: z.enum(['idle', 'pending', 'ready', 'failed']),
  senses: z.array(z.object({ senseId: z.string() })),
});

/**
 * The panel the COMPANION ROUTE answers with, at the URL the pending panel
 * polls.
 *
 * `EnrichmentSection` builds `/api/enrichment/<id>?to=<code>` and asks for it
 * every three seconds while the panel is pending, so this is the exact hop that
 * either ends the skeleton or leaves it spinning forever.
 */
async function panelFromPoll(headwordId: string): Promise<z.infer<typeof polledPanelSchema>> {
  const request = new Request(`https://kenning.altan.fyi/api/enrichment/${headwordId}?to=${TO}`);
  const response = await pollEnrichment({
    request,
    url: new URL(request.url),
    params: { headwordId },
    pattern: '/api/enrichment/:headwordId',
    context: new RouterContextProvider(),
  });
  return polledPanelSchema.parse(await response.json());
}

/** One well-formed model answer for one sense. It must satisfy `enrichmentOutputSchema`. */
function answerCovering(senseId: string): JsonValue {
  return {
    senses: [
      {
        senseId,
        translation: ['snail'],
        explanation: 'A small animal that carries its shell.',
        register: 'neutral',
        usageNotes: 'Everyday word, no restriction on register.',
        examples: [
          { text: 'Die Schnecke kriecht.', translation: 'The snail crawls.' },
          { text: 'Eine kleine Schnecke.', translation: 'A small snail.' },
          { text: 'Schnecken im Garten.', translation: 'Snails in the garden.' },
        ],
        commonMistakes: ['Do not confuse it with the pastry sense.'],
      },
    ],
  };
}

/** Create one headword with one sense and one English gloss, and return its ids. */
async function seedWord(slug: string): Promise<SeededWord> {
  const lemma = `zzinline${slug}${RUN}`;
  const [headword] = await db
    .insert(headwords)
    .values({ languageCode: FROM, lemma, lemmaNormalized: lemma, pos: 'noun', sourceId })
    .returning({ id: headwords.id });
  assert.ok(headword, 'failed to create the test headword');
  createdHeadwordIds.push(headword.id);

  const [sense] = await db
    .insert(senses)
    .values({ headwordId: headword.id, sourceId, externalId: `${lemma}-s0` })
    .returning({ id: senses.id });
  assert.ok(sense, 'failed to create the test sense');
  await db.insert(senseVersions).values({
    senseId: sense.id,
    version: 1,
    glossLanguageCode: TO,
    gloss: `test gloss for ${lemma}`,
    sourceId,
  });

  return { lemma, headwordId: headword.id, senseId: sense.id };
}

let resolving: SeededWord = { lemma: '', headwordId: '', senseId: '' };
let failing: SeededWord = { lemma: '', headwordId: '', senseId: '' };

before(async () => {
  if (!DB_HOST) return;

  session = await createTestUserSession('inline-panel');

  for (const name of KEY_VARS) {
    savedKeys.set(name, process.env[name]);
    process.env[name] = DUMMY_KEY;
  }

  fake = createFakeLlmPort();
  registry.withProvider(fake);

  const [source] = await db
    .insert(sources)
    .values({
      slug: `test-inline-panel-${RUN}`,
      name: `test source ${RUN}`,
      licence: 'CC0-1.0',
      attribution: `test run ${RUN}`,
    })
    .returning({ id: sources.id });
  assert.ok(source, 'failed to create the test source');
  sourceId = source.id;

  resolving = await seedWord('ready');
  failing = await seedWord('failed');
});

after(async () => {
  if (!DB_HOST) {
    await pool.end();
    return;
  }

  registry.withProvider(null);
  if (session !== null) await session.dispose();
  for (const [name, value] of savedKeys) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  if (createdCounterKeys.length > 0) {
    await db.delete(abuseCounters).where(inArray(abuseCounters.key, createdCounterKeys));
  }
  // Foreign-key-safe order: the enrichments point at senses and headwords, the
  // versions point at senses, the senses point at headwords, and everything
  // points at the source.
  if (createdHeadwordIds.length > 0) {
    await db.delete(enrichments).where(inArray(enrichments.headwordId, createdHeadwordIds));
  }
  if (sourceId !== '') {
    await db.delete(senseVersions).where(eq(senseVersions.sourceId, sourceId));
    await db.delete(senses).where(eq(senses.sourceId, sourceId));
    await db.delete(headwords).where(eq(headwords.sourceId, sourceId));
    await db.delete(sources).where(eq(sources.id, sourceId));
  }

  await pool.end();
});

describe('the inline enrichment panel in the output pane', () => {
  it(
    'starts pending for a word nothing is cached for',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const panel = await panelForSearch(resolving.lemma);

      assert.ok(panel !== null, 'the single-word branch returned no panel, so the output pane renders nothing');
      assert.equal(panel.state, 'pending', 'an uncached top hit must open the panel in its pending state');
      assert.ok(
        panel.state === 'pending' && panel.refusal === null,
        'a spend guard refused this trigger, so the case measured a guard rather than the pending path. ' +
          'Check the hourly limit and the daily budget in this database.',
      );
    },
  );

  it(
    'reaches ready through the same route the pending panel polls',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const started = await panelForSearch(resolving.lemma);
      assert.equal(started?.state, 'pending', 'the panel was not pending, so there is no skeleton to end');

      // The work the pending panel is waiting for, run in the foreground. In
      // production this is the queued job; here it is the same function that job
      // calls, so the rows it leaves behind are the rows a real run leaves.
      fake.reset([llmValue(answerCovering(resolving.senseId))]);
      const summary = await runEnrichHeadword({
        headwordId: resolving.headwordId,
        from: FROM,
        to: TO,
        promptVersion: PROMPT_VERSION,
      });
      assert.equal(summary.outcome, 'written');

      const polled = await panelFromPoll(resolving.headwordId);
      assert.equal(polled.state, 'ready', 'the poll never leaves pending, so the skeleton would spin forever');
      assert.equal(polled.senses.length, 1, 'a ready panel with no notes is an empty card');

      // AND THE PANE ITSELF, not only its polling companion. A reader who
      // searches the same word again must get the finished panel from the
      // loader rather than a fresh skeleton.
      const reloaded = await panelForSearch(resolving.lemma);
      assert.equal(reloaded?.state, 'ready', 'the output pane re-opened a skeleton over work that is already done');
    },
  );

  it(
    'reaches failed, and stays there, when the work ends badly',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const started = await panelForSearch(failing.lemma);
      assert.equal(started?.state, 'pending', 'the panel was not pending, so there is no skeleton to end');

      // Two rejections: the job retries once and then records a failed row per
      // pending sense, which is the state a panel has to be able to end on.
      fake.reset([llmError('first attempt refused'), llmError('second attempt refused')]);
      const summary = await runEnrichHeadword({
        headwordId: failing.headwordId,
        from: FROM,
        to: TO,
        promptVersion: PROMPT_VERSION,
      });
      assert.equal(summary.outcome, 'failed');

      const polled = await panelFromPoll(failing.headwordId);
      assert.equal(polled.state, 'failed', 'a failed run left the panel pending, which is a skeleton with no exit');

      // THE FAILURE IS NOT RE-OPENED ON THE NEXT SEARCH. A fresh loader call
      // must not queue again inside the retry window: doing so would flip the
      // pane back to pending and make the skeleton permanent by looping.
      const reloaded = await panelForSearch(failing.lemma);
      assert.equal(reloaded?.state, 'failed', 'the output pane re-opened a skeleton inside the retry window');
      assert.ok(
        reloaded !== null && reloaded.state === 'failed' && !reloaded.retryable,
        'the failure was reported as retryable straight away, so every search would re-queue it',
      );
    },
  );
});
