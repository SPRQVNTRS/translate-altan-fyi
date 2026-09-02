/**
 * CLI Output Formatting Utilities
 */

import Table from 'cli-table3';
import type { TableColumn, PaginationInfo, OutputFormat } from './types';

// Color support flag
let colorsEnabled = true;

export function setColorsEnabled(enabled: boolean): void {
  colorsEnabled = enabled;
}

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

function color(colorCode: string, text: string): string {
  if (!colorsEnabled) return text;
  return `${colorCode}${text}${colors.reset}`;
}

// Color helper functions
export const c = {
  red: (text: string) => color(colors.red, text),
  green: (text: string) => color(colors.green, text),
  yellow: (text: string) => color(colors.yellow, text),
  blue: (text: string) => color(colors.blue, text),
  magenta: (text: string) => color(colors.magenta, text),
  cyan: (text: string) => color(colors.cyan, text),
  white: (text: string) => color(colors.white, text),
  gray: (text: string) => color(colors.gray, text),
  bold: (text: string) => color(colors.bold, text),
  dim: (text: string) => color(colors.dim, text),
};

// Status color mapping
export function colorStatus(status: string): string {
  switch (status.toLowerCase()) {
    case 'completed':
    case 'success':
    case 'active':
      return c.green(status);
    case 'failed':
    case 'error':
    case 'deactivated':
      return c.red(status);
    case 'pending':
    case 'queued':
      return c.yellow(status);
    case 'running':
    case 'in_progress':
      return c.cyan(status);
    case 'cancelled':
    case 'skipped':
      return c.gray(status);
    default:
      return status;
  }
}

/**
 * Render one cell. A column addresses its value either by property name or by
 * a renderer function for computed columns.
 */
function renderCell<T>(col: TableColumn<T>, item: T): string {
  if (col.key instanceof Function) return col.key(item);
  const value = item[col.key];
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Create a CLI table with the given columns and data
 */
export function createTable<T>(columns: TableColumn<T>[], data: T[]): Table.Table {
  const table = new Table({
    head: columns.map((col) => c.bold(col.header)),
    colWidths: columns.map((col) => col.width ?? null),
    colAligns: columns.map((col) => col.align || 'left'),
    style: {
      head: [],
      border: [],
    },
  });

  for (const item of data) {
    const row = columns.map((col) => renderCell(col, item));
    table.push(row);
  }

  return table;
}

/**
 * Output data in table format
 */
export function outputTable<T>(
  data: T[],
  columns: TableColumn<T>[],
  pagination?: PaginationInfo,
): void {
  const table = createTable(columns, data);
  console.log(table.toString());

  if (pagination) {
    const { total, limit, offset } = pagination;
    const showing = Math.min(limit, total - offset);
    const end = offset + showing;
    console.log(c.dim(`\nShowing ${offset + 1}-${end} of ${total} results`));
  }
}

/**
 * Output data as JSON
 */
export function outputJson<T>(
  data: T,
  pagination?: PaginationInfo,
): void {
  if (pagination) {
    console.log(JSON.stringify({ data, pagination }, null, 2));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

/**
 * Output just IDs (one per line)
 */
export function outputIds<T extends { id: string | number }>(data: T[]): void {
  for (const item of data) {
    console.log(item.id);
  }
}

/**
 * Output raw text
 */
export function outputRaw(text: string): void {
  console.log(text);
}

/**
 * Generic output router
 */
export function output<T extends { id: string | number }>(
  format: OutputFormat,
  data: T[],
  columns: TableColumn<T>[],
  pagination?: PaginationInfo,
): void {
  switch (format) {
    case 'json':
      outputJson(data, pagination);
      break;
    case 'ids':
      outputIds(data);
      break;
    case 'raw':
      outputRaw(JSON.stringify(data));
      break;
    case 'table':
    default:
      outputTable(data, columns, pagination);
      break;
  }
}

/**
 * Print an error message
 */
export function printError(message: string, details?: string): void {
  console.error(c.red(`Error: ${message}`));
  if (details) {
    console.error(c.dim(details));
  }
}

/**
 * Print a success message
 */
export function printSuccess(message: string): void {
  console.log(c.green(`✓ ${message}`));
}

/**
 * Print a warning message
 */
export function printWarning(message: string): void {
  console.warn(c.yellow(`Warning: ${message}`));
}

/**
 * Print an info message
 */
export function printInfo(message: string): void {
  console.log(c.blue(`ℹ ${message}`));
}

/**
 * Print a label-value pair
 */
export function printField(label: string, value: string | number | boolean | null | undefined): void {
  const displayValue = value === null || value === undefined ? c.dim('(none)') : String(value);
  console.log(`${c.bold(label)}: ${displayValue}`);
}

/**
 * Print a section header
 */
export function printSection(title: string): void {
  console.log(`\n${c.bold(c.cyan(title))}`);
  console.log(c.dim('─'.repeat(title.length + 4)));
}

/**
 * Format a date for display
 */
export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return c.dim('(none)');
  // `new Date(value)` accepts both an ISO string (HTTP transport) and a Date
  // (direct transport), so no representation check is needed.
  return new Date(date).toLocaleString();
}

/**
 * Format a date as relative time
 */
export function formatRelativeTime(date: Date | string | null | undefined): string {
  if (!date) return c.dim('(none)');
  const d = new Date(date);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 30) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

/**
 * Truncate a string to a maximum length
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}
