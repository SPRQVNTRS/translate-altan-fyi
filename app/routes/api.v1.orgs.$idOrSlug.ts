/**
 * GET    /api/v1/orgs/:idOrSlug?withMembers=true → { org: SelectOrganization, members?: MemberWithUser[] }
 * DELETE /api/v1/orgs/:idOrSlug?force=true&dryRun=true → { deleted: true } | { dryRun: true, org, memberCount }
 *
 * Auth: superadmin API key only.
 */

import type { Route } from './+types/api.v1.orgs.$idOrSlug';
import { requireSuperadminApiKey, jsonError } from '#app/lib/api-auth.server';
import {
  getOrgByIdOrSlug,
  getOrgMembersAdmin,
  countOrgMembersAdmin,
  deleteOrgAdmin,
} from '#app/models/orgs-admin.server';

export async function loader({ request, params }: Route.LoaderArgs): Promise<Response> {
  await requireSuperadminApiKey(request);

  const { idOrSlug } = params;
  if (!idOrSlug) throw jsonError(400, 'missing idOrSlug');

  const org = await getOrgByIdOrSlug(idOrSlug);
  if (!org) throw jsonError(404, 'organization not found');

  const url = new URL(request.url);
  const withMembers = url.searchParams.get('withMembers') === 'true';

  if (withMembers) {
    const { rows: members } = await getOrgMembersAdmin(org.id);
    return new Response(JSON.stringify({ org, members }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ org }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function action({ request, params }: Route.ActionArgs): Promise<Response> {
  if (request.method !== 'DELETE') throw jsonError(405, 'method not allowed');

  await requireSuperadminApiKey(request);

  const { idOrSlug } = params;
  if (!idOrSlug) throw jsonError(400, 'missing idOrSlug');

  const org = await getOrgByIdOrSlug(idOrSlug);
  if (!org) throw jsonError(404, 'organization not found');

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === 'true';
  const force = url.searchParams.get('force') === 'true';

  if (dryRun) {
    const memberCount = await countOrgMembersAdmin(org.id);
    return new Response(JSON.stringify({ dryRun: true, org, memberCount }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!force) {
    throw jsonError(400, 'pass ?force=true to confirm deletion');
  }

  await deleteOrgAdmin(org.id);

  return new Response(JSON.stringify({ deleted: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
