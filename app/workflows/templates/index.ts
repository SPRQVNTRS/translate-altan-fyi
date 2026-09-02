/**
 * Workflow Template Registry
 *
 * Centralizes all workflow templates for registration.
 */

import type { WorkflowTemplateWithHandlers } from '#app/workflows/types';
import { dummyWorkflowTemplate } from './dummy-workflow';

/**
 * All workflow templates with their handler references.
 */
export const workflowTemplates: WorkflowTemplateWithHandlers[] = [
  dummyWorkflowTemplate,
];

// Re-export individual templates for direct access
export { dummyWorkflowTemplate } from './dummy-workflow';
