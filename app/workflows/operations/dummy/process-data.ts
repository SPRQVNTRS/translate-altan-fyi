/**
 * Process Data Operation Handler
 *
 * Simulates data processing with random delays and occasional failures.
 */

import type { OperationHandler } from '@sprqvntrs/workflows';
import { createComponentLogger } from '#app/lib/logger';

const log = createComponentLogger('DummyWorkflow');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const processDataHandler: OperationHandler = async (ctx) => {
  log.info('Processing data', {
    workflowId: ctx.workflowId,
    attempt: ctx.attempt,
    maxAttempts: ctx.maxAttempts,
  });

  // Simulate processing work (1-3 seconds)
  const processingTime = 1000 + Math.random() * 2000;
  await sleep(processingTime);

  // Simulate occasional failures for retry demonstration (10% chance)
  if (Math.random() < 0.1 && ctx.attempt < ctx.maxAttempts) {
    log.warn('Simulated processing failure', {
      workflowId: ctx.workflowId,
      attempt: ctx.attempt,
    });
    return {
      status: 'failed',
      reason: 'Simulated transient failure - will retry',
    };
  }

  const processedItems = Math.floor(Math.random() * 100) + 1;

  return {
    status: 'completed',
    data: {
      processedAt: new Date().toISOString(),
      processingTimeMs: Math.round(processingTime),
      itemsProcessed: processedItems,
      status: 'success',
    },
  };
};
