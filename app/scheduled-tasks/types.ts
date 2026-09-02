/**
 * Scheduled Tasks Types
 *
 * Type definitions for recurring scheduled tasks.
 */

import type { JsonObject } from '#app/lib/json';

/** The JSON payload a scheduled task is enqueued with. */
export type ScheduledTaskPayload = JsonObject;

/**
 * Result returned by scheduled task handlers.
 */
export interface ScheduledTaskResult<T = unknown> {
  status: 'completed' | 'failed';
  message?: string;
  data?: T;
}

/**
 * Scheduled task handler function signature.
 */
export type ScheduledTaskHandler<TData = ScheduledTaskPayload, TResult = unknown> = (
  data: TData
) => Promise<ScheduledTaskResult<TResult>>;

/**
 * Scheduled task definition.
 */
export interface ScheduledTaskDefinition<TData = ScheduledTaskPayload> {
  /**
   * Unique name for the scheduled task (used as queue name and schedule name).
   */
  name: string;

  /**
   * Cron expression for scheduling.
   * @see https://crontab.guru/ for help with cron expressions
   */
  cron: string;

  /**
   * Human-readable description of what this task does.
   */
  description: string;

  /**
   * The handler function to execute.
   */
  handler: ScheduledTaskHandler<TData>;

  /**
   * Whether this task is enabled.
   * Set to false to disable without removing the task.
   * @default true
   */
  enabled?: boolean;

  /**
   * Timezone for cron expression.
   * @default 'UTC'
   */
  timezone?: string;

  /**
   * Optional data to pass to the handler on each execution.
   */
  data?: TData;
}

/**
 * Configuration for the scheduled tasks system.
 */
export interface ScheduledTasksConfig {
  /**
   * Whether to enable debug logging.
   */
  debug?: boolean;
}
