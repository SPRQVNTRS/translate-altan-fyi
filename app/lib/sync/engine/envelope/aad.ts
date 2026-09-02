/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/engine/envelope/aad.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * Deterministic AAD (additional authenticated data) construction for the
 * data envelope (design spec D2). A canonical, fixed-key-order JSON
 * serialization is deterministic enough for this purpose (the fields are
 * always the same three small integers) — no custom binary framing needed.
 */
import type { EnvelopeAadFields } from './types';

export function buildEnvelopeAad(fields: EnvelopeAadFields): Uint8Array {
  const canonical = JSON.stringify({
    accountId: fields.accountId,
    blobVersion: fields.blobVersion,
    payloadSchemaVersion: fields.payloadSchemaVersion,
  });
  return new TextEncoder().encode(canonical);
}
