/**
 * Operation Handlers
 *
 * Structured export of all operation handlers for use in workflow templates.
 * This structure enables easy navigation from template to handler.
 *
 * Usage in templates:
 * ```typescript
 * import { operationHandlers } from '../operations';
 *
 * operations: [
 *   {
 *     type: 'dummy.log-start',
 *     handler: operationHandlers.dummy.logStart,
 *   },
 * ]
 * ```
 */

import { logStartHandler, processDataHandler, generateReportHandler } from './dummy';
import { enrichHeadwordHandler } from './enrichment';
import { translateHeadwordHandler, translatePhraseHandler } from './translation';

/**
 * Structured operation handlers organized by domain.
 * Mirrors the stage/operation hierarchy for easy discovery.
 */
export const operationHandlers = {
  dummy: {
    logStart: logStartHandler,
    processData: processDataHandler,
    generateReport: generateReportHandler,
  },
  enrichment: {
    enrichHeadword: enrichHeadwordHandler,
  },
  translation: {
    translateHeadword: translateHeadwordHandler,
    translatePhrase: translatePhraseHandler,
  },
} as const;

// Re-export individual handlers for direct access if needed
export { logStartHandler, processDataHandler, generateReportHandler } from './dummy';
export { enrichHeadwordHandler } from './enrichment';
export { translateHeadwordHandler, translatePhraseHandler } from './translation';
