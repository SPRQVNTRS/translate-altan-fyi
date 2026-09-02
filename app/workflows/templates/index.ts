/**
 * Workflow Template Registry
 *
 * Centralizes all workflow templates for registration.
 */

import type { WorkflowTemplateWithHandlers } from '#app/workflows/types';
import { dummyWorkflowTemplate } from './dummy-workflow';
import { enrichHeadwordTemplate } from './enrich-headword';

/**
 * All workflow templates with their handler references.
 */
export const workflowTemplates: WorkflowTemplateWithHandlers[] = [
  dummyWorkflowTemplate,
  enrichHeadwordTemplate,
];

// Re-export individual templates for direct access
export { dummyWorkflowTemplate } from './dummy-workflow';
export { enrichHeadwordTemplate } from './enrich-headword';
