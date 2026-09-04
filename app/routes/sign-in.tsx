import { Form, redirect, type MetaFunction } from 'react-router';
import { useTranslation } from 'react-i18next';

import type { Route } from './+types/sign-in';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import type { TitleHandle } from '#app/lib/route-title';
import { signIn } from '#app/services/auth.server';
import { commitUserSession } from '#app/services/session.server';
import { resolveUser } from '#app/middleware/auth';

export const meta: MetaFunction = ({ matches }) => [
  { title: metaTitle(metaLanguage(matches), 'account.signInMetaTitle') },
];

export const handle = { titleKey: 'account.signInMetaTitle' } satisfies TitleHandle;

/** A reader who is already signed in has nothing to do on a sign-in form. */
export async function loader({ request }: Route.LoaderArgs): Promise<null> {
  if ((await resolveUser(request)) !== null) throw redirect('/account');
  return null;
}

/**
 * ONE REFUSAL FOR THREE CAUSES. `signIn` answers `null` for an unknown address,
 * a wrong password and an unconfirmed address alike, so this action cannot turn
 * the form into an enumeration oracle.
 */
export async function action({ request }: Route.ActionArgs): Promise<Response | { status: 'failed' }> {
  const form = await request.formData();
  const user = await signIn({
    email: String(form.get('email') ?? ''),
    password: String(form.get('password') ?? ''),
  });
  if (user === null) return { status: 'failed' };

  const next = String(form.get('next') ?? '');
  return redirect(next.startsWith('/') ? next : '/', {
    headers: { 'Set-Cookie': await commitUserSession({ request, userId: user.id }) },
  });
}

/** Minimal by design: spec 03 replaces this screen with the real one. */
export default function SignInRoute({ actionData }: Route.ComponentProps) {
  const { t } = useTranslation();
  return (
    <Form method="post" className="mx-auto flex w-full max-w-md flex-col gap-3">
      <label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" required autoComplete="email" />
      <label htmlFor="password">{t('account.passwordLabel')}</label>
      <input id="password" name="password" type="password" required autoComplete="current-password" />
      {actionData?.status === 'failed' && <p>{t('account.signInFailed')}</p>}
      <button type="submit">{t('account.signInAction')}</button>
    </Form>
  );
}
