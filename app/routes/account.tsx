/**
 * `/account`: the address, the password, the export, the door out.
 *
 * ANONYMOUS IS A NORMAL STATE HERE, and this screen reports it rather than
 * ending it. Its loader never redirects, which is what lets the shell link to
 * it from every screen and what lets a signed-out reader still export the data
 * their own device holds.
 *
 * WHAT LEFT THIS SCREEN IN M191. The sign-in name, the device list, the
 * recovery code and the "resume syncing" unlock card were all parts of the
 * encrypted account. There is no key to unlock, no device to revoke and no
 * recovery code to lose: an address and a password replaced all four, and a
 * forgotten password is a mailed link now rather than a dead account.
 *
 * CHANGING THE PASSWORD KEEPS THIS TAB SIGNED IN. `changePassword` moves the
 * session epoch, which refuses every cookie issued before it, this request's
 * included, and hands back a fresh one. Setting that cookie is not optional.
 *
 * DELETING ASKS FOR THE PASSWORD, in the same form. It replaced a type-to-
 * confirm dialog, which asks whether the person meant it; the password asks
 * whether they are the owner.
 */
import { Form, redirect, type MetaFunction } from 'react-router';
import { useTranslation } from 'react-i18next';

import type { Route } from './+types/account';
import { AuthCard, AuthField, AuthNotice } from '#app/components/account/auth-card';
import { ExportDataButton } from '#app/components/account/export-data-button';
import { Button, buttonVariants } from '#app/components/ui/button';
import { Link } from '#app/components/link';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { MIN_PASSWORD_LENGTH } from '#app/lib/auth/password-rule';
import { SIGN_IN_PATH, SIGN_UP_PATH } from '#app/lib/auth/paths';
import { changePassword, deleteAccount } from '#app/services/auth.server';
import { resolveUser } from '#app/middleware/auth';

export const meta: MetaFunction = ({ matches }) => [{ title: metaTitle(metaLanguage(matches), 'account.metaTitle') }];

/** What a post to this screen can report. Each member carries one literal, so each narrows on its own. */
type AccountResult =
  | { status: 'wrong-password' }
  | { status: 'invalid-password' }
  | { status: 'password-mismatch' };

/** Anonymous is a NORMAL state here: this screen reports it rather than ending it. */
export async function loader({ request }: Route.LoaderArgs): Promise<{ email: string | null; changed: boolean }> {
  const user = await resolveUser(request);
  // The confirmation after a password change survives the redirect that hands
  // the fresh cookie over. A flash message in the session would be the other
  // way, and it would have to be written into the very cookie this redirect is
  // replacing.
  return { email: user?.email ?? null, changed: new URL(request.url).searchParams.get('changed') === '1' };
}

export async function action({ request }: Route.ActionArgs): Promise<Response | AccountResult> {
  const user = await resolveUser(request);
  if (user === null) throw redirect(SIGN_IN_PATH);

  const form = await request.formData();

  if (String(form.get('intent') ?? '') === 'delete') {
    const removed = await deleteAccount({ userId: user.id, password: String(form.get('deleteCurrent') ?? '') });
    if (removed.status === 'wrong-password') return { status: 'wrong-password' };
    // The account is gone, so the cookie names nobody. `/sign-out` would be
    // the tidier destination, but it needs a session to sync one last time and
    // there is nothing left to sync to.
    throw redirect('/');
  }

  const next = String(form.get('next') ?? '');
  if (next !== String(form.get('nextConfirm') ?? '')) return { status: 'password-mismatch' };

  const result = await changePassword({
    userId: user.id,
    current: String(form.get('current') ?? ''),
    next,
    request,
  });
  if (result.status !== 'ok') return { status: result.status };

  // The fresh cookie is what keeps THIS tab signed in: the change moved the
  // session epoch, so every older cookie, this request's included, is refused
  // from now on.
  return redirect('/account?changed=1', { headers: { 'Set-Cookie': result.setCookie } });
}

export default function AccountRoute({ loaderData, actionData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { email, changed } = loaderData;

  if (email === null) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <AuthCard title={t('account.title')} headingLevel="h2" description={t('account.signedOutBody')}>
          <div className="flex flex-wrap items-center gap-4">
            <Link to={SIGN_UP_PATH} className={buttonVariants()}>
              {t('account.createAction')}
            </Link>
            <Link to={SIGN_IN_PATH} className="text-sm underline underline-offset-4 hover:text-foreground">
              {t('account.signInAction')}
            </Link>
          </div>
        </AuthCard>
        {/* NO EXPORT CARD FOR A SIGNED-OUT READER, and it is not a feature
            being withheld. Every screen that writes to the device is gated, so
            somebody without an account has nothing on it to export, and
            somebody who just signed out had it wiped. What the card is not free
            of is a side effect: the check it runs on mount OPENS
            `translate-primary` in IndexedDB, which re-creates the database
            sign-out just deleted. */}
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <section className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('account.title')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('account.signedInBody')}</p>
        <p className="mt-4 font-mono text-sm">{email}</p>
      </section>

      <section className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('account.changePasswordTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('account.changePasswordBody')}</p>
        <Form method="post" className="mt-6 flex flex-col gap-5">
          <AuthField
            name="current"
            label={t('account.currentPasswordLabel')}
            type="password"
            autoComplete="current-password"
          />
          <AuthField
            name="next"
            label={t('account.newPasswordLabel')}
            type="password"
            autoComplete="new-password"
            hint={t('account.passwordHint')}
          />
          <AuthField
            name="nextConfirm"
            label={t('account.passwordConfirmLabel')}
            type="password"
            autoComplete="new-password"
          />
          {actionData?.status === 'password-mismatch' && <AuthNotice>{t('account.passwordMismatch')}</AuthNotice>}
          {actionData?.status === 'wrong-password' && <AuthNotice>{t('account.wrongPassword')}</AuthNotice>}
          {actionData?.status === 'invalid-password' && (
            <AuthNotice>{t('account.passwordTooShort', { min: MIN_PASSWORD_LENGTH })}</AuthNotice>
          )}
          {changed && actionData === undefined && (
            <p className="text-sm text-muted-foreground">{t('account.changePasswordDone')}</p>
          )}
          <Button type="submit" className="self-start">
            {t('account.changePasswordSubmit')}
          </Button>
        </Form>
      </section>

      <ExportCard />

      <section className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('account.signOutTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('account.signOutBody')}</p>
        {/* Posts to `/sign-out`, which syncs once and then empties this device.
            The wipe is why the sentence above warns rather than reassures. */}
        <Form method="post" action="/sign-out" className="mt-4">
          <Button type="submit" variant="outline">
            {t('account.signOutAction')}
          </Button>
        </Form>
      </section>

      <section className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('account.deleteTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('account.deleteBody')}</p>
        <Form method="post" className="mt-6 flex flex-col gap-5">
          <input type="hidden" name="intent" value="delete" />
          <AuthField
            name="deleteCurrent"
            label={t('account.currentPasswordLabel')}
            type="password"
            autoComplete="current-password"
          />
          <Button type="submit" variant="destructive" className="self-start">
            {t('account.deleteSubmit')}
          </Button>
        </Form>
      </section>
    </div>
  );
}

/** The export, which works signed in and signed out alike: it reads this device, never the server. */
function ExportCard() {
  const { t } = useTranslation();

  return (
    <section className="rounded-xl border bg-card p-6">
      <h2 className="font-display text-base font-semibold">{t('account.exportTitle')}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t('account.exportBody')}</p>
      <div className="mt-4">
        <ExportDataButton />
      </div>
    </section>
  );
}
