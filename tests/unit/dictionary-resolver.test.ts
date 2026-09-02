/**
 * `resolveEntry` decision logic, with no database in sight.
 *
 * WHY THIS FILE EXISTS
 *   Published ids are permanent and public, so a request can carry a live id, a
 *   retired id, an id that never existed, or plain nonsense. Every one of those
 *   is an ordinary input, and none of them may throw: a throw here is a 500 on
 *   what is really a bad URL.
 *
 *   Resolution reads the database through the small `EntryLookups` port, which
 *   is what makes these cases testable as pure decisions. The stub below is
 *   hand written on purpose: no mocking library, so the test states exactly
 *   what the database would answer, and can also record what it was asked.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEntry,
  type EntryEntity,
  type EntryLookups,
} from '../../app/lib/dictionary/queries.server';

const LIVE_HEADWORD = '11111111-1111-4111-8111-111111111111';
const LIVE_SENSE = '22222222-2222-4222-8222-222222222222';
const RETIRED_ONCE = '33333333-3333-4333-8333-333333333333';
/** The replacement for RETIRED_ONCE. Itself retired, which is the chain case. */
const RETIRED_TWICE = '44444444-4444-4444-8444-444444444444';
const FINAL_REPLACEMENT = '55555555-5555-4555-8555-555555555555';
const UNKNOWN_UUID = '66666666-6666-4666-8666-666666666666';

interface StubLookups extends EntryLookups {
  /** How many times each port method was called, so a guard can be proven to run first. */
  readonly calls: { findEntity: number; findAlias: number };
}

/**
 * A fixed dictionary state:
 *   two live entities, and an alias chain RETIRED_ONCE -> RETIRED_TWICE -> FINAL_REPLACEMENT.
 * The chain exists so the single-hop rule has something to be wrong about.
 */
function createStubLookups(): StubLookups {
  const entities = new Map<string, EntryEntity>([
    [LIVE_HEADWORD, 'headword'],
    [LIVE_SENSE, 'sense'],
  ]);
  const aliases = new Map<string, string>([
    [RETIRED_ONCE, RETIRED_TWICE],
    [RETIRED_TWICE, FINAL_REPLACEMENT],
  ]);
  const calls = { findEntity: 0, findAlias: 0 };

  return {
    calls,
    findEntity(id: string): Promise<{ entity: EntryEntity; id: string } | null> {
      calls.findEntity += 1;
      const entity = entities.get(id);
      return Promise.resolve(entity ? { entity, id } : null);
    },
    findAlias(id: string): Promise<{ replacementId: string } | null> {
      calls.findAlias += 1;
      const replacementId = aliases.get(id);
      return Promise.resolve(replacementId ? { replacementId } : null);
    },
  };
}

describe('resolveEntry', () => {
  it('returns the entity for a live id', async () => {
    const lookups = createStubLookups();

    assert.deepEqual(await resolveEntry(lookups, LIVE_HEADWORD), {
      kind: 'found',
      entity: 'headword',
      id: LIVE_HEADWORD,
    });
    assert.deepEqual(await resolveEntry(lookups, LIVE_SENSE), {
      kind: 'found',
      entity: 'sense',
      id: LIVE_SENSE,
    });
  });

  it('redirects a retired id to its replacement', async () => {
    const lookups = createStubLookups();

    assert.deepEqual(await resolveEntry(lookups, RETIRED_ONCE), {
      kind: 'redirect',
      replacementId: RETIRED_TWICE,
    });
  });

  it('reports an unknown id as missing', async () => {
    const lookups = createStubLookups();

    assert.deepEqual(await resolveEntry(lookups, UNKNOWN_UUID), { kind: 'missing' });
  });

  it('follows exactly one alias hop, never the chain', async () => {
    // RETIRED_ONCE points at RETIRED_TWICE, which itself points at
    // FINAL_REPLACEMENT. Resolution stops at the first replacement.
    //
    // Following the chain would mean looping over data this code does not
    // control, and `a -> b -> a` would hang a request handler holding a
    // database connection rather than fail. A replacement that is itself
    // retired is a data problem, repaired by repointing the older alias.
    const lookups = createStubLookups();

    const resolved = await resolveEntry(lookups, RETIRED_ONCE);

    assert.deepEqual(resolved, { kind: 'redirect', replacementId: RETIRED_TWICE });
    assert.notDeepEqual(
      resolved,
      { kind: 'redirect', replacementId: FINAL_REPLACEMENT },
      'resolveEntry followed the alias chain past its first hop',
    );
    assert.equal(lookups.calls.findAlias, 1, 'exactly one alias read per resolution');
  });

  it('reports a malformed id as missing without asking the database', async () => {
    // The guard runs before any query, so a typo in a URL costs no round trip
    // and Postgres never raises 22P02 for an unparseable uuid.
    const lookups = createStubLookups();

    assert.deepEqual(await resolveEntry(lookups, 'not-a-uuid'), { kind: 'missing' });
    assert.deepEqual(await resolveEntry(lookups, ''), { kind: 'missing' });
    assert.deepEqual(await resolveEntry(lookups, '11111111-1111-4111-8111'), { kind: 'missing' });
    assert.deepEqual(await resolveEntry(lookups, "'; drop table headwords; --"), {
      kind: 'missing',
    });

    assert.equal(lookups.calls.findEntity, 0, 'a malformed id must not reach the database');
    assert.equal(lookups.calls.findAlias, 0, 'a malformed id must not reach the database');
  });

  it('never throws, whatever the id looks like', async () => {
    const lookups = createStubLookups();
    const ids = [
      LIVE_HEADWORD,
      RETIRED_ONCE,
      RETIRED_TWICE,
      UNKNOWN_UUID,
      'not-a-uuid',
      '',
      '00000000-0000-0000-0000-000000000000',
    ];

    for (const id of ids) {
      await assert.doesNotReject(
        () => resolveEntry(lookups, id),
        `resolveEntry threw for id ${JSON.stringify(id)}`,
      );
    }
  });
});
