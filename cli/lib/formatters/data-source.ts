/**
 * Data Source Formatters
 */

import type { TableColumn } from '../types';
import type { DataSourceRow } from '../schemas';
import { c, formatDate, printField, printSection } from '../output';

export const dataSourceColumns: TableColumn<DataSourceRow>[] = [
  { header: 'ID', key: (ds) => ds.id.slice(0, 8), width: 10 },
  { header: 'Name', key: 'name', width: 25 },
  { header: 'Slug', key: 'slug', width: 20 },
  { header: 'Type', key: 'type', width: 12 },
  {
    header: 'Enabled',
    key: (ds) => (ds.enabled ? c.green('Yes') : c.dim('No')),
    width: 10,
  },
  { header: 'Schedule', key: 'schedule', width: 15 },
  { header: 'Last Fetched', key: (ds) => (ds.lastFetchedAt ? formatDate(ds.lastFetchedAt) : c.dim('Never')), width: 22 },
];

export function printDataSourceDetail(ds: DataSourceRow): void {
  printSection('Data Source Details');
  printField('ID', ds.id);
  printField('Name', ds.name);
  printField('Slug', ds.slug);
  printField('Type', ds.type);
  printField('Enabled', ds.enabled ? 'Yes' : 'No');
  printField('Schedule', ds.schedule);
  printField('Config', JSON.stringify(ds.config, null, 2));
  printField('Mapping', ds.mapping ? JSON.stringify(ds.mapping, null, 2) : 'None');
  printField('Last Fetched', ds.lastFetchedAt ? formatDate(ds.lastFetchedAt) : 'Never');
  printField('Last Error', ds.lastError ?? 'None');
  printField('Created At', formatDate(ds.createdAt));
  printField('Updated At', formatDate(ds.updatedAt));
}
