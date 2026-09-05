/**
 * Translate Headword Workflow Template
 *
 * One stage, one operation: ask the active model for the senses of one headword
 * and their translations into one target language, and write what comes back
 * into the shared dictionary as permanent, attributed rows.
 */

import type { WorkflowTemplateWithHandlers } from '#app/workflows/types';
import { WORKFLOW_TYPES } from '#app/workflows/types';
import { operationHandlers } from '#app/workflows/operations';
import { TRANSLATION_QUEUE } from '#app/lib/translation/limits';

/**
 * Comfortably above `TRANSLATION_TIMEOUT_MS` (90s), with room for the database
 * work on either side of the call. This ceiling exists to catch a hung process,
 * not to cut a slow model off, so it must never be the thing that fires first.
 */
const OPERATION_TIMEOUT_MS = 120_000;

export const translateHeadwordTemplate: WorkflowTemplateWithHandlers = {
  type: WORKFLOW_TYPES.TRANSLATE_HEADWORD,
  // NOT the shared `default` queue, and not the enrichment one either. The
  // singleton key this feature relies on is only enforced when the queue carries
  // a deduping policy, and a queue is also a worker pool: sharing enrichment's
  // would put a reader's translation behind a slow set of study notes. See
  // TRANSLATION_QUEUE and initializeWorkflows.
  queue: TRANSLATION_QUEUE,
  version: '1.0.0',
  description: 'Generate the senses and translations of one headword, and write them into the dictionary',
  estimatedDurationSeconds: 45,
  stages: [
    {
      name: 'translation',
      description: 'Call the active model and write the corpus rows in one transaction',
      operations: [
        {
          type: 'translation.translate-headword',
          handler: operationHandlers.translation.translateHeadword,
          timeout: OPERATION_TIMEOUT_MS,
          // ONE ATTEMPT, ON PURPOSE. The operation writes a terminal run row on
          // every exit path, so a pg-boss retry would be a SECOND call to a paid
          // provider for a headword whose run has already been reported as
          // finished, under a different workflow id. A reader who wants another
          // attempt presses the retry button, which is a new run row and a new
          // decision.
          maxAttempts: 1,
          critical: true,
        },
      ],
    },
  ],
};
