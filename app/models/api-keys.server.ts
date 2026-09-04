/**
 * API keys: the bearer credential in front of `/api/v1/*`.
 *
 * A KEY BELONGS TO NOBODY, and every function here is therefore flat. The org
 * scoping and the `created_by` join went with the ts-factory-stack
 * scaffolding in M189; what a key carries now is a name, a prefix, a hash and
 * one authority bit.
 */
import { randomBytes, createHash } from 'node:crypto';

import { eq, and, desc, count } from 'drizzle-orm';

import { apiKeys } from '#drizzle/schema';
import type { SelectApiKey } from '#drizzle/schema';
import { getRawDb } from '#drizzle/db';
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
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  isSuperadmin: apiKeys.isSuperadmin,
  lastUsedAt: apiKeys.lastUsedAt,
  expiresAt: apiKeys.expiresAt,
  revoked: apiKeys.revoked,
  createdAt: apiKeys.createdAt,
} as const;

/**
 * Generate a new API key. Returns the full key string (only time it's
 * visible) and the public DB record (no hash).
 *
 * Key format: "sk_" + 64 random hex chars
 * Prefix: first 8 chars of the key (e.g., "sk_a1b2c")
 * Hash: SHA-256 of the full key — stored, never returned.
 *
 * `isSuperadmin` is a deliberate argument rather than a default, because it is
 * the whole authority of the key: a caller that does not say has to decide.
 */
export async function createApiKey(
  data: { name: string; isSuperadmin: boolean },
): Promise<{ key: string; record: SelectApiKeyPublic }> {
  const raw = randomBytes(32).toString('hex');
  const key = `sk_${raw}`;
  const prefix = key.slice(0, 8);
  const hash = createHash('sha256').update(key).digest('hex');

  const [inserted] = await getRawDb()
    .insert(apiKeys)
    .values({ name: data.name, prefix, hash, isSuperadmin: data.isSuperadmin })
    .returning(apiKeyPublicColumns);

  if (!inserted) {
    throw new Error('Failed to create API key');
  }

  return { key, record: inserted };
}

/** List API keys, newest first, paginated. */
export async function listApiKeys(
  pagination: PaginationParams = { limit: 20, offset: 0 },
): Promise<{ rows: SelectApiKeyPublic[]; total: number }> {
  const [rows, totalRow] = await Promise.all([
    getRawDb()
      .select(apiKeyPublicColumns)
      .from(apiKeys)
      .orderBy(desc(apiKeys.createdAt))
      .limit(pagination.limit)
      .offset(pagination.offset),
    getRawDb()
      .select({ value: count() })
      .from(apiKeys)
      .then((r) => r[0]),
  ]);
  return { rows, total: Number(totalRow?.value ?? 0) };
}

/** Revoke an API key by id. Returns null when no such key exists. */
export async function revokeApiKey(id: string): Promise<SelectApiKeyPublic | null> {
  const [record] = await getRawDb()
    .update(apiKeys)
    .set({ revoked: true })
    .where(eq(apiKeys.id, id))
    .returning(apiKeyPublicColumns);
  return record ?? null;
}

/**
 * Lookup an API key by prefix and verify hash — the auth path.
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

/** Update lastUsedAt during the auth path. */
export async function updateLastUsedAt(id: string): Promise<void> {
  await getRawDb()
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, id));
}
