/**
 * COPIED, NOT SHARED. Source: openplate-sync/tests/unit/storage-conflict.test.ts @ 311a1578af3ca169e8a08c6d50d90889e29d5889.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * The unique-violation predicate every CAS path depends on. Kept in its own
 * DB-free module precisely so this test can exist without a Postgres.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POSTGRES_UNIQUE_VIOLATION_CODE, isUniqueViolation } from '#app/lib/e2ee/storage-conflict';

test('a pg error carrying 23505 is a unique violation', () => {
  assert.equal(isUniqueViolation({ code: POSTGRES_UNIQUE_VIOLATION_CODE }), true);
});

test('anything else is not, and nothing throws on odd input', () => {
  // Getting this wrong in either direction is bad: a false positive turns a
  // real fault into a silent "conflict", a false negative turns a routine
  // race into a 500.
  assert.equal(isUniqueViolation({ code: '23503' }), false);
  assert.equal(isUniqueViolation(new Error('boom')), false);
  assert.equal(isUniqueViolation(null), false);
  assert.equal(isUniqueViolation(undefined), false);
  assert.equal(isUniqueViolation('23505'), false);
});
