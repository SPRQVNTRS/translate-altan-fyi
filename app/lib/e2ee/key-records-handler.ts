/**
 * COPIED, NOT SHARED. Source: openplate-sync/src/server/key-records-handler.ts @ 311a1578af3ca169e8a08c6d50d90889e29d5889.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * Key-record CRUD handler core (design spec D2/D5) — the wrapped-DEK
 * records (`passphrase` and `recovery` kinds). Separated from the Express
 * glue so it's unit-testable against a fake `SyncStorageAdapter`.
 */
import type { SyncKeyRecord, SyncStorageAdapter } from './contract-types';
import type { SyncKeyRecordKind } from './protocol';
import type { JsonObject } from './json';

export async function handleListKeyRecords(accountId: number, storage: SyncStorageAdapter): Promise<SyncKeyRecord[]> {
  return storage.listKeyRecords(accountId);
}

export interface PutKeyRecordInput {
  accountId: number;
  kind: SyncKeyRecordKind;
  /** Argon2id salt + m/t/p params for `passphrase`; must be `null` for `recovery` (D5 — HKDF-only, no KDF params to store). */
  kdfDescriptor: JsonObject | null;
  wrappedDek: Uint8Array;
  /** CAS token (security review finding #2): `null` asserts "no record should exist yet for this (account, kind)"; otherwise the exact `updatedAt` the caller last observed. */
  expectedUpdatedAt: Date | null;
}

export type PutKeyRecordHandlerResult =
  | { status: 'ok'; record: SyncKeyRecord }
  | { status: 'invalid'; reason: string }
  | { status: 'conflict'; currentUpdatedAt: Date | null };

export async function handlePutKeyRecord(
  input: PutKeyRecordInput,
  storage: SyncStorageAdapter,
): Promise<PutKeyRecordHandlerResult> {
  if (input.wrappedDek.byteLength === 0) {
    return { status: 'invalid', reason: 'wrappedDek must not be empty' };
  }
  if (input.kind === 'recovery' && input.kdfDescriptor !== null) {
    return { status: 'invalid', reason: 'recovery key records must not carry a kdfDescriptor (D5 — HKDF-only)' };
  }
  if (input.kind === 'passphrase' && input.kdfDescriptor === null) {
    return { status: 'invalid', reason: 'passphrase key records require a kdfDescriptor' };
  }

  const result = await storage.putKeyRecord({
    accountId: input.accountId,
    kind: input.kind,
    kdfDescriptor: input.kdfDescriptor,
    wrappedDek: input.wrappedDek,
    expectedUpdatedAt: input.expectedUpdatedAt,
  });
  if (!result.ok) {
    return { status: 'conflict', currentUpdatedAt: result.currentUpdatedAt };
  }
  return { status: 'ok', record: result.record };
}

export async function handleDeleteKeyRecord(
  input: { accountId: number; kind: SyncKeyRecordKind },
  storage: SyncStorageAdapter,
): Promise<void> {
  await storage.deleteKeyRecord(input);
}
