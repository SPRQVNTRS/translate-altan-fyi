/**
 * API Key Formatters
 */

import type { TableColumn } from '../types';
import type { ApiKeyRow } from '../schemas';
import { c, formatDate, printField, printSection, colorStatus } from '../output';

export const apiKeyColumns: TableColumn<ApiKeyRow>[] = [
  { header: 'ID', key: (k) => k.id.slice(0, 8), width: 10 },
  { header: 'Name', key: 'name', width: 25 },
  { header: 'Prefix', key: 'prefix', width: 12 },
  {
    header: 'Status',
    key: (k) => (k.revoked ? colorStatus('revoked') : colorStatus('active')),
    width: 12,
  },
  { header: 'Last Used', key: (k) => (k.lastUsedAt ? formatDate(k.lastUsedAt) : c.dim('Never')), width: 22 },
  { header: 'Created', key: (k) => formatDate(k.createdAt), width: 22 },
];

export function printApiKeyDetail(key: ApiKeyRow): void {
  printSection('API Key Details');
  printField('ID', key.id);
  printField('Name', key.name);
  printField('Prefix', key.prefix);
  printField('Status', key.revoked ? 'Revoked' : 'Active');
  printField('Last Used', key.lastUsedAt ? formatDate(key.lastUsedAt) : 'Never');
  printField('Expires At', key.expiresAt ? formatDate(key.expiresAt) : 'Never');
  printField('Created At', formatDate(key.createdAt));
}
