/**
 * GET /api/v1/admin/db/pool
 *
 * Auth: superadmin API key only.
 * Response: { total: number, idle: number, waiting: number, instanceNote: string }
 *
 * Note: returns stats for the single server process handling this request.
 * Behind a load balancer with multiple instances, this reflects one instance only.
 */

import type { Route } from './+types/api.v1.admin.db.pool';
import { requireSuperadminApiKey, jsonError } from '#app/lib/api-auth.server';
import { pool } from '#drizzle/db';

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  await requireSuperadminApiKey(request);

  return new Response(
    JSON.stringify({
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      instanceNote:
        'Stats reflect the single server process handling this request. In multi-instance deployments, multiply by instance count for aggregate totals.',
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

export async function action(): Promise<Response> {
  throw jsonError(405, 'method not allowed');
}
