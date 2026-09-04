/**
 * `/api/v1/sync/blob`, the user's one synced document.
 *
 *   `GET`  → pull the current document
 *   `POST` → push a new one, compare-and-swap
 *
 * Both verbs require a signed-in session and answer `401` without one. The user
 * id comes from the SESSION and never from the request: a caller does not get to
 * name whose document it is reading or overwriting.
 *
 * WHAT THE SERVER SEES. Plain JSON, since M191. The document used to be opaque
 * ciphertext this route only measured; it is readable now, and the privacy page
 * says so. Nothing here inspects it all the same: it is stored and returned
 * whole, because the device's own store is the only thing that understands it.
 *
 * `baseVersion` IS A COMPARE-AND-SWAP TOKEN. A push is accepted only when it
 * equals the stored version, `0` asserting "this user has no document yet". A
 * mismatch is `409` carrying `currentVersion` AND NOTHING ELSE: the client
 * pulls afterwards, merges and pushes again. Putting the winning document in
 * the conflict body would make every lost race pay for a full download it may
 * not need.
 */
import { z } from 'zod';

import type { Route } from './+types/api.v1.sync.blob';
import { jsonValueSchema, type JsonValue } from '#app/lib/json';
import { MAX_BLOB_BYTES, putBlobIfVersionMatches, readBlob } from '#app/lib/sync/server/blob-store.server';
import { resolveUser } from '#app/middleware/auth';
import { createComponentLogger } from '#app/lib/logger';

/** The one `401` both verbs share. It never says whether the cookie was absent, expired or stale. */
const NOT_SIGNED_IN = { error: 'unauthorized: sign in to use this account' };

const log = createComponentLogger('SyncBlob');

/** The push body. `baseVersion` is the CAS token; `payload` is the document, unread. */
const pushBodySchema = z.object({
  baseVersion: z.number().int().nonnegative(),
  payload: jsonValueSchema,
});

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  const user = await resolveUser(request);
  if (user === null) return Response.json(NOT_SIGNED_IN, { status: 401 });

  const blob = await readBlob(user.id);
  // A `404` here is not an error condition, it is how a fresh account looks. A
  // client that has never pushed gets it on its first pull and starts from
  // local state.
  if (blob === null) return Response.json({ error: 'no blob for this account yet' }, { status: 404 });

  return Response.json({
    blobVersion: blob.blobVersion,
    payload: blob.payload,
    createdAt: blob.createdAt.toISOString(),
  });
}

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  const user = await resolveUser(request);
  if (user === null) return Response.json(NOT_SIGNED_IN, { status: 401 });
  if (request.method !== 'POST') {
    return Response.json({ error: 'method not allowed' }, { status: 405, headers: { Allow: 'GET, POST' } });
  }

  // The raw text is read first because its length IS the size limit. Parsing a
  // multi-megabyte document only to reject it afterwards is work an attacker
  // gets to choose the amount of.
  const raw = await request.text();
  const sizeBytes = Buffer.byteLength(raw, 'utf8');
  if (sizeBytes > MAX_BLOB_BYTES) {
    return Response.json({ error: `blob exceeds the maximum of ${MAX_BLOB_BYTES} bytes` }, { status: 413 });
  }

  const parsed = pushBodySchema.safeParse(parseJson(raw));
  if (!parsed.success) return Response.json({ error: 'invalid request body' }, { status: 400 });

  const result = await putBlobIfVersionMatches({
    userId: user.id,
    baseVersion: parsed.data.baseVersion,
    payload: parsed.data.payload,
    sizeBytes,
  });

  if (result.status === 'accepted') return Response.json({ newVersion: result.newVersion });
  // The conflict body is `currentVersion` and nothing else.
  if (result.status === 'conflict') return Response.json({ currentVersion: result.currentVersion }, { status: 409 });

  log.warn('Refused a push', { userId: user.id, reason: result.reason });
  return Response.json({ error: result.reason }, { status: 400 });
}

/** The body as JSON, or `null` for anything unparseable. The schema above decides what a valid shape is. */
function parseJson(raw: string): JsonValue | null {
  try {
    const decoded = jsonValueSchema.safeParse(JSON.parse(raw));
    return decoded.success ? decoded.data : null;
  } catch {
    return null;
  }
}
