/**
 * `pnpm cli data-migration run` / `pnpm cli data-migration list`
 *
 * Apply all pending data migrations. Uses direct DB access (getRawDb) — this
 * is a deploy-time bootstrap command that runs before the API server is up.
 * Per ADR-0001, this is an explicit exception to the "CLI wraps the API" rule.
 */

import { Command } from 'commander';
import { getRawDb } from '#drizzle/tenant-db';
import { runPendingDataMigrations } from '#drizzle/data-migrations/runner';
import { dataMigrations } from '#drizzle/schema';
import { printSuccess, printError, c } from '../../lib/output';
import { desc } from 'drizzle-orm';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Path to migrations relative to the project root — used for `list` command
const MIGRATIONS_DIR = join(
  process.cwd(),
  'drizzle/data-migrations/migrations',
);

export function registerDataMigrationCommands(program: Command): void {
  const dataMigration = program
    .command('data-migration')
    .description('Manage data migrations');

  dataMigration
    .command('run')
    .description('Apply all pending data migrations (deploy step)')
    .action(async () => {
      await runCmd();
    });

  dataMigration
    .command('list')
    .description('List applied and pending data migrations')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .action(async (options: { format: string }) => {
      await listCmd(options);
    });
}

async function runCmd(): Promise<void> {
  try {
    const db = getRawDb();
    const { applied, skipped } = await runPendingDataMigrations(db);

    for (const name of skipped) {
      console.log(`Skipped (already applied): ${name}`);
    }
    for (const name of applied) {
      printSuccess(`Applied: ${name}`);
    }

    console.log(`\nDone: ${applied.length} applied, ${skipped.length} skipped`);
  } catch (err) {
    printError(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

async function listCmd(options: { format: string }): Promise<void> {
  const db = getRawDb();

  // Get applied rows
  const appliedRows = await db
    .select()
    .from(dataMigrations)
    .orderBy(desc(dataMigrations.appliedAt));

  const appliedMap = new Map(appliedRows.map((r) => [r.name, r.appliedAt]));

  // Discover all migration files
  let files: string[] = [];
  try {
    const allFiles = await readdir(MIGRATIONS_DIR);
    files = allFiles
      .filter((f) => f.endsWith('.ts') && /^\d{4}-\d{2}-\d{2}-/.test(f))
      .toSorted()
      .map((f) => f.replace(/\.ts$/, ''));
  } catch {
    // no migrations dir yet — empty list
  }

  const rows = files.map((name) => {
    const appliedAt = appliedMap.get(name);
    return {
      name,
      status: appliedAt ? 'applied' : 'pending',
      appliedAt: appliedAt ?? null,
    };
  });

  if (options.format === 'json') {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(c.dim('No data migrations found'));
    return;
  }

  for (const row of rows) {
    if (row.status === 'applied' && row.appliedAt) {
      const d = row.appliedAt instanceof Date ? row.appliedAt : new Date(row.appliedAt);
      console.log(`[${c.green('applied')} ${d.toISOString().slice(0, 16).replace('T', ' ')}] ${row.name}`);
    } else {
      console.log(`[${c.yellow('pending')}] ${row.name}`);
    }
  }
}
