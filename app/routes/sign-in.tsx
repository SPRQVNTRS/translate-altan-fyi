/**
 * `/sign-in`, where every gated redirect lands.
 *
 * ONE REFUSAL FOR TWO CAUSES, AND A THIRD ANSWER THAT IS NOT A REFUSAL. An
 * unknown address and a wrong password read identically, so this form is not a
 * list of who holds an account. An address whose CORRECT password was just
 * typed, and which has not confirmed its mailed link, is told exactly that and
 * is given the resend form on the spot. `signIn` decides which of the three it
 * is (`app/services/auth.server.ts`); this screen only renders the answer.
 *
 * THAT THIRD ANSWER DISCLOSES NOTHING NEW. Reaching it requires the password,
 * so the reader has already proved what it would otherwise reveal. The
 * alternative, which a browser walk found on 2026-09-04, is telling somebody
 * holding the right credentials that they are wrong, with no way forward.
 *
 * `?next=` ROUND TRIPS, AND ONLY AS A PATH. `authMiddleware` puts the refused
 * path in the query string, this form carries it through as a hidden field, and
 * the action refuses anything that is not a same-site path. An absolute URL
 * here would let a crafted link bounce a reader onto somebody else's site with
 * a fresh session in their browser.
 */
import { Form, redirect, type MetaFunction } from 'react-router';
import { useTranslation } from 'react-i18next';

import type { Route } from './+types/sign-in';
import { AuthCard, AuthField, AuthNotice } from '#app/components/account/auth-card';
import { Button } from '#app/components/ui/button';
import { Link } from '#app/components/link';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { parseEmail } from '#app/lib/auth/email';
import { SIGN_UP_PATH } from '#app/lib/auth/paths';
import type { TitleHandle } from '#app/lib/route-title';
import { requestT } from '#app/i18n/request-t';
import { rateLimit } from '#app/middleware/rate-limit';
import { resendVerification, signIn } from '#app/services/auth.server';
import { commitUserSession } from '#app/services/session.server';
import { resolveUser } from '#app/middleware/auth';

/** Ten a minute. Fast enough for a mistyped password, slow enough that a list is not worth walking. */
export const middleware = [rateLimit({ limit: 10, windowMs: 60 * 1000, name: 'sign-in' })];

export const meta: MetaFunction = ({ matches }) => [
  { title: metaTitle(metaLanguage(matches), 'account.signInMetaTitle') },
];

export const handle = { titleKey: 'account.signInMetaTitle' } satisfies TitleHandle;

/** What the screen renders after a post. One literal per member, so each narrows on its own. */
type SignInView =
  | { status: 'failed' }
  | { status: 'unconfirmed'; email: string }
  | { status: 'resent' }
  | { status: 'invalid-email' };

/** A reader who is already signed in has nothing to do on a sign-in form. */
export async function loader({ request }: Route.LoaderArgs): Promise<{ next: string }> {
  if ((await resolveUser(request)) !== null) throw redirect('/account');
  return { next: safeNext(new URL(request.url).searchParams.get('next') ?? '') };
}

export async function action({ request }: Route.ActionArgs): Promise<Response | SignInView> {
  const form = await request.formData();
  const email = parseEmail(String(form.get('email') ?? ''));
  if (email === null) return { status: 'invalid-email' };

  const mail = { t: requestT(request), origin: new URL(request.url).origin };

  // The resend button on the unconfirmed screen below. It posts back here with
  // the address the reader already proved they hold.
  if (String(form.get('intent') ?? '') === 'resend') {
    await resendVerification({ email, mail });
    return { status: 'resent' };
  }

  const attempt = await signIn({ email, password: String(form.get('password') ?? '') });
  if (attempt.status === 'refused') return { status: 'failed' };
  if (attempt.status === 'unconfirmed') return { status: 'unconfirmed', email };

  return redirect(safeNext(String(form.get('next') ?? '')), {
    headers: { 'Set-Cookie': await commitUserSession({ request, userId: attempt.user.id }) },
  });
}

/**
 * The destination, or the home page.
 *
 * A SAME-SITE PATH AND NOTHING ELSE. `//evil.example` is a protocol-relative
 * URL that a browser treats as another origin, so the second character is
 * checked as well as the first.
 */
function safeNext(raw: string): string {
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

export default function SignInRoute({ loaderData, actionData }: Route.ComponentProps) {
  const { t } = useTranslation();

  if (actionData?.status === 'resent') {
    return <AuthCard title={t('account.checkInboxTitle')} description={t('account.checkInboxBody')} />;
  }

  // The correct password on an address that never opened its mailed link. The
  // resend form IS this screen, rather than a link somewhere on it: the reader
  // is stuck, and one button is the whole way out.
  if (actionData?.status === 'unconfirmed') {
    return (
      <AuthCard title={t('account.verifyFirstTitle')} description={t('account.verifyFirst')}>
        <Form method="post" className="flex flex-col gap-4">
          <input type="hidden" name="intent" value="resend" />
          <input type="hidden" name="email" value={actionData.email} />
          <Button type="submit">{t('account.resendAction')}</Button>
        </Form>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={t('account.signInTitle')}
      footer={
        <>
          {t('account.noAccountPrompt')}{' '}
          <Link to={SIGN_UP_PATH} className="underline underline-offset-4 hover:text-foreground">
            {t('account.createAction')}
          </Link>
        </>
      }
    >
      <Form method="post" className="flex flex-col gap-5">
        <input type="hidden" name="next" value={loaderData.next} />
        <AuthField name="email" label={t('account.emailLabel')} type="email" autoComplete="email" />
        <AuthField name="password" label={t('account.passwordLabel')} type="password" autoComplete="current-password" />
        {actionData?.status === 'invalid-email' && <AuthNotice>{t('account.invalidEmail')}</AuthNotice>}
        {actionData?.status === 'failed' && <AuthNotice>{t('account.signInFailed')}</AuthNotice>}
        <Button type="submit">{t('account.signInAction')}</Button>
      </Form>

      <div className="flex flex-col gap-2 border-t pt-5 text-sm text-muted-foreground">
        <Link to="/forgot-password" className="underline underline-offset-4 hover:text-foreground">
          {t('account.forgotAction')}
        </Link>
        {/* No standing "resend" link. A reader who never confirmed reaches the
            resend form by signing in with the right password, which is both
            fewer steps and the only version that knows the address already. */}
      </div>
    </AuthCard>
  );
}
