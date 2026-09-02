/**
 * Workflows Public API
 *
 * Main entry point for workflow templates and operation handlers.
 *
 * Usage:
 * ```typescript
 * import { registerAllWorkflows } from '#app/workflows';
 *
 * // Register everything at once - extracts handlers from templates
 * registerAllWorkflows(orchestrator);
 * ```
 *
 * Templates include handler references for easy navigation:
 * ```typescript
 * import { dummyWorkflowTemplate } from '#app/workflows';
 *
 * // Click through to see the handler implementation
 * dummyWorkflowTemplate.stages[0].operations[0].handler
 * ```
 */

import type { WorkflowOrchestrator, WorkflowTemplate, OperationHandler } from '@sprqvntrs/workflows';
import type { WorkflowTemplateWithHandlers } from './types';

// Re-export templates
export { workflowTemplates, dummyWorkflowTemplate } from './templates';

// Re-export structured operation handlers for use in templates
export { operationHandlers } from './operations';

// Re-export types and constants
export { WORKFLOW_TYPES } from './types';
export type {
  WorkflowTemplateWithHandlers,
  OperationWithHandler,
  StageWithHandlers,
  WorkflowType,
  DummyWorkflowContext,
} from './types';

// Import for helper functions
import { workflowTemplates } from './templates';

/**
 * Extract the base WorkflowTemplate (without handlers) for orchestrator registration.
 */
function extractBaseTemplate(template: WorkflowTemplateWithHandlers): WorkflowTemplate {
  return {
    ...template,
    stages: template.stages.map((stage) => ({
      ...stage,
      operations: stage.operations.map(({ handler: _, ...op }) => op),
    })),
  };
}

/**
 * Extract all operation handlers from templates as a flat registry.
 */
function extractOperationHandlers(templates: WorkflowTemplateWithHandlers[]) {
  const handlers = new Map<string, OperationHandler>();

  for (const template of templates) {
    for (const stage of template.stages) {
      for (const operation of stage.operations) {
        handlers.set(operation.type, operation.handler);
      }
    }
  }

  return Object.fromEntries(handlers);
}

/**
 * Register all workflow templates and operation handlers with the orchestrator.
 *
 * This extracts handlers from the template definitions and registers them,
 * so you only need to maintain templates - handlers are derived automatically.
 */
export function registerAllWorkflows(orchestrator: WorkflowOrchestrator): void {
  const baseTemplates = workflowTemplates.map(extractBaseTemplate);
  const handlers = extractOperationHandlers(workflowTemplates);

  orchestrator.registerTemplates(baseTemplates);
  orchestrator.registerOperations(handlers);
}
