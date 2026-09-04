/**
 * `/sign-up`, the front door.
 *
 * IT SAYS THE SAME SENTENCE WHATEVER HAPPENS. A new address, an address that
 * already exists unconfirmed, and an address that is already confirmed all end
 * on the same "check your inbox" screen. `registerUser` decides that
 * (`app/services/auth.server.ts`); this file only renders what it returns, and
 * the two refusals it can render, a malformed address and a short password, are
 * both facts about what the reader just typed rather than about who else holds
 * an account here.
 *
 * THE RESEND FORM IS ON THE SAME SCREEN, not behind a link. The reader who
 * needs it is the reader whose mail did not arrive, and asking them to find a
 * second page to say so is asking them to give up.
 *
 * A FAILED SEND SAYS SO AND QUEUES NOTHING. The account row exists either way,
 * so the honest recovery is the resend button on the same screen; a retry queue
 * would be a second thing that can be wrong about whether a mail went out.
 */
import { Form, redirect, type MetaFunction } from 'react-router';
import { useTranslation } from 'react-i18next';

import type { Route } from './+types/sign-up';
import { AuthCard, AuthField, AuthNotice } from '#app/components/account/auth-card';
import { Button } from '#app/components/ui/button';
import { Link } from '#app/components/link';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { requestT } from '#app/i18n/request-t';
import { parseEmail } from '#app/lib/auth/email';
import { MIN_PASSWORD_LENGTH } from '#app/lib/auth/password-rule';
import { SIGN_IN_PATH } from '#app/lib/auth/paths';
import type { TitleHandle } from '#app/lib/route-title';
import { rateLimit } from '#app/middleware/rate-limit';
import { registerUser, resendVerification } from '#app/services/auth.server';
import { resolveUser } from '#app/middleware/auth';

/** Five accounts an hour from one address. A person makes one; a script makes thousands. */
export const middleware = [rateLimit({ limit: 5, windowMs: 60 * 60 * 1000, name: 'sign-up' })];

export const meta: MetaFunction = ({ matches }) => [
  { title: metaTitle(metaLanguage(matches), 'account.createMetaTitle') },
];

export const handle = { titleKey: 'account.createMetaTitle' } satisfies TitleHandle;

/** What the screen renders after a post. One literal per member, so each narrows on its own. */
type SignUpResult =
  | { status: 'mailed'; email: string }
  | { status: 'resent'; email: string }
  | { status: 'mail-failed'; email: string }
  | { status: 'invalid-email' }
  | { status: 'invalid-password' }
  | { status: 'password-mismatch' };

/** A reader who already holds an account is answering a finished question, so they go to it. */
export async function loader({ request }: Route.LoaderArgs): Promise<null> {
  if ((await resolveUser(request)) !== null) throw redirect('/account');
  return null;
}

export async function action({ request }: Route.ActionArgs): Promise<SignUpResult> {
  const form = await request.formData();
  const mail = { t: requestT(request), origin: new URL(request.url).origin };
  const email = parseEmail(String(form.get('email') ?? ''));
  if (email === null) return { status: 'invalid-email' };

  if (String(form.get('intent') ?? '') === 'resend') {
    await resendVerification({ email, mail });
    return { status: 'resent', email };
  }

  const password = String(form.get('password') ?? '');
  if (password !== String(form.get('passwordConfirm') ?? '')) return { status: 'password-mismatch' };

  // A send that fails leaves the account row in place, which is why the answer
  // is "we could not send it" and not "that did not work": the reader's next
  // move is the resend button, not a second sign-up.
  try {
    const result = await registerUser({ email, password, mail });
    if (result.status === 'invalid-password') return { status: 'invalid-password' };
  } catch {
    return { status: 'mail-failed', email };
  }
  return { status: 'mailed', email };
}

export default function SignUpRoute({ actionData }: Route.ComponentProps) {
  const { t } = useTranslation();

  if (actionData?.status === 'mailed' || actionData?.status === 'resent' || actionData?.status === 'mail-failed') {
    return (
      <AuthCard title={t('account.checkInboxTitle')} description={t('account.checkInboxBody')}>
        {actionData.status === 'mail-failed' && <AuthNotice>{t('account.mailFailed')}</AuthNotice>}
        {actionData.status === 'resent' && <p className="text-sm text-muted-foreground">{t('account.resentLabel')}</p>}
        <Form method="post" className="flex flex-col gap-4">
          <input type="hidden" name="intent" value="resend" />
          <input type="hidden" name="email" value={actionData.email} />
          <Button type="submit" variant="outline">
            {t('account.resendAction')}
          </Button>
        </Form>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={t('account.createTitle')}
      description={t('account.createBody')}
      footer={
        <>
          {t('account.haveAccountPrompt')}{' '}
          <Link to={SIGN_IN_PATH} className="underline underline-offset-4 hover:text-foreground">
            {t('account.signInAction')}
          </Link>
        </>
      }
    >
      <Form method="post" className="flex flex-col gap-5">
        <AuthField name="email" label={t('account.emailLabel')} type="email" autoComplete="email" />
        <AuthField
          name="password"
          label={t('account.passwordLabel')}
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
        {actionData?.status === 'invalid-email' && <AuthNotice>{t('account.invalidEmail')}</AuthNotice>}
        {actionData?.status === 'password-mismatch' && <AuthNotice>{t('account.passwordMismatch')}</AuthNotice>}
        {actionData?.status === 'invalid-password' && (
          <AuthNotice>{t('account.passwordTooShort', { min: MIN_PASSWORD_LENGTH })}</AuthNotice>
        )}
        <Button type="submit">{t('account.createAction')}</Button>
      </Form>
    </AuthCard>
  );
}
