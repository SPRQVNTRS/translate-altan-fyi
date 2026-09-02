/**
 * The JSON value type, shared by every boundary in the app that carries an
 * arbitrary document: JSONB columns, HTTP payloads, queue job data, and the
 * structured context attached to log lines.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object — the common case for payloads and structured context. */
export type JsonObject = { [key: string]: JsonValue };
