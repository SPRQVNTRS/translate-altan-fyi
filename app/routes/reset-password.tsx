/**
 * `/reset-password?token=`, the second half of a password reset.
 *
 * THE LOADER DOES NOT SPEND THE TOKEN. It only checks that the URL carries one,
 * and hands it to a hidden field. Spending it on the GET would mean a mail
 * client that prefetches links burns the reader's only reset before they have
 * typed anything; the action is where it is consumed, in the one statement
 * `auth.server.ts` describes.
 *
 * A SUCCESSFUL RESET SIGNS EVERY OTHER DEVICE OUT, and that is the point of it
 * rather than a side effect: whoever made the reader reset also had their old
 * password. `resetPassword` moves `users.password_changed_at`, which is the
 * session epoch, and hands back a fresh cookie for THIS browser. Setting that
 * cookie is not optional: without it this screen would sign out the reader it
 * just let back in.
 */
import { Form, redirect, type MetaFunction } from 'react-router';
import { useTranslation } from 'react-i18next';

import type { Route } from './+types/reset-password';
import { AuthCard, AuthField, AuthNotice } from '#app/components/account/auth-card';
import { Button } from '#app/components/ui/button';
import { Link } from '#app/components/link';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { MIN_PASSWORD_LENGTH } from '#app/lib/auth/password-rule';
import type { TitleHandle } from '#app/lib/route-title';
import { resetPassword } from '#app/services/auth.server';

export const meta: MetaFunction = ({ matches }) => [
  { title: metaTitle(metaLanguage(matches), 'account.resetMetaTitle') },
];

export const handle = { titleKey: 'account.resetMetaTitle' } satisfies TitleHandle;

type ResetResultView =
  | { status: 'invalid-token' }
  | { status: 'invalid-password' }
  | { status: 'password-mismatch' };

/** What the screen needs from the URL: the token, carried into a hidden field rather than spent here. */
interface ResetPasswordLoaderData {
  token: string;
}

export function loader({ request }: Route.LoaderArgs): ResetPasswordLoaderData {
  return { token: new URL(request.url).searchParams.get('token') ?? '' };
}

export async function action({ request }: Route.ActionArgs): Promise<Response | ResetResultView> {
  const form = await request.formData();
  const password = String(form.get('password') ?? '');
  if (password !== String(form.get('passwordConfirm') ?? '')) return { status: 'password-mismatch' };

  const result = await resetPassword({
    rawToken: String(form.get('token') ?? ''),
    password,
    request,
  });
  if (result.status !== 'ok') return { status: result.status };

  return redirect('/account', { headers: { 'Set-Cookie': result.setCookie } });
}

export default function ResetPasswordRoute({ loaderData, actionData }: Route.ComponentProps) {
  const { t } = useTranslation();

  // No token in the URL, or one the server refused. Both are the same dead end
  // for the reader, and the way out of both is a new mail.
  if (loaderData.token === '' || actionData?.status === 'invalid-token') {
    return (
      <AuthCard title={t('account.resetInvalidTitle')} description={t('account.resetInvalidBody')}>
        <Link to="/forgot-password" className="text-sm underline underline-offset-4 hover:text-foreground">
          {t('account.forgotSubmit')}
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t('account.resetTitle')} description={t('account.resetBody')}>
      <Form method="post" className="flex flex-col gap-5">
        <input type="hidden" name="token" value={loaderData.token} />
        <AuthField
          name="password"
          label={t('account.newPasswordLabel')}
          type="password"
          autoComplete="new-password"
          hint={t('account.passwordHint')}
        />
        <AuthField
          name="passwordConfirm"
          label={t('account.passwordConfirmLabel')}
          type="password"
          autoComplete="new-password"
        />
        {actionData?.status === 'password-mismatch' && <AuthNotice>{t('account.passwordMismatch')}</AuthNotice>}
        {actionData?.status === 'invalid-password' && (
          <AuthNotice>{t('account.passwordTooShort', { min: MIN_PASSWORD_LENGTH })}</AuthNotice>
        )}
        <Button type="submit">{t('account.resetSubmit')}</Button>
      </Form>
    </AuthCard>
  );
}
