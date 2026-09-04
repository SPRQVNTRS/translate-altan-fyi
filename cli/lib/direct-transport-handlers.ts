/**
 * DirectTransport in-process route handlers.
 *
 * These mirror the HTTP API surface for local CLI use (no --remote flag).
 * Registered once at startup when DirectTransport is active (from cli/index.ts preAction).
 *
 * DirectTransport is trusted in-process, so no auth checks are performed here.
 * The CLI entry point is the trust boundary; these handlers assume the caller
 * is a local operator with legitimate access.
 *
 * Keep this file as the single source of truth for DirectTransport registrations.
 * Command files must NOT inline direct.register() calls, because those run at command
 * registration time against the initial transport singleton, which gets replaced
 * by the preAction hook before any action runs.
 */

import { pool } from '#drizzle/db';
import { listApiKeys, revokeApiKey } from '#app/models/api-keys.server';
import { parsePaginationParams } from '#app/lib/pagination.server';
import { CliApiError, type DirectTransport } from './transport';
import { z } from 'zod';

/** Body accepted by `POST /api/v1/admin/db/query`. */
const sqlQueryBodySchema = z.object({ sql: z.string() });

export function registerDirectTransportHandlers(direct: DirectTransport): void {
  // ---------------------------------------------------------------------------
  // API keys
  // ---------------------------------------------------------------------------

  // GET /api/v1/api-keys
  direct.register('GET', '/api/v1/api-keys', async ({ query }) => {
    const pagination = parsePaginationParams(query);
    const { rows, total } = await listApiKeys(pagination);
    return { data: rows, total, limit: pagination.limit, offset: pagination.offset };
  });

  // DELETE /api/v1/api-keys/:id
  direct.register('DELETE', '/api/v1/api-keys/:id', async ({ params }) => {
    const record = await revokeApiKey(params['id']!);
    return { record };
  });

  // ---------------------------------------------------------------------------
  // DB admin routes (DirectTransport is trusted in-process, no auth check)
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

  // POST /api/v1/admin/db/query, read-only enforced at session level
  direct.register('POST', '/api/v1/admin/db/query', async ({ body }) => {
    const parsed = sqlQueryBodySchema.safeParse(body);
    const sqlQuery = parsed.success ? parsed.data.sql.trim() : '';
    if (!sqlQuery) throw new CliApiError('sql must not be empty', 400);
    const client = await pool.connect();
    try {
      // Transaction-scoped, never session-scoped. See the note in
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
