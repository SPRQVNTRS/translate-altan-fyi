/**
 * The enrichment job payload: the privacy boundary, pinned.
 *
 * WHY THIS FILE IS WORTH ITS OWN TEST
 *   A queued enrichment job carries a headword and a language pair, and nothing
 *   about who asked. That is a product claim, and the only thing enforcing it is
 *   `z.strictObject`. A single well-meaning edit, adding `accountId` so a later
 *   feature can attribute a job, would break the claim while every other test in
 *   the repo stayed green. Both halves are asserted here: the runtime parse
 *   REJECTS an identity field, and a compile-time check fails `tsc` if one is
 *   ever added to the type.
 *
 * NO DATABASE, NO NETWORK. Both come from `app/lib/enrichment/job-payload`,
 * which has no server import: `enqueue.server` re-exports them, but importing it
 * here would reach the orchestrator and open a database pool, and the unit tier
 * runs with no database.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  enrichmentJobPayloadSchema,
  enrichmentSingletonKey,
  type EnrichmentJobPayload,
} from '../../app/lib/enrichment/job-payload';

const VALID: EnrichmentJobPayload = {
  headwordId: '3f1d0b5a-0000-4000-8000-000000000001',
  from: 'de',
  to: 'en',
  promptVersion: 1,
};

/**
 * A COMPILE-TIME assertion, not a runtime one. `K` is a naked type parameter, so
 * the conditional distributes and EITHER key being present resolves the alias to
 * `never`, which no value can be assigned to. Adding an identity field to the
 * payload therefore fails `pnpm typecheck`, not only the case below.
 */
type KeyAbsent<K extends string, T> = K extends keyof T ? never : true;
const accountIdAbsent: KeyAbsent<'accountId', EnrichmentJobPayload> = true;
const userIdAbsent: KeyAbsent<'userId', EnrichmentJobPayload> = true;

describe('enrichmentJobPayloadSchema', () => {
  it('accepts a headword, a direction and a prompt version', () => {
    assert.deepEqual(enrichmentJobPayloadSchema.parse(VALID), VALID);
    assert.equal(accountIdAbsent, true);
    assert.equal(userIdAbsent, true);
  });

  it('rejects an accountId, because a queue row may not name who asked', () => {
    const result = enrichmentJobPayloadSchema.safeParse({ ...VALID, accountId: 'x' });
    assert.equal(result.success, false, 'an accountId reached the queue payload');
    assert.match(
      JSON.stringify(result.error?.issues ?? []),
      /accountId/,
      'the rejection did not name the offending key',
    );
  });

  it('rejects a userId for the same reason', () => {
    const result = enrichmentJobPayloadSchema.safeParse({ ...VALID, userId: 1 });
    assert.equal(result.success, false, 'a userId reached the queue payload');
  });

  it('rejects a language the dictionary does not serve', () => {
    const result = enrichmentJobPayloadSchema.safeParse({ ...VALID, from: 'fr' });
    assert.equal(result.success, false, 'an unserved language code was accepted');
  });

  it('rejects a prompt version that is not a positive integer', () => {
    assert.equal(enrichmentJobPayloadSchema.safeParse({ ...VALID, promptVersion: 0 }).success, false);
    assert.equal(enrichmentJobPayloadSchema.safeParse({ ...VALID, promptVersion: 1.5 }).success, false);
  });
});

describe('enrichmentSingletonKey', () => {
  it('joins the headword, the direction and the prompt version', () => {
    assert.equal(
      enrichmentSingletonKey(VALID),
      `${VALID.headwordId}:de:en:1`,
    );
  });

  it('separates two prompt versions, so a re-worded prompt is not deduped away', () => {
    const next: EnrichmentJobPayload = { ...VALID, promptVersion: VALID.promptVersion + 1 };
    assert.notEqual(enrichmentSingletonKey(VALID), enrichmentSingletonKey(next));
  });

  it('separates the two directions of one headword', () => {
    const reversed: EnrichmentJobPayload = { ...VALID, from: 'en', to: 'de' };
    assert.notEqual(enrichmentSingletonKey(VALID), enrichmentSingletonKey(reversed));
  });
});
