/**
 * Idempotent index setup for tables we don't own.
 *
 * The `workflows` table comes from `@sprqvntrs/workflows` and has no
 * `organizationId` column — host code stores tenancy in the JSONB `context`
 * field and filters via `context->>'organizationId'`. An expression index on
 * that key keeps the filter SARGable past a few thousand workflow rows.
 *
 * Drizzle's schema introspection doesn't see this external table, so we
 * create the index here at startup instead of via `drizzle:push`.
 *
 * Safe to run on every boot — `CREATE INDEX IF NOT EXISTS` is idempotent.
 */

import type pg from 'pg';
import { z } from 'zod';

/** SQLSTATE 23505 — unique_violation, raised when a racing boot won the CREATE INDEX. */
const uniqueViolationSchema = z.object({ code: z.literal('23505') });

export async function ensureHostIndexes(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // `IF NOT EXISTS` races between concurrent boots (e.g. web + worker
    // calling this in parallel) — both see the index missing in their
    // snapshot, both attempt to create, one wins. Swallow the unique-
    // constraint error on pg_class so the loser proceeds.
    try {
      await client.query(
        `CREATE INDEX IF NOT EXISTS workflows_org_id_idx
         ON workflows ((context->>'organizationId'))`,
      );
    } catch (error: unknown) {
      if (!uniqueViolationSchema.safeParse(error).success) {
        throw error;
      }
    }
  } finally {
    client.release();
  }
}
