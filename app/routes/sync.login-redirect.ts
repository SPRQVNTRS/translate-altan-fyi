import { redirect } from 'react-router';
import type { Route } from './+types/sync.login-redirect';

/**
 * `/sync/login` answers forever, and it answers `/sign-in`.
 *
 * The old path was linked from the app's own settings card, from the vote
 * prompt on an entry page, and from every gated redirect since M184, so it is
 * in browser histories, in bookmarks and in at least one invite somebody
 * pasted into a chat. A rename that breaks those is a rename that loses
 * readers.
 *
 * PERMANENT, AND IT KEEPS THE QUERY STRING. `301` because the move is the
 * final answer rather than a maintenance window, and the query survives because
 * a link may carry one: nothing here reads it, so preserving it is the only way
 * this hop cannot lose information.
 *
 * No component and no default export: this file is a hop, not a screen.
 */
export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  const { search } = new URL(request.url);
  return redirect(`/sign-in${search}`, 301);
}
