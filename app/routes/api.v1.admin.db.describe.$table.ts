/**
 * GET /api/v1/admin/db/describe/:table
 *
 * Auth: superadmin API key only.
 * Response: { columns: Array<{ columnName: string, dataType: string, isNullable: string, columnDefault: string|null }> }
 */

import type { Route } from './+types/api.v1.admin.db.describe.$table';
import { requireSuperadminApiKey, jsonError } from '#app/lib/api-auth.server';
import { pool } from '#drizzle/db';

export async function loader({ request, params }: Route.LoaderArgs): Promise<Response> {
  await requireSuperadminApiKey(request);

  const { table } = params;
  if (!table) throw jsonError(400, 'missing table parameter');

  const client = await pool.connect();
  try {
    const result = await client.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [table],
    );

    if (result.rows.length === 0) {
      throw jsonError(404, `table "${table}" not found`);
    }

    const columns = result.rows.map((r) => ({
      columnName: r.column_name,
      dataType: r.data_type,
      isNullable: r.is_nullable,
      columnDefault: r.column_default,
    }));

    return new Response(JSON.stringify({ columns }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } finally {
    client.release();
  }
}

export async function action(): Promise<Response> {
  throw jsonError(405, 'method not allowed');
}
