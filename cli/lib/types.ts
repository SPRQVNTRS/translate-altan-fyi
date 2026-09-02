/**
 * CLI Type Definitions
 */

export type OutputFormat = 'table' | 'json' | 'ids' | 'raw';

export interface TableColumn<T> {
  header: string;
  key: keyof T | ((item: T) => string);
  width?: number;
  align?: 'left' | 'center' | 'right';
}

export interface PaginationInfo {
  total: number;
  limit: number;
  offset: number;
}

export interface ListOptions {
  format: OutputFormat;
  limit?: number;
  offset?: number;
}

export interface GlobalOptions {
  color: boolean;
  verbose: boolean;
  quiet: boolean;
}

// Workflow status types
export type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type OperationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
