import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { Loader2 } from 'lucide-react';
import { Button } from '#app/components/ui/button';
import { Input } from '#app/components/ui/input';
import { Label } from '#app/components/ui/label';
import { signInToSync } from '#app/components/account/sync-client';
import { setSyncSession } from '#app/lib/sync/sync-session';
import { classifySignInFailure } from '#app/lib/e2ee/flows/sign-in-error';
import { reportError } from '#app/lib/report-error';

/**
 * Signing in to an existing account, on this device.
 *
 * ── One message for every rejection, deliberately ────────────────────────
 *
 * The service answers a single `401` for an unknown sign-in name and for a
 * wrong password, after identical work, so that this form cannot be used to ask
 * whether a name is registered. Saying "no such name" here would rebuild
 * that oracle in the browser out of a status code the protocol went to
 * trouble to make uninformative. `classifySignInFailure` is what reads the
 * status, so the branching lives in one place and never in a string match on
 * the service's prose.
 *
 * The password is stretched in a Worker and only the derived hash is sent.
 * There is no `<Form method="post">` on this screen for that reason: an action
 * runs on the server, and a password in a form body is a password the operator
 * receives.
 */
export function SignInForm() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [handle, setHandle] = useState('');
  const [password, setPassword] = useState('');
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (isWorking) return;

    setError(null);
    setIsWorking(true);
    try {
      const session = await signInToSync({ handle, passphrase: password });
      // Before the navigation. The DEK lives in memory only, so a route change
      // that happened first would leave the sync engine with no key.
      setSyncSession(session);
      await navigate('/settings');
    } catch (cause) {
      const failure = classifySignInFailure(cause);
      // A `rejected` is a wrong name or a wrong password, which is a normal
      // outcome and not something to log: reporting every one of them would
      // bury the failures that matter under ordinary typing mistakes. Anything
      // else is unexpected and gets reported, with a fixed payload that carries
      // neither the name nor the password.
      if (failure !== 'rejected') reportError(cause, { operation: 'sign-in', step: 'signInToSync' });
      setError(failure === 'rejected' ? t('account.signInFailed') : t('sync.genericError'));
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
      <div className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('account.signInTitle')}</h2>

        <div className="mt-4 flex flex-col gap-2">
          <Label htmlFor="account-handle">{t('account.handleLabel')}</Label>
          <Input
            id="account-handle"
            className="font-mono tracking-wider"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
          />
        </div>

        <div className="mt-4 flex flex-col gap-2">
          <Label htmlFor="account-password">{t('account.passwordLabel')}</Label>
          <Input
            id="account-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        {error !== null && (
          <p className="mt-4 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <Button type="submit" className="mt-6 w-full sm:w-auto" disabled={isWorking}>
          {isWorking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isWorking ? t('account.workingLabel') : t('account.signInAction')}
        </Button>

        {/* The only other thing on this screen. Somebody who has no account
            cannot sign in to one, and the shortest honest answer is a link
            rather than a paragraph explaining invites. */}
        <p className="mt-4 text-sm text-muted-foreground">
          {t('account.noAccountPrompt')}{' '}
          <Link to="/sign-up" className="underline underline-offset-4">
            {t('account.createAction')}
          </Link>
        </p>
      </div>
    </form>
  );
}
