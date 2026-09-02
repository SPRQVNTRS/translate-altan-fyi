/**
 * Workflow Types & Constants
 *
 * Centralized type definitions for workflow templates with handler references.
 */

import type { OperationHandler, WorkflowTemplate as BaseWorkflowTemplate } from '@sprqvntrs/workflows';
import { z } from 'zod';

// =============================================================================
// WORKFLOW TYPES
// =============================================================================

export const WORKFLOW_TYPES = {
  DUMMY: 'dummy-workflow',
} as const;

export type WorkflowType = (typeof WORKFLOW_TYPES)[keyof typeof WORKFLOW_TYPES];

// =============================================================================
// EXTENDED TEMPLATE TYPES
// =============================================================================

/**
 * Operation definition with handler reference.
 * The handler is co-located with the operation config for easy navigation.
 */
export interface OperationWithHandler {
  type: string;
  handler: OperationHandler;
  timeout?: number;
  maxAttempts?: number;
  critical?: boolean;
}

/**
 * Stage definition with operations that include handlers.
 */
export interface StageWithHandlers {
  name: string;
  description?: string;
  operations: OperationWithHandler[];
}

/**
 * Extended workflow template that includes handler references.
 * This is the format used in template definitions.
 */
export interface WorkflowTemplateWithHandlers extends Omit<BaseWorkflowTemplate, 'stages'> {
  stages: StageWithHandlers[];
}

// =============================================================================
// CONTEXT TYPES
// =============================================================================

/**
 * A workflow's `initialContext` arrives as a JSONB document. Handlers decode it
 * with these schemas rather than asserting a shape onto it.
 */
export const dummyWorkflowContextSchema = z.object({
  message: z.string().optional(),
  userId: z.string().optional(),
});

export type DummyWorkflowContext = z.infer<typeof dummyWorkflowContextSchema>;
