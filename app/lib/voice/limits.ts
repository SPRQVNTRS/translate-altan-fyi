/**
 * The caps on a recorded upload, shared by the browser and the server.
 *
 * ONE FILE, BECAUSE TWO COPIES OF A CAP DRIFT.
 *   The browser stops the recorder at `MAX_AUDIO_SECONDS` and the server
 *   refuses a body over `MAX_AUDIO_BYTES`. A browser that believed a longer
 *   limit than the server enforces would record for seconds, upload, and be
 *   refused, which reads as a broken feature rather than as a limit. So both
 *   numbers live here and both sides import them.
 *
 * THIS MODULE IS CLIENT SAFE, AND IT HAS TO STAY THAT WAY.
 *   It is imported by a component that reaches the browser bundle, so nothing
 *   here may touch `process.env`, a database handle or a `.server` module, not
 *   even for a type. Memory `project_rr8_server_import_breaks_only_prod_client_build`
 *   records what that costs: dev and typecheck stay green and only the
 *   production client build fails.
 */

/**
 * The longest clip the browser will record, in seconds.
 *
 * A dictionary query is a word or a short phrase, so twenty seconds is already
 * generous. It is the FIRST guard, because a clip that is never recorded is a
 * request that is never made and money that is never spent.
 */
export const MAX_AUDIO_SECONDS = 20;

/**
 * The largest body the server will accept, in bytes.
 *
 * 1.5 MiB. Opus at the bitrate a browser picks for a microphone track runs
 * around 24 kB per second, so twenty seconds is well inside this, and even a
 * badly configured encoder has room. It is a SECOND guard rather than a
 * restatement of the first: the duration cap lives in the browser, where it can
 * be edited by anyone with a console, and this one lives on the server, where
 * it cannot.
 */
export const MAX_AUDIO_BYTES = 1_572_864;

/** The container formats the transcription path will pass to a provider. */
export type AudioFormat = 'webm' | 'ogg' | 'mp3' | 'wav';

/**
 * Upload MIME type to provider format name.
 *
 * An ALLOW LIST, not a parser. The value is handed to a provider as the
 * `format` of an audio part, so an unrecognised type has to be refused here
 * rather than forwarded and refused there, at the cost of a call.
 */
const FORMAT_BY_MIME_TYPE = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
} satisfies Record<string, AudioFormat>;

/** The mime types the allow list above carries, as a set the lookup can ask. */
const KNOWN_MIME_TYPES = new Map<string, AudioFormat>(Object.entries(FORMAT_BY_MIME_TYPE));

/**
 * The MIME types the browser may offer, best first. `MediaRecorder` picks the
 * first it supports.
 *
 * EVERY ENTRY IS ALSO IN THE ALLOW LIST ABOVE, and that is the point. Safari
 * encodes `audio/mp4`, which this endpoint does not accept, so offering it here
 * would let a browser record a clip that is refused after the upload. A browser
 * that can encode none of these is told so before it records anything.
 */
export const PREFERRED_RECORDING_MIME_TYPES = ['audio/webm', 'audio/ogg', 'audio/wav'] as const;

/**
 * The format name for an upload's content type, or `null` when it is not one we serve.
 *
 * The codec parameter is dropped: a browser sends `audio/webm;codecs=opus`, and
 * the container is what the provider is being told about.
 *
 * @param mimeType the `Content-Type` header, or a `Blob`'s own type.
 */
export function audioFormatForMimeType(mimeType: string | null | undefined): AudioFormat | null {
  if (mimeType === null || mimeType === undefined) return null;
  const container = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return KNOWN_MIME_TYPES.get(container) ?? null;
}

/** Where a recorded clip is posted. One constant, so the client and the route cannot disagree. */
export const TRANSCRIBE_PATH = '/api/v1/transcribe';

/** The query parameter carrying the spoken language of the clip. */
export const TRANSCRIBE_LANGUAGE_PARAM = 'language';
