/**
 * Workflow Formatters
 */

import type { TableColumn } from '../types';
import type { OperationRow, WorkflowRow } from '../schemas';
import { hasJsonPayload } from '../schemas';
import { c, colorStatus, printField, printSection, formatDate, truncate } from '../output';

export type { OperationRow, WorkflowRow };

export const workflowColumns: TableColumn<WorkflowRow>[] = [
  { header: 'ID', key: (w) => w.id.slice(0, 8), width: 10 },
  { header: 'Type', key: 'type', width: 25 },
  { header: 'Status', key: (w) => colorStatus(w.status), width: 12 },
  { header: 'Stage', key: (w) => w.currentStage || c.dim('-'), width: 15 },
  { header: 'Version', key: 'templateVersion', width: 10 },
  { header: 'Created', key: (w) => formatDate(w.createdAt), width: 20 },
];

export function printWorkflowDetail(workflow: WorkflowRow): void {
  printSection('Workflow Details');
  printField('ID', workflow.id);
  printField('Type', workflow.type);
  printField('Status', colorStatus(workflow.status));
  printField('Current Stage', workflow.currentStage);
  printField('Checkpoint Status', workflow.checkpointStatus);
  printField('Template Version', workflow.templateVersion);
  printField('Job ID', workflow.jobId);
  printField('Created At', formatDate(workflow.createdAt));
  printField('Started At', formatDate(workflow.startedAt));
  printField('Completed At', formatDate(workflow.completedAt));

  if (workflow.errorMessage) {
    printSection('Error');
    console.log(c.red(workflow.errorMessage));
  }

  if (hasJsonPayload(workflow.context)) {
    printSection('Context');
    console.log(JSON.stringify(workflow.context, null, 2));
  }
}

export const operationColumns: TableColumn<OperationRow>[] = [
  { header: 'ID', key: (op) => op.id.slice(0, 8), width: 10 },
  { header: 'Type', key: 'type', width: 30 },
  { header: 'Stage', key: 'stage', width: 15 },
  { header: 'Status', key: (op) => colorStatus(op.status), width: 12 },
  { header: 'Attempts', key: (op) => `${op.attempts}/${op.maxAttempts}`, width: 10 },
  { header: 'Error', key: (op) => (op.errorMessage ? truncate(op.errorMessage, 30) : c.dim('-')), width: 32 },
];

export function printOperationDetail(operation: OperationRow): void {
  printSection('Operation Details');
  printField('ID', operation.id);
  printField('Workflow ID', operation.workflowId);
  printField('Type', operation.type);
  printField('Stage', operation.stage);
  printField('Status', colorStatus(operation.status));
  printField('Attempts', `${operation.attempts}/${operation.maxAttempts}`);
  printField('Created At', formatDate(operation.createdAt));
  printField('Started At', formatDate(operation.startedAt));
  printField('Completed At', formatDate(operation.completedAt));

  if (operation.errorMessage) {
    printSection('Error Message');
    console.log(c.red(operation.errorMessage));
  }

  if (hasJsonPayload(operation.result)) {
    printSection('Result');
    console.log(JSON.stringify(operation.result, null, 2));
  }
}
