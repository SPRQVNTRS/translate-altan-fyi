import type { Route } from './+types/logout';
import { sessionStorage } from '#app/services/session.server';
import { redirect } from 'react-router';

export async function action({ request }: Route.ActionArgs) {
  const session = await sessionStorage.getSession(request.headers.get('cookie'));
  return redirect('/login', {
    headers: { 'Set-Cookie': await sessionStorage.destroySession(session) },
  });
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await sessionStorage.getSession(request.headers.get('cookie'));
  return redirect('/login', {
    headers: { 'Set-Cookie': await sessionStorage.destroySession(session) },
  });
}
