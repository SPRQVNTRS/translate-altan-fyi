/**
 * Scheduled Tasks Definitions
 *
 * Define all scheduled tasks here. Each task specifies:
 * - name: Unique identifier (used as queue name)
 * - cron: When to run (cron expression)
 * - handler: What to execute
 * - enabled: Whether the task is active
 *
 * To add a new scheduled task:
 * 1. Create a handler in ./handlers/
 * 2. Export it from ./handlers/index.ts
 * 3. Add a task definition below
 */

import type { ScheduledTaskDefinition } from './types';
import { dummyTaskHandler } from './handlers';

/**
 * All scheduled task definitions.
 *
 * Set `enabled: true` to activate a task.
 * Tasks with `enabled: false` will not be scheduled.
 */
export const scheduledTasks: ScheduledTaskDefinition[] = [
  // =============================================================================
  // EXAMPLE TASKS (disabled by default)
  // =============================================================================

  {
    name: 'dummy-scheduled-task',
    cron: '*/5 * * * *', // Every 5 minutes
    description: 'Example scheduled task that logs a message',
    handler: dummyTaskHandler,
    enabled: false, // Set to true to enable
    timezone: 'UTC',
  },

  // =============================================================================
  // ADD YOUR SCHEDULED TASKS BELOW
  // =============================================================================

  // Example: Daily cleanup task
  // {
  //   name: 'daily-cleanup',
  //   cron: '0 4 * * *', // Daily at 4 AM UTC
  //   description: 'Clean up old records and temporary data',
  //   handler: cleanupHandler,
  //   enabled: true,
  //   timezone: 'UTC',
  // },

  // Example: Hourly sync task
  // {
  //   name: 'hourly-sync',
  //   cron: '0 * * * *', // Every hour
  //   description: 'Sync data with external service',
  //   handler: syncHandler,
  //   enabled: true,
  //   timezone: 'UTC',
  // },
];
