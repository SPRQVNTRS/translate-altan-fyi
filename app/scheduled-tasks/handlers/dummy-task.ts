/**
 * Dummy Scheduled Task Handler
 *
 * Example scheduled task that logs a message.
 * Use this as a template for creating new scheduled tasks.
 */

import type {
  ScheduledTaskHandler,
  ScheduledTaskPayload,
  ScheduledTaskResult,
} from '../types';
import { createComponentLogger } from '#app/lib/logger';

const log = createComponentLogger('DummyScheduledTask');

export interface DummyTaskResult {
  executedAt: string;
  message: string;
}

/**
 * Dummy task handler that logs execution.
 *
 * This is an example handler - use it as a template for real scheduled tasks.
 */
export const dummyTaskHandler: ScheduledTaskHandler<ScheduledTaskPayload, DummyTaskResult> =
  async (): Promise<ScheduledTaskResult<DummyTaskResult>> => {
    const executedAt = new Date().toISOString();

    log.info('Dummy scheduled task executed', { executedAt });

    // Simulate some work
    await new Promise((resolve) => setTimeout(resolve, 100));

    console.log(`[DummyScheduledTask] Hello from scheduled task! Executed at: ${executedAt}`);

    return {
      status: 'completed',
      message: 'Dummy task executed successfully',
      data: {
        executedAt,
        message: 'This is a dummy scheduled task for testing',
      },
    };
  };
