/**
 * The capacity-cliff telemetry (PROTOCOL.md §8).
 *
 * THE THRESHOLD MUST STAY DERIVED. `BLOB_SIZE_WARN_BYTES` exists so that
 * raising `MAX_BLOB_BYTES` moves the warning band with it. Asserting a
 * hardcoded byte count here would let the two drift apart in silence: the cap
 * would double, the constant would keep its old value, and the warning that is
 * supposed to arrive months before the first hard `413` would start firing at
 * 40% of the cap instead of 80%. So every assertion below is written against
 * `MAX_BLOB_BYTES` and `BLOB_SIZE_WARN_RATIO`, never against a literal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOB_SIZE_WARN_BYTES,
  BLOB_SIZE_WARN_RATIO,
  blobCapacityPercent,
  shouldWarnBlobSize,
} from '#app/lib/e2ee/blob-size-telemetry';
import { MAX_BLOB_BYTES } from '#app/lib/e2ee/protocol';

test('the warning threshold is derived from the cap, not pinned to a byte count', () => {
  assert.equal(
    BLOB_SIZE_WARN_BYTES,
    Math.floor(MAX_BLOB_BYTES * BLOB_SIZE_WARN_RATIO),
    'the warning threshold has drifted away from the cap it is meant to track',
  );
  assert.ok(
    BLOB_SIZE_WARN_BYTES > 0 && BLOB_SIZE_WARN_BYTES < MAX_BLOB_BYTES,
    'the warning threshold does not sit below the cap, so the warning band is empty',
  );
  assert.ok(Number.isInteger(BLOB_SIZE_WARN_BYTES), 'the warning threshold is not a whole number of bytes');
});

test('the warning band opens well before the cap, so the cliff is visible for months', () => {
  // PROTOCOL.md §8 names ~80% as the trigger to start the chunked-blob work.
  assert.ok(
    BLOB_SIZE_WARN_RATIO > 0.5 && BLOB_SIZE_WARN_RATIO < 1,
    'the warning ratio leaves no useful gap between the first warning and the first 413',
  );
  assert.equal(blobCapacityPercent(BLOB_SIZE_WARN_BYTES), Math.round(BLOB_SIZE_WARN_RATIO * 100));
});

test('shouldWarnBlobSize is false just below the threshold and true at and above it', () => {
  assert.equal(shouldWarnBlobSize(BLOB_SIZE_WARN_BYTES - 1), false, 'a push below the band warned');
  assert.equal(shouldWarnBlobSize(BLOB_SIZE_WARN_BYTES), true, 'a push exactly at the threshold did not warn');
  assert.equal(shouldWarnBlobSize(BLOB_SIZE_WARN_BYTES + 1), true, 'a push inside the band did not warn');
  assert.equal(shouldWarnBlobSize(MAX_BLOB_BYTES), true, 'a push at the cap did not warn');
  assert.equal(shouldWarnBlobSize(0), false, 'an empty push warned');
});

test('blobCapacityPercent rounds to a whole percentage of the cap', () => {
  assert.equal(blobCapacityPercent(0), 0);
  assert.equal(blobCapacityPercent(MAX_BLOB_BYTES), 100);
  assert.equal(blobCapacityPercent(MAX_BLOB_BYTES / 2), 50);

  // The rounding itself, on both sides of a half. A truncating implementation
  // would report 50 for the first of these.
  assert.equal(blobCapacityPercent(Math.round(MAX_BLOB_BYTES * 0.505)), 51, 'a value above .5 rounded down');
  assert.equal(blobCapacityPercent(Math.round(MAX_BLOB_BYTES * 0.494)), 49, 'a value below .5 rounded up');
});
