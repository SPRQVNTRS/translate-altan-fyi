/**
 * Data Migration Runner
 *
 * Discovers, filters, and executes pending data migrations in lexical order.
 * Each migration runs in a transaction — the tracking insert is part of the
 * same transaction, so a failure leaves no partial state.
 *
 * The runner accepts the Drizzle DB instance as a parameter so it is testable
 * without a live database connection.
 *
 * Usage: `await runPendingDataMigrations(getRawDb())`
 */

import { readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '#drizzle/schema';
import { dataMigrations } from '#drizzle/schema';
import { z } from 'zod';

/**
 * The handle a data migration receives. The runner wraps every migration in a
 * transaction, so this is the transaction handle rather than the pool database.
 */
export type DataMigrationDb = Parameters<
  Parameters<NodePgDatabase<typeof schema>['transaction']>[0]
>[0];

/** The function every data migration default-exports. */
export type DataMigration = (db: DataMigrationDb) => Promise<void>;

const migrationModuleSchema = z.object({
  default: z.custom<DataMigration>(
    (value) => value instanceof Function,
    'a data migration must default-export a function',
  ),
});

// Resolve the migrations directory relative to the project working directory.
// This works for both tsx (ts-node) and compiled output.
function getMigrationsDir(): string {
  return join(process.cwd(), 'drizzle/data-migrations/migrations');
}

const DATE_SLUG_RE = /^\d{4}-\d{2}-\d{2}-/;

export async function runPendingDataMigrations(
  db: NodePgDatabase<typeof schema>,
): Promise<{ applied: string[]; skipped: string[] }> {
  const migrationsDir = getMigrationsDir();

  // Discover all migration files matching the date-slug pattern
  const allFiles = await readdir(migrationsDir);
  const migrationFiles = allFiles
    .filter((f) => f.endsWith('.ts') && DATE_SLUG_RE.test(f))
    .toSorted(); // lexical order == chronological order via date prefix

  const migrationNames = migrationFiles.map((f) => basename(f, '.ts'));

  // Query applied migrations
  const appliedRows = await db.select({ name: dataMigrations.name }).from(dataMigrations);
  const appliedSet = new Set(appliedRows.map((r) => r.name));

  const skipped = migrationNames.filter((n) => appliedSet.has(n));
  const pending = migrationNames.filter((n) => !appliedSet.has(n));
  const applied: string[] = [];

  for (const name of pending) {
    const absolutePath = join(migrationsDir, `${name}.ts`);
    console.log(`[data-migration] running ${name}`);

    await db.transaction(async (tx) => {
      // Dynamic import — works with tsx in dev, requires loader in production
      const migrationModule = await import(absolutePath);
      const runMigration = migrationModuleSchema.parse(migrationModule).default;
      await runMigration(tx);
      await tx.insert(dataMigrations).values({ name });
    });

    console.log(`[data-migration] applied ${name}`);
    applied.push(name);
  }

  return { applied, skipped };
}
