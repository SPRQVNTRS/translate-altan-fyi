/**
 * Scheduled Tasks
 *
 * Manages recurring scheduled tasks using pg-boss cron scheduling.
 *
 * Usage:
 * ```typescript
 * import { registerScheduledTasks } from '#app/scheduled-tasks';
 *
 * // In worker.ts, after initializing workflows
 * const orchestrator = await initializeWorkflows();
 * await registerScheduledTasks(orchestrator.getBoss());
 * ```
 *
 * To add a new scheduled task:
 * 1. Create a handler in ./handlers/
 * 2. Export it from ./handlers/index.ts
 * 3. Add a task definition in ./tasks.ts
 */

import type { PgBoss } from '@sprqvntrs/workflows';
import { createComponentLogger } from '#app/lib/logger';
import { scheduledTasks } from './tasks';
import type {
  ScheduledTaskDefinition,
  ScheduledTaskPayload,
  ScheduledTasksConfig,
} from './types';

// Type for pg-boss job in work callback
interface ScheduledJob {
  id: string;
  data: ScheduledTaskPayload;
}

const log = createComponentLogger('ScheduledTasks');

/**
 * Registers all enabled scheduled tasks with pg-boss.
 *
 * This function:
 * 1. Creates queues for each enabled task
 * 2. Registers workers to handle task execution
 * 3. Schedules tasks using cron expressions
 *
 * @param boss - pg-boss instance from orchestrator.getBoss()
 * @param config - Optional configuration
 */
export async function registerScheduledTasks(
  boss: PgBoss,
  config?: ScheduledTasksConfig
): Promise<void> {
  const { debug = false } = config ?? {};
  const enabledTasks = scheduledTasks.filter((task) => task.enabled !== false);

  if (enabledTasks.length === 0) {
    log.info('No scheduled tasks enabled');
    return;
  }

  log.info('Registering scheduled tasks', { count: enabledTasks.length });

  for (const task of enabledTasks) {
    await registerTask(boss, task, debug);
  }

  log.info('Scheduled tasks registered', {
    tasks: enabledTasks.map((t) => t.name),
  });
}

/**
 * Registers a single scheduled task.
 */
async function registerTask(
  boss: PgBoss,
  task: ScheduledTaskDefinition,
  debug: boolean
): Promise<void> {
  const { name, cron, description, handler, timezone = 'UTC' } = task;

  try {
    // Create queue for this task
    await boss.createQueue(name);

    if (debug) {
      log.debug('Created queue for scheduled task', { name });
    }

    // Register worker to handle task execution
    await boss.work(
      name,
      { batchSize: 1 },
      async (jobs: ScheduledJob[]) => {
        const job = jobs[0];
        if (!job) return;

        log.info('Executing scheduled task', { name, jobId: job.id });

        try {
          const result = await handler(job.data ?? {});

          if (result.status === 'completed') {
            log.info('Scheduled task completed', {
              name,
              jobId: job.id,
              message: result.message,
            });
          } else {
            log.warn('Scheduled task failed', {
              name,
              jobId: job.id,
              message: result.message,
            });
          }
        } catch (error) {
          log.error('Scheduled task error', {
            name,
            jobId: job.id,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error; // Re-throw to trigger pg-boss retry
        }
      }
    );

    if (debug) {
      log.debug('Registered worker for scheduled task', { name });
    }

    // Schedule the recurring task
    // Unschedule first to ensure latest config is used
    await boss.unschedule(name);
    await boss.schedule(name, cron, task.data ?? {}, { tz: timezone });

    log.info('Scheduled task registered', {
      name,
      cron,
      description,
      timezone,
    });
  } catch (error) {
    log.error('Failed to register scheduled task', {
      name,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Unregisters all scheduled tasks.
 *
 * Call this during shutdown if you need to clean up schedules.
 */
export async function unregisterScheduledTasks(boss: PgBoss): Promise<void> {
  const enabledTasks = scheduledTasks.filter((task) => task.enabled !== false);

  for (const task of enabledTasks) {
    try {
      await boss.unschedule(task.name);
      log.info('Unscheduled task', { name: task.name });
    } catch (error) {
      log.warn('Failed to unschedule task', {
        name: task.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// Re-export types
export type {
  ScheduledTaskDefinition,
  ScheduledTaskHandler,
  ScheduledTaskResult,
  ScheduledTasksConfig,
} from './types';

// Re-export task definitions for inspection
export { scheduledTasks } from './tasks';
