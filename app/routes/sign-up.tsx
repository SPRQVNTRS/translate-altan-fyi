import { Form, redirect, type MetaFunction } from 'react-router';
import { useTranslation } from 'react-i18next';

import type { Route } from './+types/sign-up';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { requestT } from '#app/i18n/request-t';
import type { TitleHandle } from '#app/lib/route-title';
import { registerUser } from '#app/services/auth.server';
import { resolveUser } from '#app/middleware/auth';

export const meta: MetaFunction = ({ matches }) => [
  { title: metaTitle(metaLanguage(matches), 'account.createMetaTitle') },
];

export const handle = { titleKey: 'account.createMetaTitle' } satisfies TitleHandle;

/** A reader who already holds an account is answering a finished question, so they go to it. */
export async function loader({ request }: Route.LoaderArgs): Promise<null> {
  if ((await resolveUser(request)) !== null) throw redirect('/account');
  return null;
}

/**
 * Creates the account and mails the confirmation link.
 *
 * IT SAYS THE SAME SENTENCE FOR A KNOWN AND AN UNKNOWN ADDRESS.
 * `registerUser` decides that; this action only renders what it returns.
 */
export async function action({ request }: Route.ActionArgs): Promise<{ status: string }> {
  const form = await request.formData();
  const result = await registerUser({
    email: String(form.get('email') ?? ''),
    password: String(form.get('password') ?? ''),
    mail: { t: requestT(request), origin: new URL(request.url).origin },
  });
  return { status: result.status };
}

/** Minimal by design: spec 03 replaces this screen with the real one. */
export default function SignUpRoute({ actionData }: Route.ComponentProps) {
  const { t } = useTranslation();
  if (actionData?.status === 'mailed') return <p>Check your inbox for the confirmation link.</p>;

  return (
    <Form method="post" className="mx-auto flex w-full max-w-md flex-col gap-3">
      <label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" required autoComplete="email" />
      <label htmlFor="password">{t('account.passwordLabel')}</label>
      <input id="password" name="password" type="password" required autoComplete="new-password" />
      {actionData?.status === 'invalid-password' && <p>{t('account.passwordTooShort', { min: 10 })}</p>}
      <button type="submit">{t('account.createAction')}</button>
    </Form>
  );
}
