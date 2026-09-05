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

import { getRawDb, pool } from '#drizzle/db';
import { listApiKeys, revokeApiKey } from '#app/models/api-keys.server';
import { listDownVotedTranslationsPage } from '#app/models/translation-votes.server';
import { parsePaginationParams } from '#app/lib/pagination.server';
import { SERVED_LANGUAGES } from '#app/lib/dictionary/detect-language';
import { resolveTranslateRequest } from '#app/lib/translation/translate-request.server';
import { CliApiError, type DirectTransport } from './transport';
import { z } from 'zod';

/** Body accepted by `POST /api/v1/admin/db/query`. */
const sqlQueryBodySchema = z.object({ sql: z.string() });

/**
 * Body accepted by the translate endpoint.
 *
 * IT IS THE SAME SHAPE THE HTTP ROUTE PARSES, and it is restated here rather
 * than imported because the route module pulls in the router's generated types.
 * The BODY of the endpoint is not duplicated: both transports call
 * `resolveTranslateRequest`, which is where every guard and both branches live.
 */
const translateBodySchema = z.object({
  q: z.string().min(1),
  from: z.enum(SERVED_LANGUAGES),
  to: z.enum(SERVED_LANGUAGES),
  wait: z.boolean().default(false),
});

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
  // Translation
  // ---------------------------------------------------------------------------

  // THE REQUEST IS SYNTHESISED, because there is no HTTP request in process.
  // The rate limiter reads an address and a session cookie off it and finds
  // neither, which it treats as unmetered: correct here and only here, since the
  // CLI entrypoint is the trust boundary for direct calls. The length cap, the
  // per-day cap and the daily budget still apply, so a local operator cannot
  // spend past the installation's own limits.
  //
  // THE ORCHESTRATOR IS INITIALISED HERE, AND WITHOUT IT THIS COMMAND CANNOT
  // WORK AT ALL. `getOrchestrator()` throws until something has called
  // `initializeWorkflows()`, and the enqueue reads that failure as "no queue",
  // so every first-time text would come back `failed` with "the translation
  // queue is not available". The web server initialises at boot; a CLI process
  // has to do it for itself. NO WORKER IS STARTED: registering the templates is
  // what lets `start()` resolve a workflow and reach `boss.send`, and the job is
  // then run by whichever deployment holds the worker.
  direct.register('POST', '/api/v1/translate', async ({ body }) => {
    const parsed = translateBodySchema.safeParse(body);
    if (!parsed.success) throw new CliApiError(z.prettifyError(parsed.error), 400);
    if (parsed.data.from === parsed.data.to) {
      throw new CliApiError('from and to must be different languages', 400);
    }
    const request = new Request('https://cli.invalid/translate-command', { method: 'POST' });
    // The import is dynamic for the reason `phrase-enqueue.server.ts` gives for
    // its own: a static edge here would drag every workflow template, every
    // operation handler and every prompt file into EVERY cli invocation,
    // including `db check`.
    const { initializeWorkflows, stopOrchestrator } = await import('#app/services/workflows.server');
    await initializeWorkflows();
    try {
      return await resolveTranslateRequest(getRawDb(), { request, ...parsed.data });
    } finally {
      // Stopped in a `finally`, because pg-boss holds its own connections and a
      // CLI that left them open would never exit. The command's answer is
      // already computed by the time this runs.
      await stopOrchestrator();
    }
  });

  direct.register('GET', '/api/v1/translation-votes', async ({ query }) => {
    const pagination = parsePaginationParams(query);
    const { rows, total } = await listDownVotedTranslationsPage(getRawDb(), pagination);
    return { data: rows, total, limit: pagination.limit, offset: pagination.offset };
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
