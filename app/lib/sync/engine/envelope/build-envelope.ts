/**
 * Framing a payload for the wire, and reading one back.
 *
 * IT IS PLAIN FRAMING NOW, NOT CRYPTO (M191). This module used to compress,
 * encrypt under the account's data key and bind the AAD; the server may read
 * the document since the encrypted layer was removed, so what is left is the
 * two lines that put the schema version beside the payload and the decoder
 * that refuses a shape this build cannot read.
 *
 * THE DECODER REFUSES RATHER THAN GUESSES. A document written by a newer build
 * carries fields this one would drop, and a dropped field is pushed back up as
 * the new truth on the next cycle, so an older device would silently delete a
 * newer one's words. `local-store-bridge.ts` makes the same argument about the
 * snapshot itself.
 */
import { z } from 'zod';

import { jsonValueSchema, type JsonValue } from '#app/lib/json';
import { SyncRequestError } from '#app/lib/sync/sync-error';
import type { DataEnvelope, SyncPayload } from './types';

const syncMetaSchema = z.object({
  perEntity: z.record(z.string(), z.object({ lamport: z.number().int(), deviceId: z.string() })),
  tombstones: z.array(
    z.object({
      entityId: z.string(),
      entityType: z.string(),
      lamport: z.number().int(),
      deviceId: z.string(),
    }),
  ),
});

const envelopeSchema = z.object({
  payloadSchemaVersion: z.number().int().positive(),
  blobVersion: z.number().int().nonnegative(),
  payload: z.object({ snapshot: jsonValueSchema, syncMeta: syncMetaSchema }),
});

/**
 * Frames a payload for storage.
 *
 * @param input.payload the snapshot and its sync metadata.
 * @param input.blobVersion the version this document will be stored as.
 * @param input.payloadSchemaVersion the local store's schema version.
 * @returns the envelope, ready to be sent as JSON.
 */
export function buildEnvelope(input: {
  payload: SyncPayload;
  blobVersion: number;
  payloadSchemaVersion: number;
}): DataEnvelope {
  return {
    payloadSchemaVersion: input.payloadSchemaVersion,
    blobVersion: input.blobVersion,
    payload: input.payload,
  };
}

/**
 * Reads a stored envelope.
 *
 * @param value whatever the pull answered with.
 * @returns the payload and the schema version it was written under.
 * @throws a `SyncRequestError` of kind `invalid` when the shape is not one this
 *   build can read.
 */
export function parseEnvelope(value: JsonValue): DataEnvelope {
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) {
    throw new SyncRequestError({
      kind: 'invalid',
      message: 'The synced data on the server is not in a shape this device can read.',
    });
  }
  return parsed.data;
}
