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

import {
  apiKeys,
  dataSources,
  metricEvents,
  organizationMembers,
  organizations,
  users,
  workflowOperations,
  workflows,
} from '#drizzle/schema';

import type { JsonValue } from './transport';

/** Any JSONB payload. Used for `context`, `result`, `settings`, `config`, … */
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

const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

/** A JSON value re-expressed as a domain value the CLI can branch on. */
export type DecodedJson =
  | { kind: 'null' }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'array'; items: JsonValue[] }
  | { kind: 'object'; entries: Array<[string, JsonValue]> };

/** Decode an arbitrary JSONB value into a variant the caller can switch on. */
export function classifyJson(value: JsonValue): DecodedJson {
  if (z.null().safeParse(value).success) return { kind: 'null' };

  const asString = z.string().safeParse(value);
  if (asString.success) return { kind: 'string', value: asString.data };

  const asNumber = z.number().safeParse(value);
  if (asNumber.success) return { kind: 'number', value: asNumber.data };

  const asBoolean = z.boolean().safeParse(value);
  if (asBoolean.success) return { kind: 'boolean', value: asBoolean.data };

  const asArray = z.array(jsonValueSchema).safeParse(value);
  if (asArray.success) return { kind: 'array', items: asArray.data };

  return { kind: 'object', entries: Object.entries(jsonObjectSchema.parse(value)) };
}

/** True when a JSONB column holds a non-empty object worth printing. */
export function hasJsonPayload(value: JsonValue): boolean {
  const decoded = classifyJson(value);
  return decoded.kind === 'object' && decoded.entries.length > 0;
}

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

export const workflowRowSchema = createSelectSchema(workflows, {
  context: jsonValueSchema,
  createdAt: timestamp,
  startedAt: nullableTimestamp,
  completedAt: nullableTimestamp,
});
export type WorkflowRow = z.infer<typeof workflowRowSchema>;

export const operationRowSchema = createSelectSchema(workflowOperations, {
  result: jsonValueSchema,
  createdAt: timestamp,
  startedAt: nullableTimestamp,
  completedAt: nullableTimestamp,
});
export type OperationRow = z.infer<typeof operationRowSchema>;

/** API keys never cross the boundary with their `hash` column. */
export const apiKeyRowSchema = createSelectSchema(apiKeys, {
  lastUsedAt: nullableTimestamp,
  expiresAt: nullableTimestamp,
  createdAt: timestamp,
}).omit({ hash: true });
export type ApiKeyRow = z.infer<typeof apiKeyRowSchema>;

export const dataSourceRowSchema = createSelectSchema(dataSources, {
  config: jsonValueSchema,
  mapping: jsonValueSchema.nullable(),
  lastFetchedAt: nullableTimestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type DataSourceRow = z.infer<typeof dataSourceRowSchema>;

export const metricEventRowSchema = createSelectSchema(metricEvents, {
  payload: jsonValueSchema,
  timestamp,
  createdAt: timestamp,
});
export type MetricEventRow = z.infer<typeof metricEventRowSchema>;

export const organizationRowSchema = createSelectSchema(organizations, {
  settings: jsonValueSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type OrganizationRow = z.infer<typeof organizationRowSchema>;

/**
 * The `users` row as the API returns it.
 *
 * There is nothing to omit any more: the `password` column went with the
 * bcrypt path, and `users` now carries no credential at all. Authentication
 * lives on `accounts`, whose verifier columns have no CLI surface and must not
 * grow one.
 */
export const userRowSchema = createSelectSchema(users, {
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type UserRow = z.infer<typeof userRowSchema>;

export const memberRowSchema = createSelectSchema(organizationMembers, {
  joinedAt: timestamp,
}).extend({
  user: z.object({ id: z.number(), name: z.string(), email: z.string() }),
});
export type MemberRow = z.infer<typeof memberRowSchema>;

// ---------------------------------------------------------------------------
// Endpoint response schemas
// ---------------------------------------------------------------------------

export const workflowListSchema = paginatedSchema(workflowRowSchema);
export const operationListSchema = paginatedSchema(operationRowSchema);
export const apiKeyListSchema = paginatedSchema(apiKeyRowSchema);
export const dataSourceListSchema = paginatedSchema(dataSourceRowSchema);
export const metricEventListSchema = paginatedSchema(metricEventRowSchema);
export const organizationListSchema = paginatedSchema(organizationRowSchema);
export const userListSchema = paginatedSchema(userRowSchema);
export const memberListSchema = paginatedSchema(memberRowSchema);

export const workflowDetailSchema = z.object({
  workflow: workflowRowSchema,
  operations: z.array(operationRowSchema).optional(),
});

export const workflowCancelSchema = z.object({ workflow: workflowRowSchema });

export const workflowStatsSchema = z.object({
  total: z.number(),
  byStatus: z.record(z.string(), z.number()),
  byType: z.record(z.string(), z.number()),
});

export const workflowTenancyAuditSchema = z.object({
  totals: z.array(
    z.object({ organizationId: z.string().nullable(), count: z.number() }),
  ),
  missing: z.number(),
  orphans: z.array(z.string()),
});

export const apiKeyRevokeSchema = z.object({ record: apiKeyRowSchema.nullable() });

export const userDetailSchema = z.object({ user: userRowSchema });

export const organizationDetailSchema = z.object({
  org: organizationRowSchema,
  members: z.array(memberRowSchema).optional(),
});

export const organizationDeleteSchema = z.object({ deleted: z.boolean() });

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

/** Workflow context bodies are returned verbatim by `workflow context`. */
export const workflowContextSchema = jsonValueSchema;
