/**
 * `/verify-email?token=`, where the confirmation link lands.
 *
 * THE LOADER SPENDS THE TOKEN. Clicking the link IS the confirmation, so there
 * is nothing for the reader to press and no second screen between the mail and
 * the result. `verifyEmailToken` consumes it in one statement, so a link opened
 * twice, by a mail client that prefetches and then by the reader, confirms once
 * and reports the second visit as spent.
 *
 * USED, EXPIRED AND UNKNOWN ARE ONE ANSWER. The server cannot tell them apart
 * without telling an attacker apart too, so the screen says the link does not
 * work and offers a new one. That resend form is the whole recovery path, and
 * it is on this screen rather than behind a link for the same reason it is on
 * the sign-up screen: the reader who needs it is already stuck.
 */
import { Form, type MetaFunction } from 'react-router';
import { useTranslation } from 'react-i18next';

import type { Route } from './+types/verify-email';
import { AuthCard, AuthField, AuthNotice } from '#app/components/account/auth-card';
import { Button, buttonVariants } from '#app/components/ui/button';
import { Link } from '#app/components/link';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { requestT } from '#app/i18n/request-t';
import { parseEmail } from '#app/lib/auth/email';
import { SIGN_IN_PATH } from '#app/lib/auth/paths';
import type { TitleHandle } from '#app/lib/route-title';
import { rateLimit } from '#app/middleware/rate-limit';
import { resendVerification, verifyEmailToken } from '#app/services/auth.server';

/** The same allowance sign-up gets, because it is the same mail. */
export const middleware = [rateLimit({ limit: 5, windowMs: 60 * 60 * 1000, name: 'verify-resend' })];

export const meta: MetaFunction = ({ matches }) => [
  { title: metaTitle(metaLanguage(matches), 'account.verifyMetaTitle') },
];

export const handle = { titleKey: 'account.verifyMetaTitle' } satisfies TitleHandle;

export async function loader({ request }: Route.LoaderArgs): Promise<{ verified: boolean }> {
  const token = new URL(request.url).searchParams.get('token');
  if (token === null || token === '') return { verified: false };
  const consumed = await verifyEmailToken(token);
  return { verified: consumed.status === 'ok' };
}

export async function action({ request }: Route.ActionArgs): Promise<{ status: 'resent' } | { status: 'invalid-email' }> {
  const form = await request.formData();
  const email = parseEmail(String(form.get('email') ?? ''));
  if (email === null) return { status: 'invalid-email' };

  await resendVerification({ email, mail: { t: requestT(request), origin: new URL(request.url).origin } });
  return { status: 'resent' };
}

export default function VerifyEmailRoute({ loaderData, actionData }: Route.ComponentProps) {
  const { t } = useTranslation();

  if (loaderData.verified) {
    return (
      <AuthCard title={t('account.verifiedTitle')} description={t('account.verifiedBody')}>
        <Link to={SIGN_IN_PATH} className={buttonVariants({ className: 'w-full' })}>
          {t('account.signInAction')}
        </Link>
      </AuthCard>
    );
  }

  if (actionData?.status === 'resent') {
    return <AuthCard title={t('account.checkInboxTitle')} description={t('account.checkInboxBody')} />;
  }

  return (
    <AuthCard title={t('account.verifyInvalidTitle')} description={t('account.verifyInvalidBody')}>
      <Form method="post" className="flex flex-col gap-5">
        <AuthField name="email" label={t('account.emailLabel')} type="email" autoComplete="email" />
        {actionData?.status === 'invalid-email' && <AuthNotice>{t('account.invalidEmail')}</AuthNotice>}
        <Button type="submit">{t('account.resendAction')}</Button>
      </Form>
    </AuthCard>
  );
}
