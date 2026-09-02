/**
 * `/logout`, the org-surface sign-out.
 *
 * IT DESTROYS THE COOKIE BUT DOES NOT REVOKE THE TOKENS. Revocation is
 * `POST /api/v1/auth/logout`, which revokes the caller's token family
 * server-side; this route is the browser-navigation twin, kept because the
 * admin and org screens link to it and because a `GET` that leaves nothing
 * behind in the browser is worth having even when the API call fails.
 *
 * It redirects to the ACCOUNT sign-in page. `/login` was the bcrypt form and
 * is not the way in any more.
 */
import type { Route } from './+types/logout';
import { redirect } from 'react-router';
import { ACCOUNT_LOGIN_PATH, destroyAccountSession } from '#app/services/account-session.server';

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  return signOut(request);
}

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  return signOut(request);
}

async function signOut(request: Request): Promise<Response> {
  return redirect(ACCOUNT_LOGIN_PATH, {
    headers: { 'Set-Cookie': await destroyAccountSession(request) },
  });
}
