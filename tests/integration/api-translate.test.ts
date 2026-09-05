/**
 * THE API CLAIM: TRANSLATING A WORD AND TRANSLATING A SENTENCE ARE THE SAME
 * CALL, WITH THE SAME ANSWER SHAPE.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   1. ONE ENDPOINT, BOTH BRANCHES. `POST /api/v1/translate` is driven once with
 *      a single word and once with a sentence, and both answers are decoded by
 *      the SAME schema, the one the CLI names on its transport call. A branch
 *      that grew a field the other one lacks fails here rather than in an
 *      operator's terminal.
 *   2. THE BRANCH IS REPORTED, NEVER ASKED FOR. The body carries no `kind`, and
 *      the two answers still come back `word` and `phrase`. That is the
 *      executable form of "the endpoint decides for itself", which is what keeps
 *      the API and the search screen from disagreeing about what a phrase is.
 *   3. NO KEY, NO ANSWER. A request with no Authorization header is refused 401
 *      and reaches no queue, so the endpoint cannot be a free way to spend this
 *      installation's budget.
 *
 *   This file must not be made green by weakening an assertion.
 *
 * NO WORKER IS STARTED, AND NO MODEL IS EVER CALLED. `initializeWorkflows()`
 * registers the templates so an enqueue can resolve its workflow; the worker is
 * deliberately left down, so both branches settle on `translating` and nothing
 * is ever sent to a provider. `wait` is false on every call for the same reason:
 * a waiting call with no worker would only burn the deadline.
 *
 * ISOLATION. The word and the sentence both carry a run-scoped nonsense token,
 * so neither can collide with a developer's own data. The API key, the queued
 * jobs, the workflow rows, the phrase rows and the seeded headword are all
 * removed in `after`.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq, like, sql } from 'drizzle-orm';
import { RouterContextProvider } from 'react-router';

import { getRawDb, pool } from '../../drizzle/db';
import { apiKeys, phraseTranslations, workflows } from '../../drizzle/schema';
import { action } from '../../app/routes/api.v1.translate';
import { TRANSLATION_QUEUE } from '../../app/lib/translation/limits';
import { createApiKey } from '../../app/models/api-keys.server';
import { initializeWorkflows, stopOrchestrator } from '../../app/services/workflows.server';
import { translateAnswerSchema } from '../../cli/lib/schemas';
import type { JsonValue } from '../../app/lib/json';
import { createFakeLlmPort } from '../fixtures/fake-llm-port';
import {
  seedHeadword,
  setUpTranslationFixture,
  tearDownTranslationFixture,
  type TranslationFixture,
} from '../fixtures/translation-corpus';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

const FROM = 'de';
const TO = 'tr';

let fixture: TranslationFixture = {
  sourceId: '',
  generatedSourceId: '',
  fake: createFakeLlmPort(),
  run: '',
  seededHeadwordIds: [],
};

/** The key every authorised case sends, and the row to delete afterwards. */
let apiKey = { id: '', secret: '' };

/** The single word one case asks about, and the entry behind it. */
let word = { lemma: '', headwordId: '' };

/** The sentence the other case asks about. */
let sentence = '';

/**
 * One call to the endpoint, framed the way the router frames it.
 *
 * A THROWN `Response` IS RETURNED RATHER THAN RETHROWN. The auth helpers refuse
 * by throwing a `Response`, which the router turns into an ordinary answer, so a
 * test driving the action directly has to do the same or it could never see a
 * 401 at all.
 */
async function post(body: JsonValue, key: string | null): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (key !== null) headers.set('Authorization', `Bearer ${key}`);

  const request = new Request('https://translate.altan.fyi/api/v1/translate', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  try {
    return await action({
      request,
      url: new URL(request.url),
      params: {},
      pattern: '/api/v1/translate',
      context: new RouterContextProvider(),
    });
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

/** The answer, decoded by the schema the CLI itself names. */
async function translate(q: string) {
  const response = await post({ q, from: FROM, to: TO, wait: false }, apiKey.secret);
  assert.equal(response.status, 200, `the endpoint answered ${response.status} for ${JSON.stringify(q)}`);
  return translateAnswerSchema.parse(await response.json());
}

before(async () => {
  if (!DB_HOST) return;
  fixture = await setUpTranslationFixture('api-translate');

  word.lemma = `zzwort${fixture.run}`;
  word.headwordId = await seedHeadword(fixture, { lemma: word.lemma, languageCode: FROM, pos: 'noun' });
  sentence = `zzsatz ${fixture.run} das auto volltanken`;

  const minted = await createApiKey({ name: `api-translate-${fixture.run}`, isSuperadmin: false });
  apiKey = { id: minted.record.id, secret: minted.key };

  // Registers the templates so an enqueue can resolve its workflow. The WORKER
  // is deliberately not started.
  await initializeWorkflows();
});

after(async () => {
  if (!DB_HOST) {
    await pool.end();
    return;
  }
  await stopOrchestrator();

  await db.delete(workflows).where(sql`${workflows.context}->>'sourceNormalized' like ${`zz%${fixture.run}%`}`);
  await db.delete(workflows).where(sql`${workflows.context}->>'headwordId' = ${word.headwordId}`);
  await db.execute(
    sql`delete from pgboss.job where name = ${TRANSLATION_QUEUE} and singleton_key like ${`phrase:%${fixture.run}%`}`,
  );
  await db.execute(
    sql`delete from pgboss.job where name = ${TRANSLATION_QUEUE} and singleton_key like ${`${word.headwordId}%`}`,
  );
  await db.delete(phraseTranslations).where(like(phraseTranslations.sourceNormalized, `zz%${fixture.run}%`));
  if (apiKey.id !== '') await db.delete(apiKeys).where(eq(apiKeys.id, apiKey.id));

  await tearDownTranslationFixture(fixture, []);
  await pool.end();
});

describe('POST /api/v1/translate', () => {
  it(
    'answers a word and a sentence with the same shape, and decides the branch itself',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const wordAnswer = await translate(word.lemma);
      const phraseAnswer = await translate(sentence);

      assert.equal(wordAnswer.kind, 'word', 'a single word was not read as a word');
      assert.equal(phraseAnswer.kind, 'phrase', 'a sentence was not read as a phrase');

      assert.deepEqual(
        Object.keys(wordAnswer).toSorted(),
        Object.keys(phraseAnswer).toSorted(),
        'the two branches answered with different fields. A caller must not be able to tell them apart.',
      );

      assert.equal(wordAnswer.headwordId, word.headwordId, 'the word branch answered about a different entry');
      assert.equal(phraseAnswer.headwordId, null, 'a sentence is not a lexical entry and carries no headword id');

      assert.equal(wordAnswer.panel.state, 'translating', 'the word branch started no run');
      assert.equal(phraseAnswer.panel.state, 'translating', 'the sentence branch started no run');

      const rows = await db
        .select({ id: phraseTranslations.id })
        .from(phraseTranslations)
        .where(like(phraseTranslations.sourceNormalized, `zz%${fixture.run}%`));
      assert.equal(rows.length, 1, `the sentence opened ${rows.length} rows, and one call must open exactly one`);
    },
  );

  it(
    'refuses a request that carries no API key, and starts nothing',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const rowsBefore = await db
        .select({ id: phraseTranslations.id })
        .from(phraseTranslations)
        .where(like(phraseTranslations.sourceNormalized, `zz%${fixture.run}%`));

      const response = await post({ q: sentence, from: FROM, to: TO, wait: false }, null);
      assert.equal(response.status, 401, `an unauthenticated call was answered ${response.status}`);

      const rowsAfter = await db
        .select({ id: phraseTranslations.id })
        .from(phraseTranslations)
        .where(like(phraseTranslations.sourceNormalized, `zz%${fixture.run}%`));
      assert.equal(
        rowsAfter.length,
        rowsBefore.length,
        'an unauthenticated call opened a phrase row. The refusal must happen before any work is started.',
      );
    },
  );

  it(
    'refuses a pair with the same language on both sides',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const response = await post({ q: word.lemma, from: FROM, to: FROM, wait: false }, apiKey.secret);
      assert.equal(response.status, 400, `a same-language pair was answered ${response.status}`);
    },
  );
});
