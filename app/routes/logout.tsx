/**
 * `/logout`, the sign-out.
 *
 * IT DESTROYS THE COOKIE, AND THAT IS THE WHOLE OF SIGNING OUT since M191:
 * there is no token family to revoke and no server-side session row, because
 * the cookie IS the session and the middleware re-reads the user from it on
 * every request.
 */
import type { Route } from './+types/logout';
import { redirect } from 'react-router';
import { SIGN_IN_PATH } from '#app/lib/auth/paths';
import { destroyUserSession } from '#app/services/session.server';

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  return signOut(request);
}

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  return signOut(request);
}

async function signOut(request: Request): Promise<Response> {
  return redirect(SIGN_IN_PATH, {
    headers: { 'Set-Cookie': await destroyUserSession(request) },
  });
}
