/**
 * The JSON value type, shared by every boundary in the app that carries an
 * arbitrary document: JSONB columns, HTTP payloads, queue job data, and the
 * structured context attached to log lines.
 */
import { z } from 'zod';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object — the common case for payloads and structured context. */
export type JsonObject = { [key: string]: JsonValue };

/**
 * The runtime decoder for {@link JsonValue}.
 *
 * IT IS THE HOUSE ANSWER TO "IS THIS JSON", and it exists so no boundary has to
 * write a `typeof` ladder: `JSON.parse` hands back a value of no proven shape,
 * and this is the one place that shape is proven. Recursive, so it accepts
 * nested objects and arrays to any depth.
 */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
