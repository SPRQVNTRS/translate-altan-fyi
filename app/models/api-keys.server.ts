import { randomBytes, createHash } from 'node:crypto';

import { eq, and, desc, count } from 'drizzle-orm';

import { apiKeys } from '#drizzle/schema';
import type { SelectApiKey } from '#drizzle/schema';
import { tenantDb, getRawDb, type TenantCtx } from '#drizzle/tenant-db';
import type { PaginationParams } from '#app/lib/pagination.server';

/**
 * Public projection of an api-key row — the hash column is the credential
 * verification artifact and must NEVER leave this module. Every callable
 * function that returns an api-key row returns this shape, not the raw
 * `SelectApiKey`.
 */
export type SelectApiKeyPublic = Omit<SelectApiKey, 'hash'>;

const apiKeyPublicColumns = {
  id: apiKeys.id,
  organizationId: apiKeys.organizationId,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  lastUsedAt: apiKeys.lastUsedAt,
  expiresAt: apiKeys.expiresAt,
  revoked: apiKeys.revoked,
  createdAt: apiKeys.createdAt,
  createdBy: apiKeys.createdBy,
} as const;

/**
 * Generate a new API key. Returns the full key string (only time it's
 * visible) and the public DB record (no hash).
 *
 * Key format: "sk_" + 32 random hex chars (40 chars total)
 * Prefix: first 8 chars of the key (e.g., "sk_a1b2c")
 * Hash: SHA-256 of the full key — stored, never returned.
 */
export async function createApiKey(
  ctx: TenantCtx,
  data: { name: string; createdBy: number | null },
): Promise<{ key: string; record: SelectApiKeyPublic }> {
  const raw = randomBytes(32).toString('hex');
  const key = `sk_${raw}`;
  const prefix = key.slice(0, 8);
  const hash = createHash('sha256').update(key).digest('hex');

  const tdb = tenantDb(ctx);
  const [inserted] = await tdb
    .insert(apiKeys, {
      name: data.name,
      prefix,
      hash,
      createdBy: data.createdBy,
    })
    .returning();

  if (!inserted) {
    throw new Error('Failed to create API key');
  }

  // Re-fetch via the public projection so the caller never sees `hash`.
  const [record] = await getRawDb()
    .select(apiKeyPublicColumns)
    .from(apiKeys)
    .where(eq(apiKeys.id, inserted.id))
    .limit(1);

  if (!record) {
    throw new Error('Failed to create API key');
  }

  return { key, record };
}

/** List API keys for the current org, paginated. */
export async function listApiKeys(
  ctx: TenantCtx,
  pagination: PaginationParams = { limit: 20, offset: 0 },
): Promise<{ rows: SelectApiKeyPublic[]; total: number }> {
  const tdb = tenantDb(ctx);
  const [rows, totalRow] = await Promise.all([
    getRawDb()
      .select(apiKeyPublicColumns)
      .from(apiKeys)
      .where(tdb.scope(apiKeys))
      .orderBy(desc(apiKeys.createdAt))
      .limit(pagination.limit)
      .offset(pagination.offset),
    getRawDb()
      .select({ value: count() })
      .from(apiKeys)
      .where(tdb.scope(apiKeys))
      .then((r) => r[0]),
  ]);
  return { rows, total: Number(totalRow?.value ?? 0) };
}

/** Revoke an API key by id, scoped to the org. Returns null if the key isn't in this org. */
export async function revokeApiKey(
  ctx: TenantCtx,
  id: string,
): Promise<SelectApiKeyPublic | null> {
  const tdb = tenantDb(ctx);
  await tdb.update(apiKeys, eq(apiKeys.id, id), { revoked: true });
  const [record] = await getRawDb()
    .select(apiKeyPublicColumns)
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), tdb.scope(apiKeys)))
    .limit(1);
  return record ?? null;
}

/**
 * Lookup an API key by prefix and verify hash — used for webhook/API auth.
 *
 * Cross-tenant: the caller doesn't know the org at auth time. Uses raw DB
 * because this is fundamentally a global lookup followed by an org-aware
 * dispatch by the caller.
 *
 * Returns the public projection (no hash) on match — the hash is only used
 * inside the WHERE clause and never leaves this function.
 */
export async function verifyApiKey(rawKey: string): Promise<SelectApiKeyPublic | null> {
  const prefix = rawKey.slice(0, 8);
  const hash = createHash('sha256').update(rawKey).digest('hex');

  const [record] = await getRawDb()
    .select(apiKeyPublicColumns)
    .from(apiKeys)
    .where(and(eq(apiKeys.prefix, prefix), eq(apiKeys.hash, hash)))
    .limit(1);

  return record ?? null;
}

/**
 * Update lastUsedAt timestamp during the auth path. Cross-tenant by nature
 * since the caller is mid-auth and doesn't have a tenant context yet.
 */
export async function updateLastUsedAt(id: string): Promise<void> {
  await getRawDb()
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, id));
}

/** Admin-only cross-tenant revoke (CLI). */
export async function adminRevokeApiKey(id: string): Promise<SelectApiKeyPublic | null> {
  await getRawDb()
    .update(apiKeys)
    .set({ revoked: true })
    .where(eq(apiKeys.id, id));
  const [record] = await getRawDb()
    .select(apiKeyPublicColumns)
    .from(apiKeys)
    .where(eq(apiKeys.id, id))
    .limit(1);
  return record ?? null;
}
