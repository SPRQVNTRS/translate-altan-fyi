/**
 * Generate Report Operation Handler
 *
 * Generates a summary report from previous operation results.
 */

import type { OperationHandler } from '@sprqvntrs/workflows';
import { z } from 'zod';
import { createComponentLogger } from '#app/lib/logger';

const log = createComponentLogger('DummyWorkflow');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The accumulated results of the earlier operations in this workflow. */
const previousResultsSchema = z
  .object({
    startedAt: z.string().optional(),
    inputMessage: z.string().optional(),
    triggeredBy: z.string().optional(),
    processedAt: z.string().optional(),
    processingTimeMs: z.number().optional(),
    itemsProcessed: z.number().optional(),
  })
  .catch({});

export const generateReportHandler: OperationHandler = async (ctx) => {
  log.info('Generating report', {
    workflowId: ctx.workflowId,
    previousResults: ctx.previousResults,
  });

  await sleep(300);

  const prev = previousResultsSchema.parse(ctx.previousResults);

  return {
    status: 'completed',
    data: {
      report: {
        summary: `Workflow completed successfully`,
        startedAt: prev.startedAt,
        completedAt: new Date().toISOString(),
        inputMessage: prev.inputMessage,
        triggeredBy: prev.triggeredBy,
        processingDetails: {
          processedAt: prev.processedAt,
          durationMs: prev.processingTimeMs,
          itemsProcessed: prev.itemsProcessed,
        },
      },
      completedAt: new Date().toISOString(),
    },
  };
};
