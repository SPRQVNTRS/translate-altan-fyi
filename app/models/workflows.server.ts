/**
 * Workflow model — server-side data access functions.
 *
 * All queries use getRawDb() because the workflows table has no organizationId
 * column. Tenant filtering is done via `context->>'organizationId'` JSONB extraction.
 *
 * Both HTTP routes and DirectTransport handlers call these functions so that
 * JSONB extraction logic is never duplicated.
 */

import { workflows, workflowOperations, organizations } from '#drizzle/schema';
import { getRawDb } from '#drizzle/tenant-db';
import { eq, and, inArray, desc, count, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { PaginationParams } from '#app/lib/pagination.server';

// Re-export the inferred types from the schema for use in routes/CLI.
export type Workflow = typeof workflows.$inferSelect;
export type WorkflowOperation = typeof workflowOperations.$inferSelect;

/** A workflow's JSONB context. Its shape is owned by the workflow template. */
export type WorkflowContext = Workflow['context'];

/**
 * Tenancy for a workflow lives in its JSONB context, not in a column — see the
 * module header. This is the one place that extraction is decoded.
 */
const workflowTenancySchema = z.object({ organizationId: z.string() });

/**
 * The org a workflow belongs to, or `null` when its context carries no tenancy.
 * Callers must treat `null` as "deny" — never as "allow any org".
 */
export function workflowOrgId(context: WorkflowContext): string | null {
  const tenancy = workflowTenancySchema.safeParse(context);
  return tenancy.success ? tenancy.data.organizationId : null;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface ListWorkflowsFilters {
  orgId?: string;
  status?: string;
  type?: string;
}

// ---------------------------------------------------------------------------
// listWorkflows
// ---------------------------------------------------------------------------

export async function listWorkflows(
  filters: ListWorkflowsFilters,
  pagination: PaginationParams = { limit: 20, offset: 0 },
): Promise<{ rows: Workflow[]; total: number }> {
  const conditions: SQL[] = [];

  if (filters.orgId) {
    conditions.push(sql`${workflows.context}->>'organizationId' = ${filters.orgId}`);
  }
  if (filters.status) {
    conditions.push(eq(workflows.status, filters.status));
  }
  if (filters.type) {
    conditions.push(eq(workflows.type, filters.type));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, totalRow] = await Promise.all([
    getRawDb()
      .select()
      .from(workflows)
      .where(where)
      .orderBy(desc(workflows.createdAt))
      .limit(pagination.limit)
      .offset(pagination.offset),
    getRawDb()
      .select({ value: count() })
      .from(workflows)
      .where(where)
      .then((r) => r[0]),
  ]);

  return { rows, total: Number(totalRow?.value ?? 0) };
}

// ---------------------------------------------------------------------------
// getWorkflowById
// ---------------------------------------------------------------------------

export async function getWorkflowById(id: string): Promise<Workflow | null> {
  const [row] = await getRawDb()
    .select()
    .from(workflows)
    .where(eq(workflows.id, id))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// listWorkflowOperations
// ---------------------------------------------------------------------------

export async function listWorkflowOperations(
  workflowId: string,
  filters: { status?: string },
  pagination: PaginationParams = { limit: 20, offset: 0 },
): Promise<{ rows: WorkflowOperation[]; total: number }> {
  const conditions: SQL[] = [eq(workflowOperations.workflowId, workflowId)];
  if (filters.status) {
    conditions.push(eq(workflowOperations.status, filters.status));
  }

  const where = and(...conditions);

  const [rows, totalRow] = await Promise.all([
    getRawDb()
      .select()
      .from(workflowOperations)
      .where(where)
      .orderBy(workflowOperations.createdAt)
      .limit(pagination.limit)
      .offset(pagination.offset),
    getRawDb()
      .select({ value: count() })
      .from(workflowOperations)
      .where(where)
      .then((r) => r[0]),
  ]);

  return { rows, total: Number(totalRow?.value ?? 0) };
}

// ---------------------------------------------------------------------------
// getWorkflowContext
// ---------------------------------------------------------------------------

/**
 * Returns the raw context JSONB of the workflow, or null if not found.
 */
export async function getWorkflowContext(id: string): Promise<WorkflowContext | null> {
  const [row] = await getRawDb()
    .select({ context: workflows.context })
    .from(workflows)
    .where(eq(workflows.id, id))
    .limit(1);
  return row?.context ?? null;
}

// ---------------------------------------------------------------------------
// cancelWorkflow — atomic UPDATE with disambiguation
// ---------------------------------------------------------------------------

export type CancelWorkflowResult =
  | { kind: 'cancelled'; workflow: Workflow }
  | { kind: 'notFound' }
  | { kind: 'notCancellable' };

/**
 * Atomically cancel a workflow.
 *
 * Attempts `UPDATE ... WHERE status IN ('pending','running') RETURNING *`.
 * If 0 rows are updated, performs a follow-up SELECT to determine whether
 * the workflow doesn't exist (→ notFound) or exists in a terminal state
 * (→ notCancellable).
 */
export async function cancelWorkflow(id: string): Promise<CancelWorkflowResult> {
  const updated = await getRawDb()
    .update(workflows)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(and(eq(workflows.id, id), inArray(workflows.status, ['pending', 'running'])))
    .returning();

  if (updated.length > 0 && updated[0]) {
    return { kind: 'cancelled', workflow: updated[0] };
  }

  // 0 rows updated — disambiguate
  const existing = await getWorkflowById(id);
  if (!existing) {
    return { kind: 'notFound' };
  }
  return { kind: 'notCancellable' };
}

// ---------------------------------------------------------------------------
// getWorkflowStats
// ---------------------------------------------------------------------------

export async function getWorkflowStats(orgId?: string): Promise<{
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
}> {
  const where = orgId
    ? sql`${workflows.context}->>'organizationId' = ${orgId}`
    : undefined;

  const rows = await getRawDb()
    .select({
      status: workflows.status,
      type: workflows.type,
    })
    .from(workflows)
    .where(where);

  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};

  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    byType[row.type] = (byType[row.type] ?? 0) + 1;
  }

  return { total: rows.length, byStatus, byType };
}

// ---------------------------------------------------------------------------
// auditWorkflowTenancy
// ---------------------------------------------------------------------------

export interface TenancyAuditRow {
  organizationId: string | null;
  count: number;
}

/** Column shape of the raw tenancy-audit aggregate query below. */
const tenancyAuditRowsSchema = z.array(
  z.object({ organization_id: z.string().nullable(), count: z.number() }),
);

export async function auditWorkflowTenancy(): Promise<{
  totals: TenancyAuditRow[];
  missing: number;
  orphans: string[];
}> {
  // Raw SQL — group by extracted organizationId including NULLs
  const result = await getRawDb().execute(
    sql`SELECT (context->>'organizationId') AS organization_id, COUNT(*)::int AS count
        FROM workflows
        GROUP BY organization_id
        ORDER BY count DESC`,
  );

  const totals = tenancyAuditRowsSchema.parse(result.rows).map((r) => ({
    organizationId: r.organization_id,
    count: r.count,
  }));

  const missing = totals.find((r) => r.organizationId === null)?.count ?? 0;

  // Cross-check against known organizations
  const knownOrgs = await getRawDb()
    .select({ id: organizations.id })
    .from(organizations);
  const knownIds = new Set(knownOrgs.map((o) => o.id));

  const orphans = totals
    .map((r) => r.organizationId)
    .filter((orgId): orgId is string => orgId !== null && !knownIds.has(orgId));

  return { totals, missing, orphans };
}
