import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';
import { CONFIG } from '#config';
import { createServerLogger } from '@sprqvntrs/logger/server';
import { connectWithRetry } from './pool-retry';

const { logger } = createServerLogger({
  serviceName: 'database',
  pretty: process.env.NODE_ENV !== 'production',
});

/**
 * Database Connection Pool
 *
 * Uses pg.Pool for connection pooling instead of a single client connection.
 * Pool settings are configured via environment variables (see CONFIG.database.pool).
 */
export const pool = new pg.Pool({
  connectionString: CONFIG.database.url,
  max: CONFIG.database.pool.max,
  min: CONFIG.database.pool.min,
  idleTimeoutMillis: CONFIG.database.pool.idleTimeoutMillis,
  connectionTimeoutMillis: CONFIG.database.pool.connectionTimeoutMillis,
  ssl: CONFIG.database.ssl ? { rejectUnauthorized: false } : undefined,
});

// Pool event monitoring
pool.on('connect', () => {
  logger.debug('New database connection established', {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  });
});

pool.on('acquire', () => {
  logger.debug('Connection acquired from pool', {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  });
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle client', { error: err });
});

pool.on('remove', () => {
  logger.debug('Connection removed from pool', {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  });
});

export const db = drizzle(pool, { schema });

// Keep client export for backward compatibility (uses pool internally)
export const client = pool;

// Periodic pool stats logging (every 60 seconds) - only in production
let statsIntervalId: NodeJS.Timeout | undefined;
if (CONFIG.app.isProduction) {
  statsIntervalId = setInterval(() => {
    const stats = {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };

    if (pool.waitingCount > 5) {
      logger.warn('Connection pool under pressure', stats);
    } else {
      logger.info('Connection pool stats', stats);
    }
  }, 60000);
}

let poolClosed = false;

/**
 * Cleanly close the database pool.
 * Clears the stats interval timer before ending the pool so the
 * event loop can drain naturally. Safe to call multiple times.
 */
export async function closePool(): Promise<void> {
  if (poolClosed) return;
  poolClosed = true;

  if (statsIntervalId) {
    clearInterval(statsIntervalId);
    statsIntervalId = undefined;
  }

  await pool.end();
  logger.info('Database pool closed');
}

/**
 * Initialize and verify database pool connection.
 *
 * Also ensures host-managed indexes on external-package tables (workflows
 * JSONB-tenancy index). Idempotent — safe on every boot.
 *
 * @param maxAttempts - retry budget for the initial connect. Pass `1` for
 *   fail-fast behaviour (CLI commands, tests). Default 6 ≈ ~61s worst case.
 */
async function initializePool(maxAttempts = 6) {
  try {
    const testClient = await connectWithRetry<pg.PoolClient>(pool, maxAttempts, { logger });
    if (!process.env.CLI_MODE) {
      logger.info('Database pool initialized successfully', {
        maxSize: CONFIG.database.pool.max,
        minSize: CONFIG.database.pool.min,
        idleTimeout: CONFIG.database.pool.idleTimeoutMillis,
        connectionTimeout: CONFIG.database.pool.connectionTimeoutMillis,
      });
    }
    testClient.release();

    // Host-managed indexes only need to exist while the long-running server
    // or worker is up. CLI processes start, run a single command, then call
    // pool.end() in their `.finally`; that races the fire-and-forget index
    // creation here. Skip in CLI mode.
    if (!process.env.CLI_MODE) {
      const { ensureHostIndexes } = await import('./host-indexes');
      await ensureHostIndexes(pool);
    }
  } catch (error) {
    logger.error('Failed to initialize database pool', { error: error instanceof Error ? error : String(error) });
    throw error;
  }
}

/**
 * Promise that resolves when the initial pool connection succeeds and
 * `ensureHostIndexes` has run. Rejects if all retries in `connectWithRetry`
 * are exhausted. Importers that need a live DB before doing further work
 * (e.g. `server.ts` before starting pg-boss) must `await` this.
 */
export const poolInitialized: Promise<void> = initializePool();
