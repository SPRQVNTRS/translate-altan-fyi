/**
 * `/api/v1/sync/key-records` — the wrapped-DEK records (PROTOCOL.md §5.3–§5.5).
 *
 *   `GET`    → list this account's records
 *   `PUT`    → create or rotate one, compare-and-swap
 *   `DELETE` → remove one
 *
 * Every verb requires a signed-in session and answers `401` without one. The
 * account id comes from the SESSION and never from the request: a caller does
 * not get to name whose key records it is reading.
 *
 * WHAT THE SERVER SEES. `wrappedDek` is a base64 blob it stores and returns
 * verbatim and never parses (PROTOCOL.md §10.5). This route decodes it to
 * bytes and nothing else; there is no path from here to a plaintext.
 *
 * `updatedAt` IS A COMPARE-AND-SWAP TOKEN, NOT A TIMESTAMP FOR DISPLAY. `PUT`
 * requires `expectedUpdatedAt` to be present: `null` asserts "no record exists
 * yet", any ISO-8601 string asserts "the record I last read had exactly this
 * `updatedAt`". An ABSENT key is a `400`, never a blind upsert — silence must
 * not be read as consent on a path that can strand an account's data
 * permanently. A mismatch is `409` carrying `currentUpdatedAt`, so the client
 * can re-read and re-wrap rather than guess.
 *
 * The token round-trips through an ISO-8601 string, which carries
 * MILLISECONDS. The column is `timestamp(3)` for exactly that reason
 * (`drizzle/schema/accounts.ts`); a microsecond tail the wire cannot express
 * would make exact equality match zero rows and 409 forever.
 *
 * ONE ROUTE, `?kind=` RATHER THAN `/:kind`. PROTOCOL.md spells these
 * `PUT /key-records/:kind` and `DELETE /key-records/:kind`. The kind is a
 * closed two-value set validated identically either way, so this is a URL
 * shape difference and not a protocol one — recorded here rather than left for
 * a reader to notice.
 *
 * THE RESPONSE ENVELOPES ARE TRANSCRIBED FROM SECTIONS 5.3 AND 5.4. `GET`
 * answers `{ records: [...] }`; `PUT` answers the stored record BARE, with no
 * wrapper key, because 5.4 says the `200` body is "the stored record, same
 * shape as a `GET /key-records` entry". The port originally wrapped them as
 * `{ keyRecords }` and `{ keyRecord }`, which is exactly the drift ADR-0008
 * says a copy risks; the document and `openplate-sync`'s
 * `src/server/register-routes.ts` agree with each other, so the fix is to
 * follow them rather than to keep the local naming.
 */
import type { Route } from './+types/api.v1.sync.key-records';

import {
  handleDeleteKeyRecord,
  handleListKeyRecords,
  handlePutKeyRecord,
} from '#app/lib/e2ee/key-records-handler';
import { asObject, asString, type JsonObject, type JsonValue } from '#app/lib/e2ee/json';
import { isSyncKeyRecordKind, type SyncKeyRecordKind } from '#app/lib/e2ee/protocol';
import type { SyncKeyRecord } from '#app/lib/e2ee/contract-types';
import { createDrizzleStorageAdapter } from '#app/services/e2ee-storage-adapter.server';
import { getAccountSession } from '#app/services/account-session.server';
import { errorResponse, jsonResponse, methodNotAllowed, readJsonBody } from '#app/lib/e2ee-http.server';

const ALLOWED_METHODS = ['GET', 'PUT', 'DELETE'] as const;

/** The one `401` every verb shares. Never says whether the cookie was absent, expired or revoked. */
const NOT_SIGNED_IN = 'unauthorized: sign in to use this account';

/** The wire shape of a key record. `wrappedDek` is base64 (PROTOCOL.md §4). */
interface KeyRecordPayload {
  kind: SyncKeyRecordKind;
  kdfDescriptor: JsonObject | null;
  wrappedDek: string;
  updatedAt: string;
}

function toPayload(record: SyncKeyRecord): KeyRecordPayload {
  return {
    kind: record.kind,
    kdfDescriptor: record.kdfDescriptor,
    wrappedDek: Buffer.from(record.wrappedDek).toString('base64'),
    // The CAS token, and the reason this column is `timestamp(3)`.
    updatedAt: record.updatedAt.toISOString(),
  };
}

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  const session = await getAccountSession(request);
  if (session === null) return errorResponse(401, NOT_SIGNED_IN);

  const records = await handleListKeyRecords(session.accountId, createDrizzleStorageAdapter());
  return jsonResponse({ records: records.map(toPayload) }, 200);
}

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  const session = await getAccountSession(request);
  if (session === null) return errorResponse(401, NOT_SIGNED_IN);

  if (request.method === 'PUT') return putKeyRecord(request, session.accountId);
  if (request.method === 'DELETE') return deleteKeyRecord(request, session.accountId);
  return methodNotAllowed(ALLOWED_METHODS);
}

async function putKeyRecord(request: Request, accountId: number): Promise<Response> {
  const body = asObject(await readJsonBody(request));
  if (body === null) return errorResponse(400, 'body must be a JSON object');

  const kind = kindFrom(request, body.kind);
  if (kind === null) return errorResponse(400, 'kind must be "passphrase" or "recovery"');

  const wrappedDek = decodeWrappedDek(body.wrappedDek);
  if (wrappedDek === null) return errorResponse(400, 'wrappedDek must be a non-empty base64 string');

  // REQUIRED, and `undefined` is not `null`. `null` is a caller asserting "no
  // record exists yet"; a missing key is a caller who has not thought about it,
  // and accepting that is how a rotation silently overwrites another device.
  if (!('expectedUpdatedAt' in body)) {
    return errorResponse(400, 'expectedUpdatedAt is required: send null to assert no record exists yet');
  }
  const expectedUpdatedAt = decodeExpectedUpdatedAt(body.expectedUpdatedAt);
  if (expectedUpdatedAt === 'invalid') {
    return errorResponse(400, 'expectedUpdatedAt must be an ISO-8601 timestamp or null');
  }

  // The `kdfDescriptor` rules (required for `passphrase`, forbidden for
  // `recovery`) live in `handlePutKeyRecord`, not here. One place, so the
  // route cannot drift from the handler's unit tests.
  const result = await handlePutKeyRecord(
    { accountId, kind, kdfDescriptor: asObject(body.kdfDescriptor), wrappedDek, expectedUpdatedAt },
    createDrizzleStorageAdapter(),
  );

  if (result.status === 'invalid') return errorResponse(400, result.reason);
  if (result.status === 'conflict') {
    // THIS BODY CARRIES BOTH `error` AND `currentUpdatedAt`, AND THAT IS
    // DELIBERATE. Section 5.4's table shows only `currentUpdatedAt`, and
    // upstream sends only that; section 4 states that EVERY non-2xx body is
    // `{"error": "..."}`. Carrying both satisfies the general rule and the
    // specific one at once, where upstream satisfies only the specific one, so
    // this is a superset rather than a drift. Do not "fix" it back.
    return jsonResponse(
      {
        error: 'the key record changed since you last read it; re-read and re-wrap',
        currentUpdatedAt: result.currentUpdatedAt?.toISOString() ?? null,
      },
      409,
    );
  }
  // Bare, per section 5.4: "the stored record, same shape as a `GET` entry".
  return jsonResponse(toPayload(result.record), 200);
}

async function deleteKeyRecord(request: Request, accountId: number): Promise<Response> {
  const body = asObject(await readJsonBody(request)) ?? {};
  const kind = kindFrom(request, body.kind);
  if (kind === null) return errorResponse(400, 'kind must be "passphrase" or "recovery"');

  await handleDeleteKeyRecord({ accountId, kind }, createDrizzleStorageAdapter());
  return new Response(null, { status: 204 });
}

/** The record kind, from `?kind=` or the body. `null` for anything that is not one of the two. */
function kindFrom(request: Request, fromBody: JsonValue | undefined): SyncKeyRecordKind | null {
  const fromQuery = new URL(request.url).searchParams.get('kind');
  const candidate = fromQuery ?? fromBody;
  return isSyncKeyRecordKind(candidate) ? candidate : null;
}

/** The wrapped DEK as bytes. `null` for anything absent, non-string or empty. */
function decodeWrappedDek(value: JsonValue | undefined): Uint8Array | null {
  const encoded = asString(value);
  if (encoded === null) return null;
  const bytes = new Uint8Array(Buffer.from(encoded, 'base64'));
  return bytes.byteLength === 0 ? null : bytes;
}

/**
 * The CAS token. `null` is the caller's "no record exists yet" assertion and
 * is passed straight through; `'invalid'` is a `400`. An unparseable date is
 * never coerced to `null`, because that would silently turn a botched rotation
 * into a first-time create.
 */
function decodeExpectedUpdatedAt(value: JsonValue | undefined): Date | null | 'invalid' {
  if (value === null) return null;
  const encoded = asString(value);
  if (encoded === null) return 'invalid';
  const parsed = new Date(encoded);
  return Number.isNaN(parsed.getTime()) ? 'invalid' : parsed;
}
