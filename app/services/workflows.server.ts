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
import { ENRICHMENT_QUEUE } from '#app/lib/enrichment/limits';
import { TRANSLATION_QUEUE } from '#app/lib/translation/limits';

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
      { name: ENRICHMENT_QUEUE, workers: 2, pollingIntervalMs: 2000 },
      // Its own pool, not enrichment's: a reader is waiting on a translation, and
      // sharing a pool would put that wait behind a set of study notes nobody
      // asked for yet. The polling interval is shorter for the same reason.
      { name: TRANSLATION_QUEUE, workers: 2, pollingIntervalMs: 1000 },
    ],
    defaultTimeout: 30000,
    defaultRetryLimit: 3,
    defaultRetryDelay: 5,
    debug: CONFIG.app.isDevelopment,
  });

  /**
   * Give the enrichment queue a deduping policy. THIS IS THE ONLY PLACE THAT CAN.
   *
   * In pg-boss 10.4.2 the `singletonKey` passed to `orchestrator.start()` is
   * INERT unless the queue it lands on carries a deduping policy. Every unique
   * index over `singleton_key` is policy-gated (job_i1 needs `short`, job_i2
   * needs `singleton`, job_i3 needs `stately`), so under the default `standard`
   * policy the key is stored on the row and enforces nothing: ten concurrent
   * enqueues make ten jobs, and ten runs can each read an empty cache and pay a
   * provider.
   *
   * `stately` rather than `short` on purpose. `short` only dedupes jobs still in
   * `created`, so the moment one job goes active a second enqueue queues a
   * second job and both can pay. `stately` is unique per (queue, state, key) for
   * every state up to `active`, so there can never be two ACTIVE runs for one
   * key. A single follow-up job may sit in `created` behind a running one, which
   * is correct: it runs afterwards, finds the cache full, and costs nothing.
   *
   * BOTH CALLS ARE REQUIRED, and this is exactly the trap that produced the bug.
   * `createQueue` is ON CONFLICT DO NOTHING, so it cannot repair a queue that
   * already exists with the wrong policy. `updateQueue` cannot create one. Only
   * the pair is correct on a fresh database AND on an already-deployed one.
   * @sprqvntrs/workflows 0.2.5 calls `boss.createQueue(name)` with no options,
   * so neither the library nor a restart can ever set a policy by itself.
   */
  const boss = orchestrator.getBoss();
  await boss.createQueue(ENRICHMENT_QUEUE, { name: ENRICHMENT_QUEUE, policy: 'stately' });
  await boss.updateQueue(ENRICHMENT_QUEUE, { name: ENRICHMENT_QUEUE, policy: 'stately' });

  // The translation queue needs the same treatment for the same reason, and it
  // needs its OWN queue so that the policy is not shared with a feature that may
  // one day want different dedupe semantics. Both calls again: `createQueue` is
  // ON CONFLICT DO NOTHING and cannot repair an existing queue, `updateQueue`
  // cannot create one, and only the pair is correct on a fresh database AND on
  // an already-deployed one.
  await boss.createQueue(TRANSLATION_QUEUE, { name: TRANSLATION_QUEUE, policy: 'stately' });
  await boss.updateQueue(TRANSLATION_QUEUE, { name: TRANSLATION_QUEUE, policy: 'stately' });

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
