/**
 * COPIED, NOT SHARED. Source: openplate-sync/src/server/pull-handler.ts @ 311a1578af3ca169e8a08c6d50d90889e29d5889.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * Pull-blob handler core (design spec D4) — read-only. Separated from the
 * Express glue so it's unit-testable against a fake `SyncStorageAdapter`.
 */
import type { SyncBlobRecord, SyncStorageAdapter } from './contract-types';

export type PullBlobResult = { status: 'found'; blob: SyncBlobRecord } | { status: 'not-found' };

export async function handlePullBlob(accountId: number, storage: SyncStorageAdapter): Promise<PullBlobResult> {
  const blob = await storage.getBlob(accountId);
  return blob ? { status: 'found', blob } : { status: 'not-found' };
}
