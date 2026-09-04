import { redirect } from 'react-router';
import type { Route } from './+types/sync.setup-redirect';

/**
 * `/sync/setup` answers forever, and it answers `/sign-up`.
 *
 * THE QUERY STRING IS THE POINT HERE, more than on the sign-in hop beside it.
 * An invite is handed out as `?invite=<token>`, and a redirect that dropped it
 * would send an invited reader to a signup form with nothing to admit them,
 * which reads as a broken invite rather than as a broken redirect.
 *
 * `301`, for the same reason as `sync.login-redirect.ts`: the move is the final
 * answer. No component and no default export: this file is a hop, not a screen.
 */
export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  const { search } = new URL(request.url);
  return redirect(`/sign-up${search}`, 301);
}
