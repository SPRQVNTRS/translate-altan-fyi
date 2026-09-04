/**
 * A signed-out `POST /api/v1/transcribe` is refused, politely (M184 spec 03).
 *
 * WHAT WAS REVERSED HERE, AND WHY IT IS WORTH A TEST
 *   This route's own doc comment used to state, as a design decision, that
 *   there is no account gate on it: anybody may speak a word. M184 reverses
 *   that. It is the cheapest way into this product's spend, one provider call
 *   per request, guarded until now only by an hourly rate limit and a shared
 *   daily cap, and the milestone exists to stop anonymous strangers spending
 *   the operator's money. Because the old behaviour was deliberate rather than
 *   an oversight, a test is what stops somebody reading the old paragraph in a
 *   diff and putting it back.
 *
 * A REFUSAL, NOT A REDIRECT, AND NOT A 500
 *   The caller is a `fetch` from the voice control, which cannot follow a
 *   redirect to a sign-in page and make anything of it. So the assertions below
 *   are about the shape of the answer as much as the status: the same
 *   `{ state: 'refused' }` union every other refusal on this route uses, with a
 *   `messageKey` the client resolves against `app/locales/*`, because a person
 *   holding a microphone cannot act on a stack trace.
 *
 * THE SECOND CASE PROVES THE FIRST ONE MEANS SOMETHING
 *   A signed-in caller must get PAST the account gate. It sends an empty body
 *   with a valid audio content type, so it lands on the `empty-audio` refusal
 *   three guards later: a different answer, reached only by a caller the gate
 *   admitted. NO PROVIDER IS REACHED on either path, because the body never
 *   survives the emptiness check, so this file cannot spend anything even on a
 *   machine with a live key.
 *
 * ISOLATION
 *   One account and one invite, from the shared fixture, removed in `after()`.
 *   The signed-in request touches the shared hourly counters, so it carries a
 *   documentation-range address and the counter rows it creates are deleted by
 *   key.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inArray } from 'drizzle-orm';
import { RouterContextProvider } from 'react-router';
import { z } from 'zod';

import { closePool, poolInitialized } from '../../drizzle/db';
import { getRawDb } from '../../drizzle/db';
import { abuseCounters } from '../../drizzle/schema';
import { counterKey } from '../../app/lib/abuse/rate-limit.server';
import { action as transcribe } from '../../app/routes/api.v1.transcribe';
import { createTestAccountSession, type TestAccountSession } from '../fixtures/account-session';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

/**
 * Only the fields these cases read.
 *
 * A full transcription of the response union would be a second definition of
 * the route's own type that could drift from it silently, and the two facts
 * asserted here are that the answer is a refusal and which refusal it is.
 */
const refusalSchema = z.object({
  state: z.literal('refused'),
  error: z.string(),
  messageKey: z.string(),
});

let session: TestAccountSession | null = null;
const createdCounterKeys: string[] = [];

/** One octet of a documentation-range address. */
function octet(): number {
  return 1 + Math.floor(Math.random() * 250);
}

/** One POST with an empty but well-typed audio body, with or without a session. */
async function post(cookie: string | null): Promise<Response> {
  const ip = `198.51.${octet()}.${octet()}`;
  createdCounterKeys.push(counterKey('ip', ip));
  // Built with `Headers` rather than a literal, so a signed-out request carries
  // no `cookie` header at all rather than an empty one. The two are different
  // requests, and only the first is what a stranger's browser sends.
  const headers = new Headers({ 'content-type': 'audio/webm', 'x-forwarded-for': ip });
  if (cookie !== null) headers.set('cookie', cookie);
  const request = new Request('https://translate.altan.fyi/api/v1/transcribe', {
    method: 'POST',
    headers,
    body: new Uint8Array(0),
  });
  return transcribe({
    request,
    url: new URL(request.url),
    params: {},
    pattern: '/api/v1/transcribe',
    context: new RouterContextProvider(),
  });
}

before(async () => {
  if (!DB_HOST) return;
  session = await createTestAccountSession('transcribe');
});

after(async () => {
  if (DB_HOST && createdCounterKeys.length > 0) {
    await db.delete(abuseCounters).where(inArray(abuseCounters.key, createdCounterKeys));
  }
  if (session !== null) await session.dispose();
  // THE POOL FINISHES OPENING BEFORE IT IS CLOSED. `drizzle/db.ts` kicks off
  // `ensureHostIndexes` behind `poolInitialized` at import time, and a short
  // test file can reach `closePool()` first, which turns a passing run into
  // "Cannot use a pool after calling end on the pool" reported as a failure.
  await poolInitialized;
  await closePool();
});

describe('anonymous transcription', () => {
  it('is refused with a 401 and a translatable message', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const response = await post(null);

    assert.equal(
      response.status,
      401,
      'POST /api/v1/transcribe served a caller with no account. This route calls a provider on every request, ' +
        "and it is the cheapest way into this installation's spend.",
    );

    const body = refusalSchema.parse(await response.json());
    assert.equal(body.error, 'account-required');
    assert.ok(body.messageKey.startsWith('voice.'), 'the refusal carries no catalogue key, so the client shows a raw status');
  });

  it('lets a signed-in caller past the account gate', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    // THE MEASUREMENT CHAIN. Without this, a route that refused every request
    // for any reason would pass the case above, and voice input would be dead
    // for the invited readers it is meant for.
    assert.ok(session !== null, 'the fixture account was not created, so this case would prove nothing');

    const response = await post(session.cookie);
    const body = refusalSchema.parse(await response.json());

    assert.notEqual(
      body.error,
      'account-required',
      'a real, invited, signed-in account was still told it needs an account',
    );
    // The empty body is refused three guards later, which is the evidence the
    // request got past the gate rather than the evidence of anything else.
    assert.equal(body.error, 'empty-audio');
  });
});
