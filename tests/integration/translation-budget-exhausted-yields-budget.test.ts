/**
 * WITH TODAY'S SPEND AT THE CAP, A SIGNED-IN SEARCH QUEUES NOTHING AND THE
 * PANE SAYS SO. `resolveTriggeredTranslationPanel` reads the corpus and the
 * run ledger first (`none`, for a fresh word), then runs the three guards in
 * order: rate limit, budget, daily cap. `isBudgetExhausted` is the second
 * guard, and refusing there means `enqueueTranslation` is never reached, so
 * this file needs no orchestrator and no queue to clean up: the guard fires
 * before there is anything to queue.
 *
 * THE SHARED ROW, WRITTEN AND PUT BACK EXACTLY. `daily_budget` is a single row
 * per UTC day, read by a developer's own dev server and by the admin page.
 * `setUpTranslationFixture` photographs today's figures before this file
 * changes them, and `tearDownTranslationFixture` writes that snapshot back,
 * the same mechanism `translation-run-writes-corpus.test.ts` relies on for the
 * few cents a real run reserves and settles. This file writes the row directly
 * to the cap rather than spending up to it, and the restore is the same either
 * way.
 *
 * NO LIVE API IS EVER REACHABLE. The fixture installs a fake port even though
 * no case here ever calls it.
 *
 * ISOLATION. One headword with a run-scoped suffix, removed through
 * `tearDownTranslationFixture`. Every request carries a fresh
 * documentation-range address, and its rate-limit counter is deleted by key.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';
import { RouterContextProvider } from 'react-router';

import { abuseCounters, dailyBudget } from '../../drizzle/schema';
import { getRawDb, pool } from '../../drizzle/db';
import { DAILY_BUDGET_USD, utcDay } from '../../app/lib/abuse/budget.server';
import { counterKey } from '../../app/lib/abuse/rate-limit.server';
import { loader as translateLoader } from '../../app/routes/translate';
import { createFakeLlmPort } from '../fixtures/fake-llm-port';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';
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
let session: TestUserSession | null = null;

let headwordId = '';
let lemma = '';

const createdCounterKeys: string[] = [];

/** One octet of a documentation-range address. */
function octet(): number {
  return 1 + Math.floor(Math.random() * 250);
}

async function search() {
  const ip = `198.51.${octet()}.${octet()}`;
  createdCounterKeys.push(counterKey('ip', ip));
  const request = new Request(`https://kenning.altan.fyi/?q=${encodeURIComponent(lemma)}&from=${FROM}&to=${TO}`, {
    headers: { 'x-forwarded-for': ip, cookie: session?.cookie ?? '' },
  });
  return translateLoader({
    request,
    url: new URL(request.url),
    params: {},
    pattern: '/',
    context: new RouterContextProvider(),
  });
}

before(async () => {
  if (!DB_HOST) return;

  // THE FIXTURE'S OWN before() PHOTOGRAPHS TODAY'S ROW FIRST, so the value
  // this file writes below is what gets undone, not what gets kept.
  fixture = await setUpTranslationFixture('budget-exhausted');
  session = await createTestUserSession('trans-budget');

  lemma = `zztransbudget${fixture.run}`;
  headwordId = await seedHeadword(fixture, { lemma, languageCode: FROM, pos: 'noun' });

  const day = utcDay(new Date());
  await db
    .insert(dailyBudget)
    .values({ day, reservedUsd: DAILY_BUDGET_USD.toFixed(6), spentUsd: '0.000000' })
    .onConflictDoUpdate({
      target: dailyBudget.day,
      set: { reservedUsd: DAILY_BUDGET_USD.toFixed(6), spentUsd: '0.000000' },
    });
});

after(async () => {
  if (!DB_HOST) {
    await pool.end();
    return;
  }
  if (createdCounterKeys.length > 0) {
    await db.delete(abuseCounters).where(inArray(abuseCounters.key, createdCounterKeys));
  }
  // THE BUDGET ROW IS RESTORED BY THE FIXTURE'S OWN TEARDOWN, to the figures it
  // photographed in setUpTranslationFixture, which ran before this file wrote
  // the cap into the row above.
  await tearDownTranslationFixture(fixture, []);
  if (session !== null) await session.dispose();
  await pool.end();
});

describe('a signed-in search once today has reached the daily budget cap', () => {
  it(
    'queues no job and reports the pane as budget',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.ok(session !== null, 'the fixture account was not created, so this case would prove nothing');

      const day = utcDay(new Date());
      const [rowBefore] = await db
        .select({ reservedUsd: dailyBudget.reservedUsd, spentUsd: dailyBudget.spentUsd })
        .from(dailyBudget)
        .where(eq(dailyBudget.day, day));
      assert.ok(rowBefore, 'the budget row this case set up is missing');
      const committedBefore = Number(rowBefore.reservedUsd) + Number(rowBefore.spentUsd);
      assert.ok(committedBefore >= DAILY_BUDGET_USD, 'the fixture did not actually reach the cap');

      const data = await search();
      assert.equal(data.translationHeadwordId, headwordId, 'the search did not resolve to the seeded headword');
      assert.equal(
        data.translationPanel?.state,
        'budget',
        `expected the pane to read budget once the cap is reached, got ${JSON.stringify(data.translationPanel)}`,
      );

      const [rowAfter] = await db
        .select({ reservedUsd: dailyBudget.reservedUsd, spentUsd: dailyBudget.spentUsd })
        .from(dailyBudget)
        .where(eq(dailyBudget.day, day));
      assert.ok(rowAfter, 'the budget row disappeared');
      assert.equal(rowAfter.reservedUsd, rowBefore.reservedUsd, 'a refused trigger must reserve nothing');
      assert.equal(rowAfter.spentUsd, rowBefore.spentUsd, 'a refused trigger must spend nothing');
    },
  );
});
