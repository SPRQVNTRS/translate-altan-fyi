/**
 * Enrich Headword Workflow Template
 *
 * One stage, one operation: ask the active model for study notes on the first
 * few senses of a headword and cache what comes back.
 */

import type { WorkflowTemplateWithHandlers } from '#app/workflows/types';
import { WORKFLOW_TYPES } from '#app/workflows/types';
import { operationHandlers } from '#app/workflows/operations';
import { ENRICHMENT_QUEUE } from '#app/lib/enrichment/limits';

/**
 * Comfortably above `ENRICHMENT_TIMEOUT_MS` (120s), because the operation may
 * spend that budget TWICE: it retries once itself. This ceiling exists to catch
 * a hung process, not to cut a slow model off, so it must never be the thing
 * that fires first.
 */
const OPERATION_TIMEOUT_MS = 150_000;

export const enrichHeadwordTemplate: WorkflowTemplateWithHandlers = {
  type: WORKFLOW_TYPES.ENRICH_HEADWORD,
  // NOT the shared `default` queue. The singleton key this feature relies on is
  // only enforced when the queue carries a deduping policy, and enrichment owns
  // that policy alone. See ENRICHMENT_QUEUE and initializeWorkflows.
  queue: ENRICHMENT_QUEUE,
  version: '1.0.0',
  description: 'Write and cache study notes for the senses of one headword',
  estimatedDurationSeconds: 60,
  stages: [
    {
      name: 'enrichment',
      description: 'Call the active model and record one row per sense',
      operations: [
        {
          type: 'enrichment.enrich-headword',
          handler: operationHandlers.enrichment.enrichHeadword,
          timeout: OPERATION_TIMEOUT_MS,
          // ONE ATTEMPT, ON PURPOSE. The operation owns its own single retry, so
          // a pg-boss retry would be a THIRD call to a paid provider for the
          // same headword, under a different workflow id, after failures have
          // already been recorded.
          maxAttempts: 1,
          critical: true,
        },
      ],
    },
  ],
};
