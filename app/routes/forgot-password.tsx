/**
 * `/forgot-password`, the first half of a password reset.
 *
 * IT ANSWERS THE SAME SENTENCE TO EVERYBODY. An address on file, an address
 * that never confirmed, and an address nobody has ever used all end on the same
 * screen. `requestPasswordReset` decides that, and the only refusal this page
 * can render is a malformed address, which is a fact about the reader's own
 * typing.
 *
 * THREE AN HOUR. A reset mail is a mail somebody else's inbox receives, so the
 * limit here is stricter than sign-in's: the abuse this stops is not guessing a
 * password, it is using this form as a way to send a stranger mail.
 */
import { Form, type MetaFunction } from 'react-router';
import { useTranslation } from 'react-i18next';

import type { Route } from './+types/forgot-password';
import { AuthCard, AuthField, AuthNotice } from '#app/components/account/auth-card';
import { Button } from '#app/components/ui/button';
import { Link } from '#app/components/link';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { requestT } from '#app/i18n/request-t';
import { parseEmail } from '#app/lib/auth/email';
import { SIGN_IN_PATH } from '#app/lib/auth/paths';
import type { TitleHandle } from '#app/lib/route-title';
import { rateLimit } from '#app/middleware/rate-limit';
import { requestPasswordReset } from '#app/services/auth.server';

export const middleware = [rateLimit({ limit: 3, windowMs: 60 * 60 * 1000, name: 'forgot-password' })];

export const meta: MetaFunction = ({ matches }) => [
  { title: metaTitle(metaLanguage(matches), 'account.forgotMetaTitle') },
];

export const handle = { titleKey: 'account.forgotMetaTitle' } satisfies TitleHandle;

type ForgotResult = { status: 'mailed' } | { status: 'invalid-email' };

export async function action({ request }: Route.ActionArgs): Promise<ForgotResult> {
  const email = parseEmail(String((await request.formData()).get('email') ?? ''));
  if (email === null) return { status: 'invalid-email' };

  await requestPasswordReset({ email, mail: { t: requestT(request), origin: new URL(request.url).origin } });
  return { status: 'mailed' };
}

export default function ForgotPasswordRoute({ actionData }: Route.ComponentProps) {
  const { t } = useTranslation();

  if (actionData?.status === 'mailed') {
    return (
      <AuthCard title={t('account.forgotSentTitle')} description={t('account.forgotSentBody')}>
        <Link to={SIGN_IN_PATH} className="text-sm underline underline-offset-4 hover:text-foreground">
          {t('account.signInAction')}
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t('account.forgotTitle')} description={t('account.forgotBody')}>
      <Form method="post" className="flex flex-col gap-5">
        <AuthField name="email" label={t('account.emailLabel')} type="email" autoComplete="email" />
        {actionData?.status === 'invalid-email' && <AuthNotice>{t('account.invalidEmail')}</AuthNotice>}
        <Button type="submit">{t('account.forgotSubmit')}</Button>
      </Form>
    </AuthCard>
  );
}
