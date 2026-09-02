import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { Loader2 } from 'lucide-react';
import { Button } from '#app/components/ui/button';
import { Input } from '#app/components/ui/input';
import { Label } from '#app/components/ui/label';
import { signInToSync } from '#app/components/sync/sync-client';
import { setSyncSession } from '#app/lib/sync/sync-session';
import { classifySignInFailure } from '#app/lib/e2ee/flows/sign-in-error';
import { reportError } from '#app/lib/report-error';

/**
 * The second-device sign-in.
 *
 * ── One message for every rejection, deliberately ────────────────────────
 *
 * The service answers a single `401` for an unknown handle and for a wrong
 * passphrase, after identical work, so that this form cannot be used to ask
 * whether a handle is registered. Saying "no such handle" here would rebuild
 * that oracle in the browser out of a status code the protocol went to
 * trouble to make uninformative. `classifySignInFailure` is what reads the
 * status, so the branching lives in one place and never in a string match on
 * the service's prose.
 *
 * The passphrase is stretched in a Worker and only the derived hash is sent.
 * There is no `<Form method="post">` on this screen for that reason: an action
 * runs on the server, and a passphrase in a form body is a passphrase the
 * operator receives.
 */
export function SyncLoginForm() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [handle, setHandle] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (isWorking) return;

    setError(null);
    setIsWorking(true);
    try {
      const session = await signInToSync({ handle, passphrase });
      // Before the navigation. The DEK lives in memory only, so a route change
      // that happened first would leave the sync engine with no key.
      setSyncSession(session);
      await navigate('/settings');
    } catch (cause) {
      const failure = classifySignInFailure(cause);
      // A `rejected` is a wrong handle or a wrong passphrase, which is a normal
      // outcome and not something to log: reporting every one of them would
      // bury the failures that matter under ordinary typing mistakes. Anything
      // else is unexpected and gets reported, with a fixed payload that carries
      // neither the handle nor the passphrase.
      if (failure !== 'rejected') reportError(cause, { operation: 'sync-login', step: 'signInToSync' });
      setError(failure === 'rejected' ? t('sync.loginFailed') : t('sync.genericError'));
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
      <div className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('sync.loginTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('sync.loginBody')}</p>

        <div className="mt-4 flex flex-col gap-2">
          <Label htmlFor="sync-handle">{t('sync.loginHandleLabel')}</Label>
          <Input
            id="sync-handle"
            className="font-mono tracking-wider"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
          />
        </div>

        <div className="mt-4 flex flex-col gap-2">
          <Label htmlFor="sync-login-passphrase">{t('sync.loginPassphraseLabel')}</Label>
          <Input
            id="sync-login-passphrase"
            type="password"
            autoComplete="current-password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
          />
        </div>

        {error !== null && (
          <p className="mt-4 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <Button type="submit" className="mt-6 w-full sm:w-auto" disabled={isWorking}>
          {isWorking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isWorking ? t('sync.workingLabel') : t('sync.loginSubmitAction')}
        </Button>
      </div>
    </form>
  );
}
