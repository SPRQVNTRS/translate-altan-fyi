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
