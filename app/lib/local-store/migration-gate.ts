/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/local-store/migration-gate.ts @ 68e893a.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 *
 * Device-local "this gate has been confirmed clear here" stamp — a single
 * store VALUE (`migrationGateClearedFor`) holding the owner id the gate was
 * last cleared for on this device.
 *
 * CURRENTLY UNREFERENCED BY THE APP. Upstream it was written for a one-time
 * server → device migration gate: a route's `clientLoader` had to call the
 * SERVER-side gate at least once per signed-in session, but not on every purely
 * local navigation, which would have turned each navigation into a server round
 * trip and defeated the whole point of a local-first cutover. Nothing calls
 * these functions today.
 *
 * Kept rather than deleted because the sync client needs exactly this shape of
 * once-per-device stamp: a cheap, durable "this device has already been through
 * the ceremony" marker that survives a reload and costs no round trip to read.
 *
 * ONE DIVERGENCE FROM THE SOURCE: the stamped owner id is a STRING here, not a
 * number. Upstream stamped a numeric `users.id`. This service has no such
 * column — an account is an opaque `handle` the client generates (see
 * AGENTS.md), so a handle is what there is to stamp.
 */
import type { Store } from 'tinybase';
import { z } from 'zod';
import { MIGRATION_GATE_CLEARED_FOR_VALUE } from './store';
import { getPrimaryStore } from './persist';

/** The stamped owner id as it comes back off the store — a TinyBase value, not yet a handle. */
const clearedForOwnerIdSchema = z.string().min(1);

interface StoreOption {
  store?: Store;
}

async function resolveStore(store: Store | undefined): Promise<Store> {
  return store ?? (await getPrimaryStore());
}

/**
 * Pure decision: whether the gate has already been confirmed clear on this
 * device and can be skipped.
 *
 * Deliberately checks only non-null, NOT equality against some independently
 * verified "expected current owner" id: the caller is a `clientLoader`, which
 * has no way to obtain a freshly-verified id without making the very round
 * trip this function exists to conditionally skip.
 *
 * @param clearedForOwnerId - the stamped owner id on this device, or null when
 *   never stamped (or cleared).
 * @returns true when the gate has already been confirmed clear on this device.
 */
export function shouldSkipMigrationGateCheck({ clearedForOwnerId }: { clearedForOwnerId: string | null }): boolean {
  return clearedForOwnerId !== null;
}

/** The owner id the gate was last confirmed clear for on this device, or null. */
export async function getMigrationGateClearedFor({ store }: StoreOption = {}): Promise<string | null> {
  const value = (await resolveStore(store)).getValue(MIGRATION_GATE_CLEARED_FOR_VALUE);
  const parsed = clearedForOwnerIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Stamps the gate as cleared for `ownerId` on this device. */
export async function setMigrationGateClearedFor(ownerId: string, { store }: StoreOption = {}): Promise<void> {
  (await resolveStore(store)).setValue(MIGRATION_GATE_CLEARED_FOR_VALUE, ownerId);
}

/** Removes the stamp, so the gate runs again on this device. */
export async function clearMigrationGateStamp({ store }: StoreOption = {}): Promise<void> {
  (await resolveStore(store)).delValue(MIGRATION_GATE_CLEARED_FOR_VALUE);
}
