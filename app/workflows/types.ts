/**
 * Workflow Types & Constants
 *
 * Centralized type definitions for workflow templates with handler references.
 */

import type { OperationHandler, WorkflowTemplate as BaseWorkflowTemplate } from '@sprqvntrs/workflows';
import { z } from 'zod';

import { enrichmentJobPayloadSchema } from '#app/lib/enrichment/job-payload';
import { translationJobPayloadSchema } from '#app/lib/translation/job-payload';

// =============================================================================
// WORKFLOW TYPES
// =============================================================================

export const WORKFLOW_TYPES = {
  DUMMY: 'dummy-workflow',
  ENRICH_HEADWORD: 'enrich-headword',
  TRANSLATE_HEADWORD: 'translate-headword',
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

/**
 * The enrichment job's context, which is the enqueue payload unchanged.
 *
 * The same object on both sides ON PURPOSE: the contract a loader enqueues
 * against and the document a handler decodes are one shape, so they cannot
 * drift. The rules that shape enforces, and why it is a `strictObject`, are
 * written out in `#app/lib/enrichment/job-payload`.
 */
export const enrichHeadwordContextSchema = enrichmentJobPayloadSchema;

export type EnrichHeadwordContext = z.infer<typeof enrichHeadwordContextSchema>;

/**
 * The translation job's context, which is the enqueue payload unchanged.
 *
 * The same object on both sides ON PURPOSE, for the reason above: the contract a
 * loader enqueues against and the document a handler decodes are one shape, so
 * they cannot drift. The rules that shape enforces, and why it is a
 * `strictObject` carrying no account id, are written out in
 * `#app/lib/translation/job-payload`.
 */
export const translateHeadwordContextSchema = translationJobPayloadSchema;

export type TranslateHeadwordContext = z.infer<typeof translateHeadwordContextSchema>;
