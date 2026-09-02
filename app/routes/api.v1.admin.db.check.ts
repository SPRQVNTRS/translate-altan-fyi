/**
 * GET /api/v1/admin/db/check
 *
 * Auth: superadmin API key only.
 * Response: { connected: true, database: string, user: string, serverTime: string }
 */

import type { Route } from './+types/api.v1.admin.db.check';
import { requireSuperadminApiKey, jsonError } from '#app/lib/api-auth.server';
import { pool } from '#drizzle/db';

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  await requireSuperadminApiKey(request);

  const client = await pool.connect();
  try {
    const result = await client.query<{ time: string; database: string; user: string }>(
      'SELECT NOW() AS time, current_database() AS database, current_user AS "user"',
    );
    const row = result.rows[0];

    return new Response(
      JSON.stringify({
        connected: true,
        database: row?.database ?? '',
        user: row?.user ?? '',
        serverTime: row?.time ?? '',
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } finally {
    client.release();
  }
}

export async function action(): Promise<Response> {
  throw jsonError(405, 'method not allowed');
}
