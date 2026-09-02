/**
 * DirectTransport in-process route handlers.
 *
 * These mirror the HTTP API surface for local CLI use (no --remote flag).
 * Registered once at startup when DirectTransport is active (from cli/index.ts preAction).
 *
 * DirectTransport is trusted in-process — no auth checks are performed here.
 * The CLI entry point is the trust boundary; these handlers assume the caller
 * is a local operator with legitimate access.
 *
 * Keep this file as the single source of truth for DirectTransport registrations.
 * Command files must NOT inline direct.register() calls — those run at command
 * registration time against the initial transport singleton, which gets replaced
 * by the preAction hook before any action runs.
 */

import { organizations, metricEvents } from '#drizzle/schema';
import { pool } from '#drizzle/db';
import { getRawDb } from '#drizzle/tenant-db';
import { eq, and, desc, count, type SQL } from 'drizzle-orm';
import { listApiKeys, adminRevokeApiKey } from '#app/models/api-keys.server';
import { listDataSources } from '#app/models/data-sources.server';
import { getMetricEvents } from '#app/models/metric-events.server';
import { parsePaginationParams } from '#app/lib/pagination.server';
import {
  listWorkflows,
  getWorkflowById,
  listWorkflowOperations,
  getWorkflowContext,
  cancelWorkflow,
  getWorkflowStats,
  auditWorkflowTenancy,
} from '#app/models/workflows.server';
import {
  listUsersAdmin,
  getUserByIdAdmin,
  getUserByEmailAdmin,
  patchUserAdmin,
} from '#app/models/users-admin.server';
import {
  listOrgsAdmin,
  getOrgByIdOrSlug,
  getOrgMembersAdmin,
  countOrgMembersAdmin,
  deleteOrgAdmin,
} from '#app/models/orgs-admin.server';
import { CliApiError, singleQueryParam, type DirectTransport } from './transport';
import { z } from 'zod';

/** Body accepted by `PATCH /api/v1/users/:id`. */
const patchUserBodySchema = z.object({
  deactivated: z.boolean().optional(),
  isSuperadmin: z.boolean().optional(),
});

/** Body accepted by `POST /api/v1/admin/db/query`. */
const sqlQueryBodySchema = z.object({ sql: z.string() });

export function registerDirectTransportHandlers(direct: DirectTransport): void {
  // ---------------------------------------------------------------------------
  // API keys
  // ---------------------------------------------------------------------------

  // GET /api/v1/api-keys?org=<slug>
  direct.register('GET', '/api/v1/api-keys', async ({ query }) => {
    const slug = singleQueryParam(query, 'org');
    if (!slug) return { data: [], total: 0, limit: 20, offset: 0 };
    const org = await getRawDb().query.organizations.findFirst({
      where: eq(organizations.slug, slug),
    });
    if (!org) throw new CliApiError('organization not found', 404);
    const pagination = parsePaginationParams(query);
    const { rows, total } = await listApiKeys({ orgId: org.id }, pagination);
    return { data: rows, total, limit: pagination.limit, offset: pagination.offset };
  });

  // DELETE /api/v1/api-keys/:id
  direct.register('DELETE', '/api/v1/api-keys/:id', async ({ params }) => {
    const record = await adminRevokeApiKey(params['id']!);
    return { record };
  });

  // ---------------------------------------------------------------------------
  // Data sources
  // ---------------------------------------------------------------------------

  // GET /api/v1/data-sources?org=<slug>
  direct.register('GET', '/api/v1/data-sources', async ({ query }) => {
    const slug = singleQueryParam(query, 'org');
    if (!slug) return { data: [], total: 0, limit: 20, offset: 0 };
    const org = await getRawDb().query.organizations.findFirst({
      where: eq(organizations.slug, slug),
    });
    if (!org) throw new CliApiError('organization not found', 404);
    const pagination = parsePaginationParams(query);
    const { rows, total } = await listDataSources({ orgId: org.id }, pagination);
    return { data: rows, total, limit: pagination.limit, offset: pagination.offset };
  });

  // ---------------------------------------------------------------------------
  // Metric events
  // ---------------------------------------------------------------------------

  // GET /api/v1/metric-events?org=<slug>&source=<s>&type=<t>&limit=<n>&offset=<n>
  direct.register('GET', '/api/v1/metric-events', async ({ query }) => {
    const org = singleQueryParam(query, 'org');
    const source = singleQueryParam(query, 'source');
    const type = singleQueryParam(query, 'type');
    const pagination = parsePaginationParams(query);

    if (org) {
      const orgRecord = await getRawDb().query.organizations.findFirst({
        where: eq(organizations.slug, org),
      });
      if (!orgRecord) throw new CliApiError('organization not found', 404);
      const { rows, total } = await getMetricEvents(
        { orgId: orgRecord.id },
        { source, eventType: type },
        pagination,
      );
      return { data: rows, total, limit: pagination.limit, offset: pagination.offset };
    }

    // Global view (no org) — DirectTransport is trusted in-process; no superadmin check needed
    const conditions: SQL[] = [];
    if (source) conditions.push(eq(metricEvents.source, source));
    if (type) conditions.push(eq(metricEvents.eventType, type));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const [rows, totalRow] = await Promise.all([
      getRawDb()
        .select()
        .from(metricEvents)
        .where(where)
        .orderBy(desc(metricEvents.timestamp))
        .limit(pagination.limit)
        .offset(pagination.offset),
      getRawDb()
        .select({ value: count() })
        .from(metricEvents)
        .where(where)
        .then((r) => r[0]),
    ]);
    const total = Number(totalRow?.value ?? 0);
    return { data: rows, total, limit: pagination.limit, offset: pagination.offset };
  });

  // ---------------------------------------------------------------------------
  // Workflow routes — static routes MUST be registered before dynamic :id routes
  // ---------------------------------------------------------------------------

  // GET /api/v1/workflows
  direct.register('GET', '/api/v1/workflows', async ({ query }) => {
    const orgId = singleQueryParam(query, 'org');
    const status = singleQueryParam(query, 'status');
    const type = singleQueryParam(query, 'type');
    const pagination = parsePaginationParams(query);
    const { rows, total } = await listWorkflows({ orgId, status, type }, pagination);
    return { data: rows, total, limit: pagination.limit, offset: pagination.offset };
  });

  // GET /api/v1/workflows/stats  (before :id)
  direct.register('GET', '/api/v1/workflows/stats', async ({ query }) => {
    const orgId = singleQueryParam(query, 'org');
    return getWorkflowStats(orgId);
  });

  // GET /api/v1/workflows/audit-tenancy  (before :id)
  direct.register('GET', '/api/v1/workflows/audit-tenancy', async () => {
    return auditWorkflowTenancy();
  });

  // GET /api/v1/workflows/:id
  direct.register('GET', '/api/v1/workflows/:id', async ({ params, query }) => {
    const wf = await getWorkflowById(params['id']!);
    if (!wf) throw new CliApiError('workflow not found', 404);
    const withOperations = query['withOperations'] === 'true';
    if (withOperations) {
      const { rows: operations } = await listWorkflowOperations(params['id']!, {});
      return { workflow: wf, operations };
    }
    return { workflow: wf };
  });

  // GET /api/v1/workflows/:id/operations
  direct.register('GET', '/api/v1/workflows/:id/operations', async ({ params, query }) => {
    const wf = await getWorkflowById(params['id']!);
    if (!wf) throw new CliApiError('workflow not found', 404);
    const status = singleQueryParam(query, 'status');
    const pagination = parsePaginationParams(query);
    const { rows, total } = await listWorkflowOperations(params['id']!, { status }, pagination);
    return { data: rows, total, limit: pagination.limit, offset: pagination.offset };
  });

  // GET /api/v1/workflows/:id/context
  direct.register('GET', '/api/v1/workflows/:id/context', async ({ params }) => {
    const ctx = await getWorkflowContext(params['id']!);
    if (ctx === null || ctx === undefined) throw new CliApiError('workflow not found', 404);
    return ctx;
  });

  // POST /api/v1/workflows/:id/cancel
  direct.register('POST', '/api/v1/workflows/:id/cancel', async ({ params }) => {
    const result = await cancelWorkflow(params['id']!);
    if (result.kind === 'cancelled') return { workflow: result.workflow };
    if (result.kind === 'notFound') throw new CliApiError('workflow not found', 404);
    throw new CliApiError('workflow cannot be cancelled in its current state', 409);
  });

  // ---------------------------------------------------------------------------
  // User routes (superadmin — DirectTransport is trusted, no auth check needed)
  // ---------------------------------------------------------------------------

  // GET /api/v1/users
  direct.register('GET', '/api/v1/users', async ({ query }) => {
    const pagination = parsePaginationParams(query);
    const { rows, total } = await listUsersAdmin(
      {
        active: query['active'] === 'true' || undefined,
        deactivated: query['deactivated'] === 'true' || undefined,
        superadmin: query['superadmin'] === 'true' || undefined,
      },
      pagination,
    );
    return { data: rows, total, limit: pagination.limit, offset: pagination.offset };
  });

  // GET /api/v1/users/by-email/:email  (before :id)
  direct.register('GET', '/api/v1/users/by-email/:email', async ({ params }) => {
    const email = decodeURIComponent(params['email']!);
    const user = await getUserByEmailAdmin(email);
    if (!user) throw new CliApiError('user not found', 404);
    return { user };
  });

  // GET /api/v1/users/:id
  direct.register('GET', '/api/v1/users/:id', async ({ params }) => {
    const id = parseInt(params['id']!, 10);
    const user = await getUserByIdAdmin(id);
    if (!user) throw new CliApiError('user not found', 404);
    return { user };
  });

  // PATCH /api/v1/users/:id
  direct.register('PATCH', '/api/v1/users/:id', async ({ params, body }) => {
    const id = parseInt(params['id']!, 10);
    const fields = patchUserBodySchema.parse(body);
    const user = await patchUserAdmin(id, fields);
    if (!user) throw new CliApiError('user not found', 404);
    return { user };
  });

  // ---------------------------------------------------------------------------
  // Org routes (superadmin — DirectTransport is trusted, no auth check needed)
  // Static :idOrSlug/members before :idOrSlug to avoid member slug collision
  // ---------------------------------------------------------------------------

  // GET /api/v1/orgs
  direct.register('GET', '/api/v1/orgs', async ({ query }) => {
    const pagination = parsePaginationParams(query);
    const { rows, total } = await listOrgsAdmin(pagination);
    return { data: rows, total, limit: pagination.limit, offset: pagination.offset };
  });

  // GET /api/v1/orgs/:idOrSlug/members  (before :idOrSlug)
  direct.register('GET', '/api/v1/orgs/:idOrSlug/members', async ({ params, query }) => {
    const org = await getOrgByIdOrSlug(params['idOrSlug']!);
    if (!org) throw new CliApiError('organization not found', 404);
    const pagination = parsePaginationParams(query);
    const { rows, total } = await getOrgMembersAdmin(org.id, pagination);
    return { data: rows, total, limit: pagination.limit, offset: pagination.offset };
  });

  // GET /api/v1/orgs/:idOrSlug
  direct.register('GET', '/api/v1/orgs/:idOrSlug', async ({ params, query }) => {
    const org = await getOrgByIdOrSlug(params['idOrSlug']!);
    if (!org) throw new CliApiError('organization not found', 404);
    if (query['withMembers'] === 'true') {
      const { rows: members } = await getOrgMembersAdmin(org.id);
      return { org, members };
    }
    return { org };
  });

  // DELETE /api/v1/orgs/:idOrSlug
  direct.register('DELETE', '/api/v1/orgs/:idOrSlug', async ({ params, query }) => {
    const org = await getOrgByIdOrSlug(params['idOrSlug']!);
    if (!org) throw new CliApiError('organization not found', 404);
    if (query['dryRun'] === 'true') {
      const memberCount = await countOrgMembersAdmin(org.id);
      return { dryRun: true, org, memberCount };
    }
    if (query['force'] !== 'true') {
      throw new CliApiError('pass force=true to confirm deletion', 400);
    }
    await deleteOrgAdmin(org.id);
    return { deleted: true };
  });

  // ---------------------------------------------------------------------------
  // DB admin routes (DirectTransport — trusted in-process, no auth check)
  // ---------------------------------------------------------------------------

  // GET /api/v1/admin/db/check
  direct.register('GET', '/api/v1/admin/db/check', async () => {
    const client = await pool.connect();
    try {
      const result = await client.query<{ time: string; database: string; user: string }>(
        'SELECT NOW() AS time, current_database() AS database, current_user AS "user"'
      );
      const row = result.rows[0];
      return { connected: true, database: row?.database ?? '', user: row?.user ?? '', serverTime: row?.time ?? '' };
    } finally {
      client.release();
    }
  });

  // GET /api/v1/admin/db/pool
  direct.register('GET', '/api/v1/admin/db/pool', async () => {
    return {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      instanceNote: 'Stats reflect the single server process. In multi-instance deployments, multiply by instance count.',
    };
  });

  // GET /api/v1/admin/db/tables
  direct.register('GET', '/api/v1/admin/db/tables', async () => {
    const client = await pool.connect();
    try {
      const result = await client.query<{ table_name: string; size: string }>(
        `SELECT table_name, pg_size_pretty(pg_total_relation_size(quote_ident(table_name))) AS size
         FROM information_schema.tables
         WHERE table_schema = 'public'
         ORDER BY table_name`
      );
      return { data: result.rows.map((r) => ({ tableName: r.table_name, size: r.size })) };
    } finally {
      client.release();
    }
  });

  // GET /api/v1/admin/db/describe/:table
  direct.register('GET', '/api/v1/admin/db/describe/:table', async ({ params }) => {
    const client = await pool.connect();
    try {
      const result = await client.query<{
        column_name: string; data_type: string; is_nullable: string; column_default: string | null;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position`,
        [params['table']]
      );
      if (result.rows.length === 0) throw new CliApiError(`table not found`, 404);
      return { columns: result.rows.map((r) => ({ columnName: r.column_name, dataType: r.data_type, isNullable: r.is_nullable, columnDefault: r.column_default })) };
    } finally {
      client.release();
    }
  });

  // POST /api/v1/admin/db/query — read-only enforced at session level
  direct.register('POST', '/api/v1/admin/db/query', async ({ body }) => {
    const parsed = sqlQueryBodySchema.safeParse(body);
    const sqlQuery = parsed.success ? parsed.data.sql.trim() : '';
    if (!sqlQuery) throw new CliApiError('sql must not be empty', 400);
    const client = await pool.connect();
    try {
      // Transaction-scoped, never session-scoped — see the note in
       // app/routes/api.v1.admin.db.query.ts. A session-level setting would
       // ride the pooled connection into the next handler.
      await client.query('BEGIN');
      await client.query('SET TRANSACTION READ ONLY');
      const result = await client.query(sqlQuery);
      await client.query('ROLLBACK');
      return { rows: result.rows, fields: result.fields.map((f) => f.name) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      throw new CliApiError(message, 400);
    } finally {
      client.release();
    }
  });
}
