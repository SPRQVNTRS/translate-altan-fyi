import { Form, redirect, type MetaFunction } from 'react-router';
import { useTranslation } from 'react-i18next';

import type { Route } from './+types/account';
import { Link } from '#app/components/link';
import { ExportDataButton } from '#app/components/account/export-data-button';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { changePassword, deleteUser } from '#app/services/auth.server';
import { SIGN_IN_PATH } from '#app/lib/auth/paths';
import { destroyUserSession } from '#app/services/session.server';
import { resolveUser } from '#app/middleware/auth';

export const meta: MetaFunction = ({ matches }) => [{ title: metaTitle(metaLanguage(matches), 'account.metaTitle') }];

/** Anonymous is a NORMAL state here: this screen reports it rather than ending it. */
export async function loader({ request }: Route.LoaderArgs): Promise<{ email: string | null }> {
  const user = await resolveUser(request);
  return { email: user?.email ?? null };
}

/** Change the password, delete the account, or sign out. Spec 03 gives each its own form. */
export async function action({ request }: Route.ActionArgs): Promise<Response | { status: string }> {
  const user = await resolveUser(request);
  if (user === null) throw redirect(SIGN_IN_PATH);

  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');

  if (intent === 'sign-out') {
    return redirect('/', { headers: { 'Set-Cookie': await destroyUserSession(request) } });
  }
  if (intent === 'delete') {
    await deleteUser(user.id);
    return redirect('/', { headers: { 'Set-Cookie': await destroyUserSession(request) } });
  }

  const result = await changePassword({
    userId: user.id,
    current: String(form.get('current') ?? ''),
    next: String(form.get('next') ?? ''),
    request,
  });
  // The fresh cookie is what keeps THIS tab signed in: the change moved the
  // session epoch, so every older cookie, including the one this request
  // arrived with, is refused from now on.
  if (result.status === 'ok') return redirect('/account', { headers: { 'Set-Cookie': result.setCookie } });
  return { status: result.status };
}

/** Minimal by design: spec 03 replaces this screen with the real one. */
export default function AccountRoute({ loaderData, actionData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { email } = loaderData;

  if (email === null) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <p>{t('account.signedOutBody')}</p>
        <Link to="/sign-up">{t('account.createAction')}</Link>
        <Link to={SIGN_IN_PATH}>{t('account.signInAction')}</Link>
        <ExportDataButton />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <p className="font-mono text-sm">{email}</p>
      <Form method="post" className="flex flex-col gap-3">
        <label htmlFor="current">{t('account.passwordLabel')}</label>
        <input id="current" name="current" type="password" required autoComplete="current-password" />
        <label htmlFor="next">{t('account.passwordConfirmLabel')}</label>
        <input id="next" name="next" type="password" required autoComplete="new-password" />
        {actionData?.status !== undefined && <p>{t('account.signInFailed')}</p>}
        <button type="submit">{t('account.doneAction')}</button>
      </Form>
      <Form method="post">
        <input type="hidden" name="intent" value="sign-out" />
        <button type="submit">{t('account.signOutAction')}</button>
      </Form>
      <ExportDataButton />
    </div>
  );
}
