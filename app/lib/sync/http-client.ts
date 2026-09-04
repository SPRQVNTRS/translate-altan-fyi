/**
 * The transport for the blob endpoints: `GET`/`POST /api/v1/sync/blob`,
 * transcribed from `PROTOCOL.md` sections 5.1 and 5.2.
 *
 * ── The auth departure, stated once and not re-argued ─────────────────────
 *
 * `PROTOCOL.md` section 4.1 specifies a bearer token and "no cookies, in
 * either direction". THIS DEPLOYMENT USES A SAME-ORIGIN SESSION COOKIE
 * INSTEAD, and the reasoning is written down in
 * `app/services/account-session.server.ts`'s header: the client here is a
 * browser on the same origin as the server, so the wide-open CORS policy that
 * section 4.1 pairs with "no ambient credential" buys nothing, while an
 * httpOnly cookie keeps the token out of reach of injected script. Every
 * request below therefore carries `credentials: 'same-origin'` and NO
 * `Authorization` header, exactly as `app/components/account/sync-client.ts`
 * already does.
 *
 * ── Every response is parsed ──────────────────────────────────────────────
 *
 * A body this build cannot read is a `SyncRequestError` of kind `transport`,
 * never a silent `undefined`. The failure mode this closes is specific: an
 * unparsed `newVersion` reads as `undefined`, the next push sends
 * `baseVersion: NaN`, and the device argues with the server forever about a
 * version that does not exist.
 *
 * Ciphertext crosses the wire as base64 (`PROTOCOL.md` section 4) and is
 * decoded here, so nothing above this module handles an encoded blob.
 */
import { z } from 'zod';

import { base64ToBytes, bytesToBase64 } from '#app/lib/e2ee/crypto/base64';
import { errorKindForStatus, SyncRequestError } from '#app/lib/e2ee/client/sync-error';

/** The one path both verbs use. `PROTOCOL.md` writes it `/blob` under `SYNC_API_PREFIX`; this app mounts it under `/api`. */
const BLOB_PATH = '/api/v1/sync/blob';

/** A pulled blob, with `ciphertext` already decoded from its base64 wire form. */
export interface PulledBlob {
  blobVersion: number;
  envelopeVersion: number;
  ciphertext: Uint8Array;
  createdAt: string;
}

/** The two protocol-meaningful outcomes of a push; anything else throws. */
export type PushResult = { status: 'accepted'; newVersion: number } | { status: 'conflict'; currentVersion: number };

export interface SyncHttpClient {
  /** `GET /api/v1/sync/blob`. `null` on 404, which PROTOCOL.md section 5.2 says is how a fresh account looks, not an error. */
  pullBlob(): Promise<PulledBlob | null>;
  /** `POST /api/v1/sync/blob`. A 409 is a NORMAL outcome and is returned, never thrown. */
  pushBlob(input: { baseVersion: number; envelopeVersion: number; ciphertext: Uint8Array }): Promise<PushResult>;
}

/** `GET /blob` → 200 (`PROTOCOL.md` section 5.2). */
const pullBlobResponseSchema = z.object({
  blobVersion: z.number().int().nonnegative(),
  envelopeVersion: z.number().int().positive(),
  /** Base64 of the packed IV, ciphertext and tag. */
  ciphertext: z.string().min(1),
  createdAt: z.string(),
});

/** `POST /blob` → 200 (`PROTOCOL.md` section 5.1). */
const pushAcceptedResponseSchema = z.object({ newVersion: z.number().int().positive() });

/** `POST /blob` → 409. The body is `currentVersion` and nothing else, deliberately: a lost race must not pay for a blob download. */
const pushConflictResponseSchema = z.object({ currentVersion: z.number().int().nonnegative() });

/** The prose from an error body. Diagnostic only — `PROTOCOL.md` section 4 says clients branch on the status, never on the text. */
const errorBodySchema = z.object({ error: z.string() });

export function createBrowserSyncHttpClient(options: { fetchImpl?: typeof fetch } = {}): SyncHttpClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    async pullBlob(): Promise<PulledBlob | null> {
      const response = await send({ fetchImpl, method: 'GET' });
      // `PROTOCOL.md` section 5.2: a 404 is how an account that has never
      // pushed looks. Answering `null` rather than throwing is what lets the
      // orchestrator start a first cycle from local state alone.
      if (response.status === 404) return null;
      if (!response.ok) throw await toRequestError(response);

      const body = await parseBody({ response, schema: pullBlobResponseSchema });
      return {
        blobVersion: body.blobVersion,
        envelopeVersion: body.envelopeVersion,
        ciphertext: base64ToBytes(body.ciphertext),
        createdAt: body.createdAt,
      };
    },

    async pushBlob(input): Promise<PushResult> {
      const response = await send({
        fetchImpl,
        method: 'POST',
        body: {
          baseVersion: input.baseVersion,
          envelopeVersion: input.envelopeVersion,
          ciphertext: bytesToBase64(input.ciphertext),
        },
      });

      // A 409 is the compare-and-swap saying another device wrote first, which
      // section 5.1 calls a normal outcome with a mandatory recovery loop. It
      // is returned, never thrown: a caller that had to catch it would be a
      // caller that could forget to.
      if (response.status === 409) {
        const conflict = await parseBody({ response, schema: pushConflictResponseSchema });
        return { status: 'conflict', currentVersion: conflict.currentVersion };
      }
      if (!response.ok) throw await toRequestError(response);

      const accepted = await parseBody({ response, schema: pushAcceptedResponseSchema });
      return { status: 'accepted', newVersion: accepted.newVersion };
    },
  };
}

/** One request. A thrown `fetch` (DNS, offline, CORS) becomes a `transport` error rather than escaping as a raw `TypeError`. */
async function send({
  fetchImpl,
  method,
  body,
}: {
  fetchImpl: typeof fetch;
  method: 'GET' | 'POST';
  body?: { baseVersion: number; envelopeVersion: number; ciphertext: string };
}): Promise<Response> {
  try {
    return await fetchImpl(BLOB_PATH, {
      method,
      credentials: 'same-origin',
      headers:
        body === undefined ?
          { accept: 'application/json' }
        : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw new SyncRequestError({
      kind: 'transport',
      message: cause instanceof Error ? cause.message : 'The sync service could not be reached.',
    });
  }
}

/** Decodes a 2xx body, or refuses. A shape this build cannot read is `transport`: the call happened, the answer was unusable. */
async function parseBody<T>({ response, schema }: { response: Response; schema: z.ZodType<T> }): Promise<T> {
  const payload: unknown = await response.json().catch(() => null);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new SyncRequestError({
      kind: 'transport',
      message: 'The sync service answered in a shape this build could not read.',
      status: response.status,
    });
  }
  return parsed.data;
}

/**
 * Maps a non-2xx onto its {@link SyncRequestError}.
 *
 * `errorKindForStatus` owns the mapping, so a `413` arrives as `too-large` and
 * the caller can say what actually happened — the capacity cliff, reached —
 * rather than reporting an opaque server error.
 */
async function toRequestError(response: Response): Promise<SyncRequestError> {
  const payload: unknown = await response.json().catch(() => null);
  const parsed = errorBodySchema.safeParse(payload);
  return new SyncRequestError({
    kind: errorKindForStatus(response.status),
    message: parsed.success ? parsed.data.error : `Request failed with status ${response.status}.`,
    status: response.status,
    retryAfterSeconds: readRetryAfterSeconds(response),
  });
}

/** The server's own advice on a `429`, in seconds. `null` when absent or not a plain number of seconds. */
function readRetryAfterSeconds(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (header === null) return null;
  const seconds = z.coerce.number().int().nonnegative().safeParse(header);
  return seconds.success ? seconds.data : null;
}
