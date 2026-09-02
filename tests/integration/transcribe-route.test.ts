/**
 * The transcription route's three refusals, driven end to end against a real
 * database.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   `/api/v1/transcribe` is free, needs no account, and spends the operator's
 *   money on every successful request. It is therefore the cheapest way in the
 *   product to run up a bill, and its guards are the only thing between an
 *   unattended script and that bill. Each case below is one guard:
 *
 *   1. OVERSIZED. A body past the byte cap is refused with 413 and NO provider
 *      call is made. The fake port counts calls, so "refused" cannot quietly
 *      mean "called, then refused".
 *   2. PER-IP. Bursting past the shared hourly limit is refused with 429. This
 *      is the same limiter the enrichment trigger uses, and the point of the
 *      case is that this route really takes it rather than only importing it.
 *   3. BUDGET. At the daily cap the route declines with a message and a 429,
 *      never a 500. A reader holding a microphone cannot act on a stack trace.
 *
 * NO PROVIDER IS EVER REACHED
 *   Every case either stops before the provider or runs with an injected fake
 *   port. The API key environment variables are manipulated per case and
 *   restored, so a developer with a real key in their environment cannot make
 *   this file spend money.
 *
 * ISOLATION, AND WHAT IS PUT BACK
 *   The rate limiter and the budget are SHARED singletons keyed by hour and by
 *   day, and this database is also a developer's dev database. Every counter
 *   row this file creates is deleted in `after`, and today's `daily_budget`,
 *   `abuse_rejections` and `alert_log` rows are photographed before the run and
 *   restored to exactly what they were. The addresses are random, so no other
 *   test's bucket is touched.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else. Every case
 * gates on it, which `tests/unit/integration-tests-self-skip.test.ts` enforces.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, inArray } from 'drizzle-orm';
import { RouterContextProvider } from 'react-router';
import { z } from 'zod';

import { pool } from '../../drizzle/db';
import { getRawDb } from '../../drizzle/tenant-db';
import { abuseCounters, abuseRejections, alertLog, dailyBudget } from '../../drizzle/schema';
import { action } from '../../app/routes/api.v1.transcribe';
import {
  counterKey,
  windowStart,
  TRIGGER_LIMIT_PER_IP_PER_HOUR,
} from '../../app/lib/abuse/rate-limit.server';
import { DAILY_BUDGET_USD, utcDay } from '../../app/lib/abuse/budget.server';
import { registry, type AudioPort } from '../../app/lib/llm/registry.server';
import { MAX_AUDIO_BYTES } from '../../app/services/transcribe.server';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

/** The content type every case posts. A container the endpoint accepts, so nothing stops on the format. */
const CLIP_TYPE = 'audio/webm';

/** A body small enough to be accepted, for the cases that are not about size. */
const SMALL_CLIP = new Uint8Array(64).fill(7);

/** The provider keys this file clears, so no case can reach a live API by accident. */
const PROVIDER_KEY_VARS = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;

/** Every counter key this file creates, so `after` can delete exactly those rows. */
const createdCounterKeys: string[] = [];

/** The provider, faked. Nothing in this file may reach a network. */
const providerCalls: string[] = [];
const fakeAudioPort: AudioPort = {
  async transcribe(request) {
    providerCalls.push(request.format);
    return { text: 'never reached in this file', costUsd: null };
  },
};

/** The route's answer, decoded rather than trusted. */
const responseSchema = z.object({
  state: z.string(),
  error: z.string().optional(),
  message: z.string().optional(),
  messageKey: z.string().optional(),
  text: z.string().optional(),
});

/** Today's budget row before this file ran, or null when the day had none. */
let budgetSnapshot: { reservedUsd: string; spentUsd: string } | null = null;

/** Today's rejection counts before this file ran. */
let rejectionSnapshot: { reason: string; count: number }[] = [];

/** Today's alert kinds before this file ran, so only alerts it caused are deleted. */
let alertKindsBefore: string[] = [];

/** What the provider keys held before this file touched them. */
const keySnapshot = new Map<string, string | undefined>();

/** One POST to the route, as the router would frame it. */
async function post(params: { body: Uint8Array<ArrayBuffer>; ip: string; declaredLength?: number }): Promise<Response> {
  const headers = new Headers({ 'content-type': CLIP_TYPE, 'x-forwarded-for': params.ip });
  if (params.declaredLength !== undefined) headers.set('content-length', String(params.declaredLength));

  const request = new Request('https://translate.altan.fyi/api/v1/transcribe?language=de', {
    method: 'POST',
    headers,
    // A `Blob` rather than the array itself: that is the shape the browser
    // sends, and it is the one `BodyInit` accepts without an assertion.
    body: new Blob([params.body], { type: CLIP_TYPE }),
  });

  return action({
    request,
    url: new URL(request.url),
    params: {},
    pattern: '/api/v1/transcribe',
    context: new RouterContextProvider(),
  });
}

/** One octet of a documentation-range address. */
function octet(): number {
  return 1 + Math.floor(Math.random() * 250);
}

/** A random address, so no case shares a bucket with another case or with a developer. */
function freshIp(): string {
  const ip = `198.51.${octet()}.${octet()}`;
  createdCounterKeys.push(counterKey('ip', ip));
  return ip;
}

/** The decoded body of a route response. */
async function readBody(response: Response): Promise<z.infer<typeof responseSchema>> {
  return responseSchema.parse(await response.json());
}

before(async () => {
  if (!DB_HOST) return;

  // No alert may leave this process: a refused reservation raises the cap alert.
  keySnapshot.set('ALERT_WEBHOOK_URL', process.env.ALERT_WEBHOOK_URL);
  delete process.env.ALERT_WEBHOOK_URL;
  for (const variable of PROVIDER_KEY_VARS) {
    keySnapshot.set(variable, process.env[variable]);
    delete process.env[variable];
  }

  registry.withAudioPort(fakeAudioPort);

  const day = utcDay(new Date());
  const budgetRows = await db
    .select({ reservedUsd: dailyBudget.reservedUsd, spentUsd: dailyBudget.spentUsd })
    .from(dailyBudget)
    .where(eq(dailyBudget.day, day));
  budgetSnapshot = budgetRows[0] ?? null;

  rejectionSnapshot = await db
    .select({ reason: abuseRejections.reason, count: abuseRejections.count })
    .from(abuseRejections)
    .where(eq(abuseRejections.day, day));

  const alerts = await db.select({ kind: alertLog.kind }).from(alertLog).where(eq(alertLog.day, day));
  alertKindsBefore = alerts.map((row) => row.kind);
});

after(async () => {
  if (DB_HOST) {
    const day = utcDay(new Date());

    if (createdCounterKeys.length > 0) {
      await db.delete(abuseCounters).where(inArray(abuseCounters.key, createdCounterKeys));
    }

    // The day's money is put back exactly as it was found. A row that did not
    // exist before is deleted rather than zeroed, so a developer's dev database
    // is left the way this file found it.
    if (budgetSnapshot === null) {
      await db.delete(dailyBudget).where(eq(dailyBudget.day, day));
    } else {
      await db
        .update(dailyBudget)
        .set({ reservedUsd: budgetSnapshot.reservedUsd, spentUsd: budgetSnapshot.spentUsd })
        .where(eq(dailyBudget.day, day));
    }

    await db.delete(abuseRejections).where(eq(abuseRejections.day, day));
    for (const row of rejectionSnapshot) {
      await db.insert(abuseRejections).values({ day, reason: row.reason, count: row.count });
    }

    // Only alerts that appeared DURING the run are deleted. A pre-existing
    // operator alert survives untouched.
    const alerts = await db.select({ kind: alertLog.kind }).from(alertLog).where(eq(alertLog.day, day));
    const caused = alerts.map((row) => row.kind).filter((kind) => !alertKindsBefore.includes(kind));
    if (caused.length > 0) {
      await db.delete(alertLog).where(and(eq(alertLog.day, day), inArray(alertLog.kind, caused)));
    }
  }

  registry.withAudioPort(null);
  for (const [variable, value] of keySnapshot) {
    if (value === undefined) delete process.env[variable];
    else process.env[variable] = value;
  }

  await pool.end();
});

describe('POST /api/v1/transcribe', () => {
  it('refuses an oversized upload with 413 before any provider call', { skip: !DB_HOST ? 'DB_HOST is not set, this case needs a database' : false },
    async () => {
      providerCalls.length = 0;
      const oversized = new Uint8Array(MAX_AUDIO_BYTES + 1024).fill(3);

      const response = await post({ body: oversized, ip: freshIp(), declaredLength: oversized.byteLength });
      const body = await readBody(response);

      assert.equal(response.status, 413, 'an oversized clip is refused, not truncated');
      assert.equal(body.state, 'refused');
      assert.equal(body.error, 'audio-too-large');
      assert.ok(body.messageKey, 'the reader gets a catalogue key, never a raw status');
      assert.equal(providerCalls.length, 0, 'nothing over the cap may reach the provider');
    },
  );

  it('refuses a burst past the per-IP hourly limit with 429', { skip: !DB_HOST ? 'DB_HOST is not set, this case needs a database' : false },
    async () => {
      providerCalls.length = 0;
      const ip = freshIp();

      // The whole allowance, one request at a time. Each of these is allowed by
      // the limiter and then stops at the configuration check, because the
      // provider keys are cleared for this file: no money is reserved and no
      // call is made.
      for (let attempt = 0; attempt < TRIGGER_LIMIT_PER_IP_PER_HOUR; attempt += 1) {
        const allowed = await post({ body: SMALL_CLIP, ip });
        assert.notEqual(allowed.status, 429, `request ${attempt + 1} was refused before the limit was reached`);
      }

      const refused = await post({ body: SMALL_CLIP, ip });
      const body = await readBody(refused);

      assert.equal(refused.status, 429, 'the request past the limit is refused');
      assert.equal(body.error, 'rate-limited');
      assert.equal(providerCalls.length, 0, 'no burst request may reach the provider');
    },
  );

  it('declines with a message rather than a 500 at the daily budget cap', { skip: !DB_HOST ? 'DB_HOST is not set, this case needs a database' : false },
    async () => {
      providerCalls.length = 0;
      // A key must be present, otherwise the request would stop at the
      // configuration check and never reach the cap this case is about. It is
      // not a credential: the provider is the injected fake.
      process.env.OPENROUTER_API_KEY = 'test-key-not-a-credential';

      // The day is spent, exactly as it would be after a busy afternoon. The
      // row is restored in `after`.
      const day = utcDay(new Date());
      await db.insert(dailyBudget).values({ day }).onConflictDoNothing();
      await db
        .update(dailyBudget)
        .set({ reservedUsd: '0.000000', spentUsd: DAILY_BUDGET_USD.toFixed(6) })
        .where(eq(dailyBudget.day, day));

      const response = await post({ body: SMALL_CLIP, ip: freshIp() });
      const body = await readBody(response);

      delete process.env.OPENROUTER_API_KEY;

      assert.equal(response.status, 429, 'the cap declines, it does not error');
      assert.ok(response.status < 500, 'a spent budget must never read as a server fault');
      assert.equal(body.state, 'refused');
      assert.equal(body.error, 'budget-exhausted');
      assert.ok(body.messageKey, 'the reader is told what to do instead, in their own language');
      assert.equal(providerCalls.length, 0, 'a refused reservation must never reach the provider');

      // The refusal is counted, so a cap set too low does not look like a quiet
      // day on the admin page.
      const rejections = await db
        .select({ count: abuseRejections.count })
        .from(abuseRejections)
        .where(and(eq(abuseRejections.day, day), eq(abuseRejections.reason, 'budget')));
      assert.ok((rejections[0]?.count ?? 0) > 0, 'the budget refusal is recorded');
    },
  );
});

// A guard against the isolation above rotting: `windowStart` is what makes the
// deleted keys the right ones, and a change to the window would leave this
// file's rows behind in a developer's database.
describe('the counter rows this file creates are the ones it deletes', () => {
  it('derives its keys from the same window the route counted under', { skip: !DB_HOST ? 'DB_HOST is not set, this case needs a database' : false },
    async () => {
      if (createdCounterKeys.length === 0) return;
      const rows = await db
        .select({ key: abuseCounters.key })
        .from(abuseCounters)
        .where(
          and(inArray(abuseCounters.key, createdCounterKeys), eq(abuseCounters.windowStart, windowStart(new Date()))),
        );
      assert.ok(rows.length > 0, 'the keys this file will delete are the keys the route wrote');
    },
  );
});
