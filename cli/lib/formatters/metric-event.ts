/**
 * Metric Event Formatters
 */

import type { TableColumn } from '../types';
import type { MetricEventRow } from '../schemas';
import { formatDate, printField, printSection } from '../output';

export const metricEventColumns: TableColumn<MetricEventRow>[] = [
  { header: 'ID', key: 'id', width: 8 },
  { header: 'Source', key: 'source', width: 20 },
  { header: 'Event Type', key: 'eventType', width: 25 },
  { header: 'Timestamp', key: (e) => formatDate(e.timestamp), width: 22 },
  { header: 'Created', key: (e) => formatDate(e.createdAt), width: 22 },
];

export function printMetricEventDetail(event: MetricEventRow): void {
  printSection('Metric Event Details');
  printField('ID', event.id);
  printField('Organization ID', event.organizationId);
  printField('Source', event.source);
  printField('Event Type', event.eventType);
  printField('Payload', JSON.stringify(event.payload, null, 2));
  printField('Timestamp', formatDate(event.timestamp));
  printField('Created At', formatDate(event.createdAt));
}
