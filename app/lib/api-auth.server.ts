/**
 * Shared API authentication helpers for REST API routes.
 *
 * All API routes use Bearer token auth. The token is an API key issued by the
 * system (`pnpm cli api-key create`, or POST /api/v1/api-keys).
 *
 * A KEY BELONGS TO NOBODY. It used to carry an organization and a creating
 * user, and superadmin was a join through that user; the organizations and the
 * users went with the ts-factory-stack scaffolding in M189. What is left is one
 * flat credential and one question about it, `isSuperadmin`, answered by a
 * column on the key itself.
 *
 * verifyApiKey does NOT filter revoked keys — this module checks revocation.
 */

import { z } from 'zod';

import {
  verifyApiKey,
  updateLastUsedAt,
  type SelectApiKeyPublic,
} from '#app/models/api-keys.server';

export interface ApiKeyAuth {
  apiKey: SelectApiKeyPublic;
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

async function authenticate(request: Request): Promise<ApiKeyAuth> {
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

  return { apiKey };
}

/**
 * Verify Bearer token, check revocation, update lastUsedAt.
 * Returns the key record.
 */
export async function requireApiKey(request: Request): Promise<ApiKeyAuth> {
  return authenticate(request);
}

/**
 * The same, plus the key's own `isSuperadmin` flag.
 *
 * NO JOIN. The flag is a column on the key, so this costs the one lookup
 * `requireApiKey` already did. It used to follow `api_keys.created_by` into
 * `users` for a second query, which is one reason that table outlived its
 * purpose. Throws 403 if the key is valid but not a superadmin key.
 */
export async function requireSuperadminApiKey(request: Request): Promise<ApiKeyAuth> {
  const auth = await authenticate(request);

  if (!auth.apiKey.isSuperadmin) {
    throw jsonError(403, 'this endpoint requires a superadmin API key');
  }

  return auth;
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
