/**
 * GET /api/v1/translation-votes - The down-voted translations, newest vote first.
 *
 * THE SAME ROWS `/super/llm` SHOWS, over the API this time, so an operator can
 * read the complaint queue without a browser and without database credentials.
 *
 * SUPERADMIN ONLY, AND THAT IS A PRODUCT DECISION RATHER THAN CAUTION. A score
 * is an operator's instrument here: M194 decision 8 says nothing automatic hangs
 * off it, no re-run, no hiding and no reordering, so the only reader of this
 * list is a person deciding what to look at. Published to any key it would also
 * be a public ranking of the dictionary's worst rows, which is a thing this
 * product does not offer.
 *
 * IT NAMES NO READER. The model groups the account column away before anything
 * is selected, so what crosses this boundary is "this edge scored badly", never
 * "this reader judged this word". See the header of
 * `app/models/translation-votes.server.ts`.
 */

import type { Route } from './+types/api.v1.translation-votes';
import { requireSuperadminApiKey } from '#app/lib/api-auth.server';
import { paginatedJson, parsePaginationParams } from '#app/lib/pagination.server';
import { listDownVotedTranslationsPage } from '#app/models/translation-votes.server';
import { getRawDb } from '#drizzle/db';

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  await requireSuperadminApiKey(request);

  const url = new URL(request.url);
  const pagination = parsePaginationParams(url.searchParams);
  const { rows, total } = await listDownVotedTranslationsPage(getRawDb(), pagination);
  return paginatedJson({ data: rows, total, limit: pagination.limit, offset: pagination.offset });
}
