/**
 * Workflow Service
 *
 * Manages the workflow orchestrator lifecycle.
 * Templates and operation handlers are defined in app/workflows/.
 */

import { createWorkflowOrchestrator, type WorkflowOrchestrator } from '@sprqvntrs/workflows';
import { db } from '#drizzle/db';
import { CONFIG } from '#config';
import { createComponentLogger } from '#app/lib/logger';
import { registerAllWorkflows } from '#app/workflows';

const log = createComponentLogger('WorkflowService');

// Use globalThis to survive Vite HMR reloads in development
declare global {
  // eslint-disable-next-line no-var
  var __workflowOrchestrator: WorkflowOrchestrator | undefined;
}

// Singleton orchestrator instance (survives HMR)
function getOrchestratorInstance(): WorkflowOrchestrator | null {
  return globalThis.__workflowOrchestrator ?? null;
}

function setOrchestratorInstance(orch: WorkflowOrchestrator): void {
  globalThis.__workflowOrchestrator = orch;
}

/**
 * Initialize the workflow orchestrator.
 * This should be called once during application startup.
 */
export async function initializeWorkflows(): Promise<WorkflowOrchestrator> {
  const existing = getOrchestratorInstance();
  if (existing) {
    return existing;
  }

  log.info('Initializing workflow orchestrator');

  const orchestrator = await createWorkflowOrchestrator({
    connectionString: CONFIG.database.url,
    // SAFETY: `db` is the application's Drizzle instance, which is what the
    // orchestrator needs. Its `db` option is typed against the drizzle-orm
    // version bundled with @sprqvntrs/workflows; that is a separate copy of
    // the same declarations, so the two nominally-identical types are not
    // structurally comparable across package boundaries.
    db: db as Parameters<typeof createWorkflowOrchestrator>[0]['db'],
    queues: [
      { name: 'default', workers: 2, pollingIntervalMs: 2000 },
      { name: 'sequential', workers: 1 }, // For workflows that must run one at a time
    ],
    defaultTimeout: 30000,
    defaultRetryLimit: 3,
    defaultRetryDelay: 5,
    debug: CONFIG.app.isDevelopment,
  });

  // Register all templates and operation handlers from app/workflows/
  registerAllWorkflows(orchestrator);

  // Validate configuration
  orchestrator.validate();

  // Store in global to survive HMR
  setOrchestratorInstance(orchestrator);

  log.info('Workflow orchestrator initialized successfully');

  return orchestrator;
}

/**
 * Get the workflow orchestrator instance.
 * Throws if not initialized.
 */
export function getOrchestrator(): WorkflowOrchestrator {
  const orchestrator = getOrchestratorInstance();
  if (!orchestrator) {
    throw new Error('Workflow orchestrator not initialized. Call initializeWorkflows() first.');
  }
  return orchestrator;
}

/**
 * Start the workflow worker to process jobs.
 * Call this after initialization to begin processing.
 */
export async function startWorkflowWorker(): Promise<void> {
  const orch = getOrchestrator();
  log.info('Starting workflow worker');
  await orch.startWorker();
  log.info('Workflow worker started');
}

/**
 * Stop the workflow worker gracefully.
 */
export async function stopWorkflowWorker(): Promise<void> {
  const orchestrator = getOrchestratorInstance();
  if (orchestrator) {
    log.info('Stopping workflow worker');
    await orchestrator.stopWorker();
    log.info('Workflow worker stopped');
  }
}

/**
 * Stop the orchestrator's pg-boss instance.
 * Use this in server.ts where the worker is not started but the
 * orchestrator still holds an internal DB connection via pg-boss.
 */
export async function stopOrchestrator(): Promise<void> {
  const orchestrator = getOrchestratorInstance();
  if (orchestrator) {
    log.info('Stopping orchestrator');
    await orchestrator.getBoss().stop({ graceful: true });
    globalThis.__workflowOrchestrator = undefined;
    log.info('Orchestrator stopped');
  }
}
