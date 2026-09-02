/**
 * Organization Formatters
 */

import type { MemberRow, OrganizationRow } from '../schemas';
import type { TableColumn } from '../types';
import { c, printField, printSection, formatDate } from '../output';

export const organizationColumns: TableColumn<OrganizationRow>[] = [
  { header: 'ID', key: (org) => org.id.slice(0, 8), width: 10 },
  { header: 'Name', key: 'name', width: 30 },
  { header: 'Slug', key: 'slug', width: 25 },
  { header: 'Created', key: (org) => formatDate(org.createdAt), width: 20 },
];

export function printOrganizationDetail(org: OrganizationRow): void {
  printSection('Organization Details');
  printField('ID', org.id);
  printField('Name', org.name);
  printField('Slug', org.slug);
  printField('Settings', JSON.stringify(org.settings));
  printField('Created At', formatDate(org.createdAt));
  printField('Updated At', formatDate(org.updatedAt));
}

export const memberColumns: TableColumn<MemberRow>[] = [
  { header: 'User ID', key: (m) => String(m.user.id), width: 10 },
  { header: 'Name', key: (m) => m.user.name, width: 25 },
  { header: 'Email', key: (m) => m.user.email, width: 35 },
  { header: 'Role', key: (m) => c.cyan(m.role), width: 12 },
  { header: 'Joined', key: (m) => formatDate(m.joinedAt), width: 20 },
];
