import type { DataMigrationDb } from '../runner';

/**
 * No-op bootstrap migration — proves the data-migration wiring works end-to-end.
 * Run once per environment; subsequent runs are skipped via the dataMigrations table.
 */
export default async function (db: DataMigrationDb): Promise<void> {
  // intentionally empty — this migration exists to validate runner discovery and tracking
  void db;
}
