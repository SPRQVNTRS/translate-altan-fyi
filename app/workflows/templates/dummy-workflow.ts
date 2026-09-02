/**
 * Dummy Workflow Template
 *
 * A demonstration workflow that processes dummy data through 3 stages:
 * 1. Initialization - Log start and validate input
 * 2. Processing - Simulate data processing with random delays
 * 3. Finalization - Generate a summary report
 */

import type { WorkflowTemplateWithHandlers } from '#app/workflows/types';
import { WORKFLOW_TYPES } from '#app/workflows/types';
import { operationHandlers } from '#app/workflows/operations';

export const dummyWorkflowTemplate: WorkflowTemplateWithHandlers = {
  type: WORKFLOW_TYPES.DUMMY,
  queue: 'default',
  version: '1.0.0',
  description: 'A demonstration workflow that processes dummy data',
  estimatedDurationSeconds: 10,
  stages: [
    {
      name: 'initialization',
      description: 'Initialize the workflow and log start',
      operations: [
        {
          type: 'dummy.log-start',
          handler: operationHandlers.dummy.logStart,
          timeout: 5000,
          maxAttempts: 1,
          critical: true,
        },
      ],
    },
    {
      name: 'processing',
      description: 'Process the input data',
      operations: [
        {
          type: 'dummy.process-data',
          handler: operationHandlers.dummy.processData,
          timeout: 10000,
          maxAttempts: 3,
          critical: true,
        },
      ],
    },
    {
      name: 'finalization',
      description: 'Generate final report',
      operations: [
        {
          type: 'dummy.generate-report',
          handler: operationHandlers.dummy.generateReport,
          timeout: 5000,
          maxAttempts: 2,
          critical: true,
        },
      ],
    },
  ],
};
