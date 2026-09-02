/**
 * POST /api/v1/admin/db/query
 * Body: { sql: string }
 *
 * Auth: superadmin API key only.
 *
 * SECURITY: Read-only enforcement is done at the Postgres session level via
 * `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`, not via string
 * matching (which is bypassable). Postgres itself rejects any write attempt.
 *
 * Response: { rows: unknown[], fields: string[] }
 * On write attempt: { error: string, code: "DB_WRITE_REJECTED" } with HTTP 400
 */

import { z } from 'zod';
import type { Route } from './+types/api.v1.admin.db.query';
import { requireSuperadminApiKey, jsonError, parseJsonBody } from '#app/lib/api-auth.server';
import { pool } from '#drizzle/db';

/** Body accepted by `POST /api/v1/admin/db/query`. */
const dbQueryBodySchema = z.object({ sql: z.string() });

/**
 * Postgres read-only violation codes: 25006 (read_only_sql_transaction) and
 * 0A000 (feature_not_supported for a write in read-only mode).
 */
const readOnlyViolationSchema = z.object({ code: z.enum(['25006', '0A000']) });

export async function loader(): Promise<Response> {
  throw jsonError(405, 'method not allowed');
}

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  if (request.method !== 'POST') throw jsonError(405, 'method not allowed');

  await requireSuperadminApiKey(request);

  const body = await parseJsonBody(request, dbQueryBodySchema);
  const sqlQuery = body.sql.trim();
  if (!sqlQuery) {
    throw jsonError(400, 'sql must not be empty');
  }

  const client = await pool.connect();
  try {
    // Enforce read-only at the database level — not via string matching, which
    // is bypassable via semicolon injection, comment tricks, or COPY.
    //
    // The read-only flag is scoped to a TRANSACTION, never to the SESSION:
    // `SET SESSION CHARACTERISTICS` outlives the request and rides the pooled
    // connection into whatever handler leases it next, leaving that request
    // unable to write. The transaction is always rolled back, so the setting
    // cannot leak no matter how the query ends.
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');

    const result = await client.query(sqlQuery);
    const fields = result.fields.map((f) => f.name);
    await client.query('ROLLBACK');
    return new Response(JSON.stringify({ rows: result.rows, fields }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    const message = err instanceof Error ? err.message : String(err);

    if (readOnlyViolationSchema.safeParse(err).success || message.includes('read-only')) {
      return new Response(
        JSON.stringify({ error: message, code: 'DB_WRITE_REJECTED' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // Other query errors (syntax, table not found, etc.) — 400 with the message
    return new Response(
      JSON.stringify({ error: message, code: 'QUERY_ERROR' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  } finally {
    client.release();
  }
}
