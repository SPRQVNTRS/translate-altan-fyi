/**
 * Shared API authentication helpers for REST API routes.
 *
 * All API routes use Bearer token auth. The token is an API key issued
 * by the system (created via `api-key create` CLI or POST /api/v1/api-keys).
 *
 * verifyApiKey does NOT filter revoked keys — this module checks revocation.
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { users } from '#drizzle/schema';
import { getRawDb } from '#drizzle/tenant-db';
import type { TenantCtx } from '#drizzle/tenant-db';
import {
  verifyApiKey,
  updateLastUsedAt,
  type SelectApiKeyPublic,
} from '#app/models/api-keys.server';
import { getOrganizationBySlug } from '#app/models/organizations.server';

export interface ApiKeyAuth {
  apiKey: SelectApiKeyPublic;
  ctx: TenantCtx;
  /**
   * True when the key was verified via requireSuperadminApiKey — the
   * creating user has isSuperadmin=true. Used by assertOrgAccess to
   * bypass the org-membership check for cross-org operations.
   */
  isSuperadmin: boolean;
}

/**
 * Throw a JSON error Response — use instead of `throw new Error` from loaders.
 */
export function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message, code: String(status) }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

async function authenticate(request: Request): Promise<Omit<ApiKeyAuth, 'isSuperadmin'>> {
  const token = extractBearerToken(request);
  if (!token) {
    throw jsonError(401, 'unauthorized');
  }

  const apiKey = await verifyApiKey(token);
  if (!apiKey) {
    throw jsonError(401, 'unauthorized');
  }

  if (apiKey.revoked === true) {
    throw jsonError(403, 'api key has been revoked');
  }

  await updateLastUsedAt(apiKey.id);

  return { apiKey, ctx: { orgId: apiKey.organizationId } };
}

/**
 * Verify Bearer token, check revocation, update lastUsedAt.
 * Returns the full key record, a TenantCtx derived from it, and isSuperadmin=false.
 */
export async function requireApiKey(request: Request): Promise<ApiKeyAuth> {
  const base = await authenticate(request);
  return { ...base, isSuperadmin: false };
}

/**
 * Verifies the Bearer token and additionally checks the key's creator has
 * isSuperadmin=true. Requires a join from api_keys → users.
 * Throws 403 if the key is valid but not superadmin.
 * Returns isSuperadmin=true on success.
 */
export async function requireSuperadminApiKey(request: Request): Promise<ApiKeyAuth> {
  const base = await authenticate(request);

  if (base.apiKey.createdBy === null) {
    throw jsonError(403, 'this endpoint requires a superadmin API key');
  }

  const [user] = await getRawDb()
    .select({ isSuperadmin: users.isSuperadmin })
    .from(users)
    .where(eq(users.id, base.apiKey.createdBy))
    .limit(1);

  if (!user?.isSuperadmin) {
    throw jsonError(403, 'this endpoint requires a superadmin API key');
  }

  return { ...base, isSuperadmin: true };
}

/**
 * Verify the authenticated key may access the given org.
 * Superadmin keys bypass the org-membership check.
 * Throws 403 if the key's organizationId does not match and key is not superadmin.
 */
export function assertOrgAccess(auth: ApiKeyAuth, orgId: string): void {
  if (auth.isSuperadmin || auth.apiKey.organizationId === orgId) return;
  throw jsonError(403, 'forbidden: key does not belong to this organization');
}

/**
 * Resolve an org slug from a query param to an org id.
 * Throws 400 if the param is missing, 404 if the org is not found.
 */
export async function resolveOrgSlug(slug: string | undefined): Promise<string> {
  if (!slug) {
    throw jsonError(400, 'missing required query param: org');
  }

  const org = await getOrganizationBySlug(slug);
  if (!org) {
    throw jsonError(404, `organization not found: ${slug}`);
  }

  return org.id;
}

/**
 * Parse a JSON request body against the schema that describes the endpoint's
 * contract. This is the only place a route should decode a request body —
 * a malformed or non-conforming payload becomes the standard 400 envelope.
 */
export async function parseJsonBody<TValue>(
  request: Request,
  schema: z.ZodType<TValue>,
): Promise<TValue> {
  let raw;
  try {
    raw = await request.json();
  } catch {
    throw jsonError(400, 'invalid JSON body');
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    throw jsonError(400, z.prettifyError(result.error));
  }
  return result.data;
}
