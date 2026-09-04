/**
 * The transport for the blob endpoints: `GET`/`POST /api/v1/sync/blob`.
 *
 * ── The credential is the session cookie ──────────────────────────────────
 *
 * Every request carries `credentials: 'same-origin'` and NO `Authorization`
 * header. The client here is a browser on the same origin as the server, so
 * there is no cross-origin request to make and nothing to gain from a token
 * JavaScript can read; an httpOnly cookie cannot be exfiltrated by injected
 * script. A `401` therefore means the session is over, and the caller's job is
 * to say so rather than to retry.
 *
 * ── Every response is parsed ──────────────────────────────────────────────
 *
 * A body this build cannot read is a `SyncRequestError` of kind `transport`,
 * never a silent `undefined`. The failure mode this closes is specific: an
 * unparsed `newVersion` reads as `undefined`, the next push sends
 * `baseVersion: NaN`, and the device argues with the server forever about a
 * version that does not exist.
 *
 * ── The document crosses the wire as JSON ─────────────────────────────────
 *
 * It was base64 ciphertext until M191. There is nothing to decode now: the
 * envelope goes up and comes back as an ordinary JSON value.
 */
import { z } from 'zod';

import { jsonValueSchema, type JsonValue } from '#app/lib/json';
import { errorKindForStatus, SyncRequestError } from '#app/lib/sync/sync-error';

/** The one path both verbs use. */
const BLOB_PATH = '/api/v1/sync/blob';

/** A pulled document, still framed as its envelope. */
export interface PulledBlob {
  blobVersion: number;
  payload: JsonValue;
  createdAt: string;
}

/** The two protocol-meaningful outcomes of a push; anything else throws. */
export type PushResult = { status: 'accepted'; newVersion: number } | { status: 'conflict'; currentVersion: number };

export interface SyncHttpClient {
  /** `GET /api/v1/sync/blob`. `null` on 404, which is how a fresh account looks, not an error. */
  pullBlob(): Promise<PulledBlob | null>;
  /** `POST /api/v1/sync/blob`. A 409 is a NORMAL outcome and is returned, never thrown. */
  pushBlob(input: { baseVersion: number; payload: JsonValue }): Promise<PushResult>;
}

/** `GET /blob` → 200. */
const pullBlobResponseSchema = z.object({
  blobVersion: z.number().int().nonnegative(),
  payload: jsonValueSchema,
  createdAt: z.string(),
});

/** `POST /blob` → 200. */
const pushAcceptedResponseSchema = z.object({ newVersion: z.number().int().positive() });

/** `POST /blob` → 409. The body is `currentVersion` and nothing else, deliberately: a lost race must not pay for a download. */
const pushConflictResponseSchema = z.object({ currentVersion: z.number().int().nonnegative() });

/** The prose from an error body. Diagnostic only: clients branch on the status, never on the text. */
const errorBodySchema = z.object({ error: z.string() });

export function createBrowserSyncHttpClient(options: { fetchImpl?: typeof fetch } = {}): SyncHttpClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    async pullBlob(): Promise<PulledBlob | null> {
      const response = await send({ fetchImpl, method: 'GET' });
      // A 404 is how an account that has never pushed looks. Answering `null`
      // rather than throwing is what lets the orchestrator start a first cycle
      // from local state alone.
      if (response.status === 404) return null;
      if (!response.ok) throw await toRequestError(response);

      const body = await parseBody({ response, schema: pullBlobResponseSchema });
      return { blobVersion: body.blobVersion, payload: body.payload, createdAt: body.createdAt };
    },

    async pushBlob(input): Promise<PushResult> {
      const response = await send({
        fetchImpl,
        method: 'POST',
        body: { baseVersion: input.baseVersion, payload: input.payload },
      });

      // A 409 is the compare-and-swap saying another device wrote first, which
      // is a normal outcome with a mandatory recovery loop. It is returned,
      // never thrown: a caller that had to catch it could forget to.
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

/** One request. A thrown `fetch` (DNS, offline) becomes a `transport` error rather than escaping as a raw `TypeError`. */
async function send({
  fetchImpl,
  method,
  body,
}: {
  fetchImpl: typeof fetch;
  method: 'GET' | 'POST';
  body?: { baseVersion: number; payload: JsonValue };
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
 * the caller can say what actually happened, the capacity cliff reached,
 * rather than reporting an opaque server error. A `401` arrives as
 * `unauthorized`, which the scheduler reads as "signed out".
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
