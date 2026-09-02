/**
 * Log Start Operation Handler
 *
 * Initializes the workflow and logs the start event.
 */

import type { OperationHandler } from '@sprqvntrs/workflows';
import { createComponentLogger } from '#app/lib/logger';
import { dummyWorkflowContextSchema } from '#app/workflows/types';

const log = createComponentLogger('DummyWorkflow');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const logStartHandler: OperationHandler = async (ctx) => {
  log.info('Dummy workflow started', {
    workflowId: ctx.workflowId,
    operationId: ctx.operationId,
    input: ctx.initialContext,
  });

  // Simulate some initialization work
  await sleep(500);

  const inputData = dummyWorkflowContextSchema.catch({}).parse(ctx.initialContext);

  return {
    status: 'completed',
    data: {
      startedAt: new Date().toISOString(),
      inputMessage: inputData.message || 'No message provided',
      triggeredBy: inputData.userId || 'unknown',
    },
  };
};
