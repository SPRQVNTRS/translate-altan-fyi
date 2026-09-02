/**
 * Background Worker Process
 *
 * This is a standalone process that processes workflow jobs and scheduled tasks.
 * Run this alongside your main application server:
 *
 *   pnpm run worker
 *
 * The worker will:
 * - Connect to PostgreSQL using pg-boss
 * - Listen for jobs on workflow queues
 * - Execute workflows through the orchestrator
 * - Run scheduled tasks on cron schedules
 * - Handle graceful shutdown
 */

import 'dotenv/config';
import { createWorkerLogger } from '@sprqvntrs/logger/server';
import {
  initializeWorkflows,
  getOrchestrator,
  startWorkflowWorker,
  stopWorkflowWorker,
} from '#app/services/workflows.server';
import { registerScheduledTasks } from '#app/scheduled-tasks';
import { closePool } from '#drizzle/db';
import { reportError } from '#app/lib/report-error';

const { logger } = createWorkerLogger({
  serviceName: 'translate-altan-fyi-worker',
});

// Track if we're shutting down
let isShuttingDown = false;

async function main() {
  logger.info('Starting workflow worker');

  // Initialize the orchestrator (registers templates and handlers)
  await initializeWorkflows();

  // Register scheduled tasks with pg-boss
  const orchestrator = getOrchestrator();
  await registerScheduledTasks(orchestrator.getBoss());

  // Start processing jobs
  await startWorkflowWorker();

  logger.info('Workflow worker is running and listening for jobs');
}

// Graceful shutdown handler
// Timeline: SIGTERM → app cleanup (0-8s) → force exit (8s) → Docker SIGKILL (10s)
const FORCE_EXIT_TIMEOUT_MS = 8_000;

async function shutdown(signal: string) {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress');
    return;
  }

  isShuttingDown = true;
  logger.info('Shutting down gracefully', { signal });

  // Force exit safety net — fires before Docker's SIGKILL
  const forceExitTimer = setTimeout(() => {
    logger.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, FORCE_EXIT_TIMEOUT_MS);
  forceExitTimer.unref();

  try {
    // Stop accepting new jobs and wait for current jobs to complete
    await stopWorkflowWorker();

    // Close database pool (also clears stats interval)
    await closePool();

    logger.info('Shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown', { error: err instanceof Error ? err : new Error(String(err)) });
    reportError(err, { source: 'worker-shutdown' });
    process.exit(1);
  }
}

// Register shutdown handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.fatal('Uncaught exception', { error });
  reportError(error, { source: 'worker-uncaught' });
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.fatal('Unhandled rejection', { reason, promise: String(promise) });
  reportError(reason, { source: 'worker-unhandled-rejection' });
  shutdown('unhandledRejection');
});

// Start the worker
main().catch((error) => {
  logger.fatal('Failed to start worker', { error });
  reportError(error, { source: 'worker-startup' });
  process.exit(1);
});
