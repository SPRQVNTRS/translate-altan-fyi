/**
 * The translation job payload: the privacy boundary, pinned.
 *
 * WHY THIS FILE IS WORTH ITS OWN TEST
 *   A queued translation job carries a headword, a language pair, a prompt
 *   version and the run row it reports into, and nothing about who asked. That
 *   is a product claim, and the only thing enforcing it is `z.strictObject`. A
 *   single well-meaning edit, adding `accountId` so a later feature can
 *   attribute a job, would break the claim while every other test in the repo
 *   stayed green. Both halves are asserted here: the runtime parse REJECTS an
 *   identity field, and a compile-time check fails `tsc` if one is ever added to
 *   the type.
 *
 * THE SINGLETON KEY IS PINNED FIELD BY FIELD, and the run id's ABSENCE from it
 * is pinned too. That absence is the whole dedupe: the run id is fresh on every
 * request by construction, so a key that included it would be unique every time
 * and two readers asking the same question would pay twice.
 *
 * NO DATABASE, NO NETWORK. Both come from `app/lib/translation/job-payload`,
 * which has no server import: `enqueue.server` re-exports them, but importing it
 * here would reach the orchestrator and open a database pool, and the unit tier
 * runs with no database.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  translationJobPayloadSchema,
  translationSingletonKey,
  type TranslationJobPayload,
} from '../../app/lib/translation/job-payload';

const VALID: TranslationJobPayload = {
  headwordId: '99a991dc-8e80-4b65-82e5-effbbaf84269',
  from: 'de',
  to: 'tr',
  promptVersion: 1,
  runId: '7c0d1e2f-0000-4000-8000-000000000001',
};

/**
 * A COMPILE-TIME assertion, not a runtime one. `K` is a naked type parameter, so
 * the conditional distributes and EITHER key being present resolves the alias to
 * `never`, which no value can be assigned to. Adding an identity field to the
 * payload therefore fails `pnpm typecheck`, not only the case below.
 */
type KeyAbsent<K extends string, T> = K extends keyof T ? never : true;
const accountIdAbsent: KeyAbsent<'accountId', TranslationJobPayload> = true;
const userIdAbsent: KeyAbsent<'userId', TranslationJobPayload> = true;

describe('translationJobPayloadSchema', () => {
  it('accepts a headword, a direction, a prompt version and a run id', () => {
    assert.deepEqual(translationJobPayloadSchema.parse(VALID), VALID);
    assert.equal(accountIdAbsent, true);
    assert.equal(userIdAbsent, true);
  });

  it('rejects an accountId, because a queue row may not name who asked', () => {
    const result = translationJobPayloadSchema.safeParse({ ...VALID, accountId: 'x' });
    assert.equal(result.success, false, 'an accountId reached the queue payload');
    assert.match(
      JSON.stringify(result.error?.issues ?? []),
      /accountId/,
      'the rejection did not name the offending key',
    );
  });

  it('rejects a userId for the same reason', () => {
    const result = translationJobPayloadSchema.safeParse({ ...VALID, userId: 1 });
    assert.equal(result.success, false, 'a userId reached the queue payload');
  });

  it('rejects any extra key at all, which is what makes the rule enforceable', () => {
    // Not an identity field, and still refused. The claim is not "we remembered
    // to ban two names", it is "the shape is closed", and a schema that only
    // rejected the two names above would let the third one through.
    const result = translationJobPayloadSchema.safeParse({ ...VALID, sessionFingerprint: 'abc' });
    assert.equal(result.success, false, 'an unlisted key reached the queue payload');
  });

  it('rejects a language the dictionary does not serve', () => {
    assert.equal(translationJobPayloadSchema.safeParse({ ...VALID, from: 'fr' }).success, false);
    assert.equal(translationJobPayloadSchema.safeParse({ ...VALID, to: 'ru' }).success, false);
  });

  it('rejects a prompt version that is not a positive integer', () => {
    assert.equal(translationJobPayloadSchema.safeParse({ ...VALID, promptVersion: 0 }).success, false);
    assert.equal(translationJobPayloadSchema.safeParse({ ...VALID, promptVersion: 1.5 }).success, false);
  });

  it('rejects a missing run id, because every exit path has to report into one', () => {
    const { runId: _dropped, ...withoutRun } = VALID;
    assert.equal(translationJobPayloadSchema.safeParse(withoutRun).success, false);
    assert.equal(translationJobPayloadSchema.safeParse({ ...VALID, runId: '' }).success, false);
  });
});

describe('translationSingletonKey', () => {
  it('names the headword, both languages and the prompt version', () => {
    assert.equal(translationSingletonKey(VALID), `${VALID.headwordId}:de:tr:1`);
  });

  it('leaves the run id out, or the dedupe could never fire', () => {
    const second: TranslationJobPayload = { ...VALID, runId: 'a-completely-different-run' };
    assert.equal(
      translationSingletonKey(VALID),
      translationSingletonKey(second),
      'two readers asking the same question produced two different keys, so both would pay',
    );
  });

  it('carries no account id, in the key as well as in the payload', () => {
    // The key is written into `pgboss.job.singleton_key`, which is a second
    // place a reader identity could end up. Asserting the payload alone would
    // miss it.
    assert.equal(translationSingletonKey(VALID).includes('account'), false);
    assert.equal(translationSingletonKey(VALID).split(':').length, 4);
  });

  it('separates two prompt versions, so a re-worded prompt is not deduped away', () => {
    const next: TranslationJobPayload = { ...VALID, promptVersion: VALID.promptVersion + 1 };
    assert.notEqual(translationSingletonKey(VALID), translationSingletonKey(next));
  });

  it('separates the two directions of one headword', () => {
    const reversed: TranslationJobPayload = { ...VALID, from: 'tr', to: 'de' };
    assert.notEqual(translationSingletonKey(VALID), translationSingletonKey(reversed));
  });
});
