/**
 * The pure half of the trigger rate limit: the window, the address and the key.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   Three functions in `app/lib/abuse/rate-limit.server.ts` decide WHICH ROW a
 *   request is counted against. Nothing downstream can repair a wrong answer
 *   from any of them, and none of the three fails loudly when it is wrong.
 *
 *   1. `windowStart` floors the clock to the hour in UTC. A window that moved
 *      with the server's zone would put two processes on two different rows for
 *      the same request, and each would then have its own allowance.
 *   2. `clientIp` takes the LAST entry of `X-Forwarded-For`, because this
 *      deployment is Traefik straight to Node and that is the entry the proxy
 *      itself appended. Taking the FIRST entry, which is the usual reflex, lets
 *      any caller mint a fresh bucket per request by inventing an address, and
 *      the whole file is then defeated by one line of curl. Both spellings pass
 *      a test that only ever sends one entry, so a multi-entry header is sent
 *      here and the FIRST entry is asserted absent.
 *   3. `counterKey` returns a peppered hash behind a scope prefix. The raw
 *      address must not appear anywhere in the string, because the key is
 *      written to `abuse_counters` and a table of raw addresses is the search
 *      log the whole schema exists not to keep.
 *
 *   The fourth case is a SOURCE INSPECTION, in the style of
 *   `tests/unit/design-rules.test.ts`. `drizzle/schema/abuse.ts` claims that no
 *   row it holds names a headword or an account, and no type and no lint rule
 *   can hold that claim: a future edit that threads an account id into the
 *   counter for "better" limiting would type-check and pass every other test.
 *   Reading the two modules as text and refusing those four identifiers is the
 *   cheap mechanical guard. It reads CODE, not comments: both files DOCUMENT the
 *   rule in prose, so a whole-file grep would fail on the very sentence that
 *   states it.
 *
 * NO DATABASE. `rate-limit.server.ts` imports `#drizzle/db`, which
 * imports `drizzle/db.ts`, which CONNECTS at module load and retries for about a
 * minute before giving up. The unit tier runs with no database, so that import
 * is mocked out before the module under test is loaded. Only the pure functions
 * are exercised here; everything that touches a row belongs to the integration
 * tier.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The mock must be installed BEFORE the module under test is imported, so the
// import below is dynamic and this call is at the top level. `getRawDb` throws
// rather than returning a stub: nothing in this file may reach it, and a case
// that did should fail loudly instead of exercising a fake.
mock.module('#drizzle/db', {
  namedExports: {
    getRawDb: () => {
      throw new Error('the unit tier must not reach a database');
    },
  },
});

const { clientIp, counterKey, windowStart, TRIGGER_WINDOW_MS } = await import('#app/lib/abuse/rate-limit.server');

const RATE_LIMIT_SOURCE = fileURLToPath(new URL('../../app/lib/abuse/rate-limit.server.ts', import.meta.url));
const BUDGET_SOURCE = fileURLToPath(new URL('../../app/lib/abuse/budget.server.ts', import.meta.url));

/**
 * The identifiers that would turn an anonymous counter into a record of who
 * looked up what. The list is the schema file's own sentence, in identifier form.
 */
const FORBIDDEN_IDENTIFIERS = ['headword', 'accountid', 'userid', 'senseid'] as const;

/** Block comments and line comments removed, so a rule can be stated in prose without tripping itself. */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/\/\/[^\n]*/g, ' ');
}

/** A request carrying only the headers a case sets. */
function requestWith(headers: Record<string, string>): Request {
  return new Request('https://kenning.altan.fyi/entry/x', { headers });
}

describe('abuse: hourly window arithmetic', () => {
  it('floors an instant in the middle of an hour to the top of that hour', () => {
    const floored = windowStart(new Date('2026-03-05T13:37:42.123Z'));

    assert.equal(floored.toISOString(), '2026-03-05T13:00:00.000Z');
    assert.equal(floored.getUTCMinutes(), 0);
    assert.equal(floored.getUTCSeconds(), 0);
    assert.equal(floored.getUTCMilliseconds(), 0);
  });

  it('leaves an instant exactly on the hour alone', () => {
    // The idempotence case. A floor that added or subtracted an hour at the
    // boundary would move every request that arrived on the hour into its
    // neighbour's bucket, and would be invisible in the case above.
    const onTheHour = new Date('2026-03-05T13:00:00.000Z');
    assert.equal(windowStart(onTheHour).getTime(), onTheHour.getTime());
  });

  it('keeps an instant just after midnight in that day, and one just before it in the previous day', () => {
    const justAfterMidnight = windowStart(new Date('2026-03-06T00:17:00.000Z'));
    assert.equal(justAfterMidnight.toISOString(), '2026-03-06T00:00:00.000Z');
    assert.equal(justAfterMidnight.getUTCDate(), 6);

    const justBeforeMidnight = windowStart(new Date('2026-03-05T23:55:00.000Z'));
    assert.equal(justBeforeMidnight.toISOString(), '2026-03-05T23:00:00.000Z');
    assert.equal(justBeforeMidnight.getUTCDate(), 5);
  });

  it('puts two instants one hour apart in two different windows, and two in one hour in one', () => {
    const early = new Date('2026-03-05T13:05:00.000Z');
    const late = new Date('2026-03-05T13:59:59.999Z');
    const next = new Date('2026-03-05T14:00:00.000Z');

    assert.equal(windowStart(early).getTime(), windowStart(late).getTime());
    assert.notEqual(windowStart(early).getTime(), windowStart(next).getTime());
    assert.equal(windowStart(next).getTime() - windowStart(early).getTime(), TRIGGER_WINDOW_MS);
  });
});

describe('abuse: client address at trust depth 1', () => {
  it('returns the only entry of a single-entry header', () => {
    assert.equal(clientIp(requestWith({ 'x-forwarded-for': '203.0.113.7' })), '203.0.113.7');
  });

  it('returns the LAST entry of a spoofed multi-entry header, never the first', () => {
    // THE CASE THIS FILE EXISTS FOR. Everything before the last entry is
    // whatever the caller chose to send. Taking the first entry gives a fresh
    // bucket for every invented address, so the limit counts nothing.
    const spoofed = '10.0.0.1, 198.51.100.9, 203.0.113.7';
    const resolved = clientIp(requestWith({ 'x-forwarded-for': spoofed }));

    assert.equal(resolved, '203.0.113.7');
    assert.notEqual(
      resolved,
      '10.0.0.1',
      'the first entry of X-Forwarded-For was taken, so any caller can mint a new rate-limit bucket per request',
    );
  });

  it('trims whitespace around the entry it takes', () => {
    assert.equal(clientIp(requestWith({ 'x-forwarded-for': '198.51.100.9,   203.0.113.7   ' })), '203.0.113.7');
    assert.equal(clientIp(requestWith({ 'x-forwarded-for': '  203.0.113.7  ' })), '203.0.113.7');
  });

  it('returns null when the header is absent or carries nothing usable', () => {
    // A missing address is not a rejection anywhere downstream: it means the
    // address guard does not apply. Returning a placeholder string instead of
    // null would put every proxy-less request into ONE shared bucket.
    assert.equal(clientIp(requestWith({})), null);
    assert.equal(clientIp(requestWith({ 'x-forwarded-for': '' })), null);
    assert.equal(clientIp(requestWith({ 'x-forwarded-for': ' , , ' })), null);
  });
});

describe('abuse: counter key', () => {
  it('carries the scope prefix and never the raw address', () => {
    const address = '203.0.113.7';
    const key = counterKey('ip', address);

    assert.ok(key.startsWith('ip:'), `the key '${key}' does not carry the 'ip:' scope prefix`);
    assert.ok(
      !key.includes(address),
      `the key '${key}' contains the raw address, so abuse_counters becomes a readable list of visitors`,
    );
  });

  it('carries the session prefix and never the raw cookie value', () => {
    const cookieValue = 'eyJ1c2VyIjp7ImlkIjo0NzExfX0.fakeSignature';
    const key = counterKey('session', cookieValue);

    assert.ok(key.startsWith('session:'), `the key '${key}' does not carry the 'session:' scope prefix`);
    assert.ok(
      !key.includes(cookieValue),
      'the key contains the raw session cookie value, which would make the counter table replayable as a credential',
    );
    // Any recognisable fragment is as bad as the whole value.
    assert.ok(!key.includes('fakeSignature'));
  });

  it('is stable for one value and different for the same value under the other scope', () => {
    const value = '203.0.113.7';

    assert.equal(counterKey('ip', value), counterKey('ip', value));
    assert.notEqual(
      counterKey('ip', value),
      counterKey('session', value),
      'the two scopes hash to the same digest, so one string used as both an address and a session shares one bucket',
    );
    assert.notEqual(counterKey('ip', value), counterKey('ip', '203.0.113.8'));
  });
});

describe('abuse: the guard modules name no reader and no word', () => {
  for (const path of [RATE_LIMIT_SOURCE, BUDGET_SOURCE]) {
    it(`${path.split('/').slice(-1).join('')} mentions no headword, account, user or sense identifier`, () => {
      const source = readFileSync(path, 'utf8');
      const code = stripComments(source);

      // Vacuity guard. A stripper that ate the whole file would make every
      // assertion below pass while reading nothing.
      assert.ok(code.length > 800, `only ${code.length} characters of code survived comment stripping in ${path}`);
      assert.ok(code.includes('export'), `no export survived comment stripping in ${path}`);

      const lowered = code.toLowerCase();
      for (const identifier of FORBIDDEN_IDENTIFIERS) {
        assert.ok(
          !lowered.includes(identifier),
          `${path} names '${identifier}' in code. The abuse tables are anonymous by rule: a counter that can ` +
            'be joined back to a reader or to a word is the search log the schema exists not to keep. ' +
            'See the file comment in drizzle/schema/abuse.ts.',
        );
      }
    });
  }
});
