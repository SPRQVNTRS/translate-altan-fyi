/**
 * Translate Phrase Workflow Template
 *
 * One stage, one operation: ask the active model to translate one piece of
 * running text into one language, and write the answer onto the row that asked
 * for it. Nothing it produces reaches the dictionary.
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

export const translatePhraseTemplate: WorkflowTemplateWithHandlers = {
  type: WORKFLOW_TYPES.TRANSLATE_PHRASE,
  // The SAME queue as the word job, and not the shared `default` one. The
  // `stately` policy that makes a singleton key bite at all is set on this queue
  // in `initializeWorkflows`, and a second queue would need the same policy set
  // the same way while splitting one worker pool between two jobs of the same
  // size answering the same waiting reader. The keys are namespaced instead; see
  // `phraseSingletonKey`.
  queue: TRANSLATION_QUEUE,
  version: '1.0.0',
  description: 'Translate one piece of running text into one language',
  estimatedDurationSeconds: 20,
  stages: [
    {
      name: 'phrase',
      description: 'Call the active model and write the answer onto its own row',
      operations: [
        {
          type: 'translation.translate-phrase',
          handler: operationHandlers.translation.translatePhrase,
          timeout: OPERATION_TIMEOUT_MS,
          // ONE ATTEMPT, ON PURPOSE. The operation writes a terminal row on
          // every exit path, so a pg-boss retry would be a SECOND call to a paid
          // provider for a run that has already been reported as finished. A
          // reader who wants another attempt presses the retry button, which is
          // a new row and a new decision.
          maxAttempts: 1,
          critical: true,
        },
      ],
    },
  ],
};
