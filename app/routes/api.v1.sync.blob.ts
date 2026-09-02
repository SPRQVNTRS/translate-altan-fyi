/**
 * `/api/v1/sync/blob` — the account's one encrypted blob (PROTOCOL.md §5.1
 * and §5.2).
 *
 *   `GET`  → pull the current blob
 *   `POST` → push a new one, compare-and-swap
 *
 * Both verbs require a signed-in session and answer `401` without one. The
 * account id comes from the SESSION and never from the request: a caller does
 * not get to name whose blob it is reading or overwriting.
 *
 * WHAT THE SERVER SEES. `ciphertext` is a base64 blob it stores and returns
 * verbatim and never parses (PROTOCOL.md §10.5). This route decodes it to
 * bytes, measures its length, and does nothing else with it. There is no path
 * from here to a plaintext, and nothing on this path decompresses or
 * JSON-parses the payload.
 *
 * `baseVersion` IS A COMPARE-AND-SWAP TOKEN. A push is accepted only when
 * `baseVersion` equals the account's current stored version, `0` asserting
 * "this account has no blob yet". A mismatch is `409` carrying
 * `currentVersion` AND NOTHING ELSE: the client pulls the blob afterwards,
 * merges, re-encrypts against the new version and pushes again. Putting the
 * winning ciphertext in the conflict body would make every lost race pay for
 * a full blob download it may not need.
 *
 * THE SIZE CHECK HAPPENS TWICE, AND THE DECODED LENGTH IS THE ONE THAT
 * COUNTS. Base64 inflates by 4/3, so the encoded string is always larger than
 * the bytes it carries and a limit applied to the raw body would reject a
 * legitimate maximum-size blob. `MAX_BLOB_BYTES` is therefore checked on the
 * DECODED bytes here, which is the protocol's actual cap. The first stage is
 * the warning band below it (`blob-size-telemetry.ts`): a capacity cliff that
 * only announces itself as a hard `413` is a cliff discovered by a user.
 */
import type { Route } from './+types/api.v1.sync.blob';

import { asNumber, asObject, asString, type JsonValue } from '#app/lib/e2ee/json';
import { blobCapacityPercent, shouldWarnBlobSize } from '#app/lib/e2ee/blob-size-telemetry';
import { handlePullBlob } from '#app/lib/e2ee/pull-handler';
import { handlePushBlob } from '#app/lib/e2ee/push-handler';
import { MAX_BLOB_BYTES } from '#app/lib/e2ee/protocol';
import { createDrizzleStorageAdapter } from '#app/services/e2ee-storage-adapter.server';
import { getAccountSession } from '#app/services/account-session.server';
import { errorResponse, jsonResponse, methodNotAllowed, readJsonBody } from '#app/lib/e2ee-http.server';
import { createComponentLogger } from '#app/lib/logger';

const ALLOWED_METHODS = ['GET', 'POST'] as const;

/** The one `401` both verbs share. Never says whether the cookie was absent, expired or revoked. */
const NOT_SIGNED_IN = 'unauthorized: sign in to use this account';

const log = createComponentLogger('SyncBlob');

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  const session = await getAccountSession(request);
  if (session === null) return errorResponse(401, NOT_SIGNED_IN);

  const result = await handlePullBlob(session.accountId, createDrizzleStorageAdapter());
  // PROTOCOL.md §5.2: a `404` here is not an error condition, it is how a
  // fresh account looks. A client that has never pushed gets it on its first
  // pull and starts from local state.
  if (result.status === 'not-found') return errorResponse(404, 'no blob for this account yet');

  return jsonResponse(
    {
      blobVersion: result.blob.blobVersion,
      envelopeVersion: result.blob.envelopeVersion,
      ciphertext: Buffer.from(result.blob.ciphertext).toString('base64'),
      createdAt: result.blob.createdAt.toISOString(),
    },
    200,
  );
}

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  const session = await getAccountSession(request);
  if (session === null) return errorResponse(401, NOT_SIGNED_IN);
  if (request.method !== 'POST') return methodNotAllowed(ALLOWED_METHODS);

  const body = asObject(await readJsonBody(request)) ?? {};
  const baseVersion = asNumber(body.baseVersion);
  const envelopeVersion = asNumber(body.envelopeVersion);
  const ciphertext = decodeCiphertext(body.ciphertext);
  if (baseVersion === null || envelopeVersion === null || ciphertext === null) {
    return errorResponse(400, 'invalid request body');
  }

  // The protocol's actual cap, checked on the DECODED bytes — see the module
  // docblock on why an encoded-length limit cannot stand in for this.
  if (ciphertext.byteLength > MAX_BLOB_BYTES) {
    return errorResponse(413, `blob exceeds the maximum of ${MAX_BLOB_BYTES} bytes`);
  }

  // Capacity-cliff telemetry (PROTOCOL.md §8): the months between the first
  // warning and the first hard rejection are the whole window in which the
  // chunked-blob work can be planned rather than scrambled.
  if (shouldWarnBlobSize(ciphertext.byteLength)) {
    log.warn('Blob approaching the size cap', {
      accountId: session.accountId,
      sizeBytes: ciphertext.byteLength,
      maxBytes: MAX_BLOB_BYTES,
      percentOfCap: blobCapacityPercent(ciphertext.byteLength),
    });
  }

  // The `baseVersion` and `envelopeVersion` rules live in `handlePushBlob`,
  // not here. One place, so the route cannot drift from the handler's unit
  // tests.
  const result = await handlePushBlob(
    { accountId: session.accountId, baseVersion, envelopeVersion, ciphertext },
    createDrizzleStorageAdapter(),
  );

  if (result.status === 'accepted') return jsonResponse({ newVersion: result.newVersion }, 200);
  // PROTOCOL.md §5.1: the conflict body is `currentVersion` and nothing else.
  if (result.status === 'conflict') return jsonResponse({ currentVersion: result.currentVersion }, 409);
  return errorResponse(400, result.reason);
}

/** The blob as bytes. `null` for anything absent or non-string; an empty blob is refused by `handlePushBlob`. */
function decodeCiphertext(value: JsonValue | undefined): Uint8Array | null {
  const encoded = asString(value);
  if (encoded === null) return null;
  return new Uint8Array(Buffer.from(encoded, 'base64'));
}
