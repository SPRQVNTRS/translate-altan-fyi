import { redirect } from 'react-router';
import type { Route } from './+types/search-redirect';

/**
 * `/search` was the route id `/translate` carried until earlier today. The
 * rename dropped it on the assumption that nothing external linked to the old
 * path, and that assumption was wrong in the most ordinary way: a rename is
 * invisible to a tab that is already open, to a bookmark, and to a `?next=`
 * query parameter already in flight from the account gate. All three point at
 * `/search` and none of them will ever be edited by hand.
 *
 * A PERMANENT redirect, unlike the `/super` hop: the old path is not coming
 * back, so `301` is the correct status and a browser is meant to cache it.
 *
 * THE QUERY STRING MUST SURVIVE. `/search?q=Haus&from=de&to=en` is a
 * shareable result, not a bare path, and a redirect that dropped the search
 * params would silently discard what the reader typed, which is worse than
 * the 404 it replaces.
 *
 * No component and no default export: this file is a hop, not a screen. The
 * destination, `/translate`, does its own per-request account gating in its
 * own loader (see `app/lib/route-classification.ts`), so this file adds no
 * check of its own.
 */
export function loader({ request }: Route.LoaderArgs): Response {
  const { search } = new URL(request.url);
  return redirect(`/translate${search}`, 301);
}
