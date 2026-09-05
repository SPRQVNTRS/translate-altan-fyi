/**
 * CLI response schemas.
 *
 * Every `transport.get/post/patch/delete` call names one of these. They are the
 * CLI's single description of what the API returns, and they must accept both
 * transports: `HttpTransport` delivers serialized JSON (timestamps as ISO
 * strings), `DirectTransport` delivers live Drizzle rows (timestamps as `Date`).
 * `z.coerce.date()` on every timestamp column is what reconciles the two.
 *
 * Row schemas are derived from the Drizzle tables via `createSelectSchema`, so
 * a column added or renamed in `drizzle/schema.ts` shows up here as a type
 * error rather than as a silent runtime mismatch.
 */

import { createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';

import { apiKeys } from '#drizzle/schema';

/** A timestamp column, whether it arrives as a `Date` or an ISO-8601 string. */
const timestamp = z.coerce.date();
const nullableTimestamp = z.coerce.date().nullable();

/** The `{ data, total, limit, offset }` envelope every list endpoint returns. */
export function paginatedSchema<TItem>(item: z.ZodType<TItem>) {
  return z.object({
    data: z.array(item),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  });
}

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

/** API keys never cross the boundary with their `hash` column. */
export const apiKeyRowSchema = createSelectSchema(apiKeys, {
  lastUsedAt: nullableTimestamp,
  expiresAt: nullableTimestamp,
  createdAt: timestamp,
}).omit({ hash: true });
export type ApiKeyRow = z.infer<typeof apiKeyRowSchema>;

// ---------------------------------------------------------------------------
// Endpoint response schemas
// ---------------------------------------------------------------------------

export const apiKeyListSchema = paginatedSchema(apiKeyRowSchema);

export const apiKeyRevokeSchema = z.object({ record: apiKeyRowSchema.nullable() });

export const dbCheckSchema = z.object({
  connected: z.boolean(),
  database: z.string(),
  user: z.string(),
  // `SELECT NOW()` arrives as a Date from the pg driver and as an ISO string
  // over HTTP, the same reconciliation as every other timestamp here.
  serverTime: timestamp,
});

export const dbPoolSchema = z.object({
  total: z.number(),
  idle: z.number(),
  waiting: z.number(),
  instanceNote: z.string().optional(),
});

export const dbTablesSchema = z.object({
  data: z.array(z.object({ tableName: z.string(), size: z.string() })),
});

export const dbDescribeSchema = z.object({
  columns: z.array(
    z.object({
      columnName: z.string(),
      dataType: z.string(),
      isNullable: z.string(),
      columnDefault: z.string().nullable(),
    }),
  ),
});

/**
 * `db query` runs operator-supplied SQL, so a cell can hold anything the
 * driver decodes: text, numbers, dates, bytea. The CLI never interprets a
 * cell, it only renders it, so the schema deliberately does not constrain one:
 * narrowing here would reject valid queries rather than catch a contract break.
 */
export const dbQuerySchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  fields: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/**
 * One answered row, as the pane renders it and the CLI prints it.
 *
 * ON THE PHRASE BRANCH `lemma` HOLDS A WHOLE SENTENCE and `translationId` names
 * a `phrase_translations` row rather than a dictionary edge. The schema is the
 * same either way on purpose: a caller must not be able to tell which branch
 * answered, which is the API-side reading of M195 decision 7.
 */
const translationRowSchema = z.object({
  translationId: z.string(),
  lemma: z.string(),
  pos: z.string().nullable(),
  confidence: z.number().nullable(),
  /**
   * One short sentence, in the SOURCE language, saying when this word is used
   * rather than the others, or `null`.
   *
   * THE FIELD IS REQUIRED HERE AND ONLY ITS VALUE IS NULLABLE. `z.object` strips
   * whatever it was not told about, so a field missing from this schema is a
   * field the CLI throws away even when the server sent it. That is exactly how
   * the API answer came to be poorer than the screen, and requiring the key is
   * what turns a server that stops sending it into a loud parse failure instead
   * of a silently thinner answer.
   *
   * `null` IS THE ORDINARY CASE, not a gap: every imported edge carries none,
   * every edge generated before prompt v2 carries none, and the phrase branch
   * sets it to null by construction, because a lone translated sentence has
   * nothing to be disambiguated from.
   */
  note: z.string().nullable(),
  generated: z.boolean(),
  up: z.number(),
  down: z.number(),
  myVote: z.union([z.literal(-1), z.literal(1)]).nullable(),
});

/**
 * The five states the pane has, plus the internal `none`.
 *
 * `none` IS HERE BECAUSE THE API CAN RETURN IT. It means "nothing has happened
 * for this pair yet", which a caller sees when a guard refused nothing and no
 * run has been recorded, and the CLI prints it as such rather than crashing on
 * a state its schema forgot.
 */
const translationPanelSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ready'), translations: z.array(translationRowSchema) }),
  z.object({ state: z.literal('translating') }),
  z.object({ state: z.literal('failed'), canRetry: z.literal(true), error: z.string().nullable() }),
  z.object({
    state: z.literal('budget'),
    reason: z.enum(['rate-limited', 'budget', 'daily-cap', 'too-long']),
  }),
  z.object({ state: z.literal('no-entry') }),
  z.object({ state: z.literal('none') }),
]);

/** What `POST /api/v1/translate` answers, for a word and for a sentence alike. */
export const translateAnswerSchema = z.object({
  q: z.string(),
  from: z.string(),
  to: z.string(),
  kind: z.enum(['word', 'phrase']),
  headwordId: z.string().nullable(),
  panel: translationPanelSchema,
});
export type TranslateAnswerResponse = z.infer<typeof translateAnswerSchema>;

/** One down-voted edge, as `GET /api/v1/translation-votes` lists it. */
export const downVotedTranslationSchema = z.object({
  translationId: z.string(),
  lemma: z.string(),
  fromLanguageCode: z.string(),
  toLanguageCode: z.string(),
  up: z.number(),
  down: z.number(),
  lastVotedAt: timestamp,
});
export type DownVotedTranslationRow = z.infer<typeof downVotedTranslationSchema>;

export const translationVotesListSchema = paginatedSchema(downVotedTranslationSchema);
