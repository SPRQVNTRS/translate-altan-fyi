/**
 * GET /api/v1/admin/db/tables
 *
 * Auth: superadmin API key only.
 * Response: { data: Array<{ tableName: string, size: string }> }
 */

import type { Route } from './+types/api.v1.admin.db.tables';
import { requireSuperadminApiKey, jsonError } from '#app/lib/api-auth.server';
import { pool } from '#drizzle/db';

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  await requireSuperadminApiKey(request);

  const client = await pool.connect();
  try {
    const result = await client.query<{ table_name: string; size: string }>(`
      SELECT table_name,
             pg_size_pretty(pg_total_relation_size(quote_ident(table_name))) AS size
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    const data = result.rows.map((r) => ({ tableName: r.table_name, size: r.size }));
    return new Response(JSON.stringify({ data }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } finally {
    client.release();
  }
}

export async function action(): Promise<Response> {
  throw jsonError(405, 'method not allowed');
}
