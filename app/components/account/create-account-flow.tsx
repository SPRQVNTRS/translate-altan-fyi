import { useReducer, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { Loader2 } from 'lucide-react';
import { Button } from '#app/components/ui/button';
import { Input } from '#app/components/ui/input';
import { Label } from '#app/components/ui/label';
import { CopyButton } from '#app/components/account/copy-button';
import { PasswordStrengthMeter } from '#app/components/account/password-strength-meter';
import { createSyncAccount } from '#app/components/account/sync-client';
import { classifySignupFailure } from '#app/lib/e2ee/flows/signup-error';
import { setSyncSession } from '#app/lib/sync/sync-session';
import { reportError } from '#app/lib/report-error';
import {
  initialSyncSetupState,
  syncSetupReducer,
  validatePassword,
} from '#app/lib/e2ee/flows/setup-flow';

/**
 * Creating the account: TWO screens, driven by `syncSetupReducer`.
 *
 * ── What the user sees ───────────────────────────────────────────────────
 *
 * 1. The invite code, a password and its repeat, and one button.
 * 2. "Your account is ready": the sign-in name and the recovery code, side by
 *    side on one card, behind one confirmation.
 *
 * It used to be four, with the sign-in name and the recovery code revealed on
 * screens of their own. Two separate reveals are how a person saves the code
 * and never registers that the name is equally required to get back in: the
 * second value reads as an afterthought. One card, one sentence about what
 * losing them costs, one checkbox.
 *
 * ── What holds the flow together ─────────────────────────────────────────
 *
 * The reducer owns every transition. This component is its imperative shell:
 * it collects the fields, calls the browser-side crypto, and dispatches the
 * outcome. It never decides on its own that setup is finished, which matters
 * because the last transition is a security rule and not a navigation step:
 * the reducer will not leave `show-account-card` unless `hasConfirmedSaved` is
 * true.
 *
 * The password and the two field values are plain `useState` because they are
 * FIELD CONTENTS, not flow states. None of them can advance a screen.
 */
export function CreateAccountFlow({ invite }: { invite: string | null }) {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(syncSetupReducer, undefined, () => initialSyncSetupState());
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  // The invite, or the operator's one-shot bootstrap token. ONE field for both,
  // because the service accepts them in the same place and a person holding a
  // string of characters has no way to tell you which kind they were given.
  //
  // SEEDED FROM THE CALLER, then from the URL. The route reads its own loader
  // data and hands it down as `invite`; the search param is the fallback for a
  // link opened on a surface that does not, so a code that arrived as
  // `?invite=…` is never silently dropped. Plain `useState` like the others: it
  // is a field's contents, not a state of the flow.
  const [inviteToken, setInviteToken] = useState(() => invite ?? searchParams.get('invite') ?? '');

  const handleDetailsSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    // Guards first, in the order that gives the most useful sentence: a
    // password that fails the floor is told so even when the repeat field is
    // also empty.
    const tooShort = validatePassword(password, t);
    if (tooShort !== null) {
      dispatch({ type: 'detailsRejected', message: tooShort });
      return;
    }
    if (password !== passwordConfirmation) {
      dispatch({ type: 'detailsRejected', message: t('account.passwordMismatch') });
      return;
    }

    dispatch({ type: 'detailsSubmitted' });
    try {
      // TRIMMED HERE, ONCE. A code copied out of a chat message arrives with a
      // space or a newline around it more often than not, and a service that
      // hashes what it is given cannot forgive one. This is the only place the
      // token is touched between the field and the request body.
      const account = await createSyncAccount({ passphrase: password, inviteToken: inviteToken.trim() });
      // Before the screen advances, and before anything can navigate away. The
      // DEK exists only in memory, so the sync engine has to be handed it in
      // the same turn that produced it.
      setSyncSession({ accountId: account.accountId, dek: account.dek });
      dispatch({ type: 'setupSucceeded', handle: account.handle, recoveryCode: account.recoveryCode });
    } catch (cause) {
      // REPORTED, then shown. A bare `catch {}` here discarded the cause
      // entirely, and a client-side schema that disagreed with the service cost
      // a browser session to diagnose because the only evidence was one
      // translated sentence on screen. The seam is the app-wide reporter, which
      // is client-safe and never throws.
      //
      // THE PAYLOAD IS A FIXED LITERAL, and that is a security constraint, not
      // tidiness: the password, the recovery code, the sign-in name and every
      // key derived from them are in scope right here, and not one of them may
      // reach a log line. Only the operation's name and the failing step go.
      reportError(cause, { operation: 'create-account', step: 'createSyncAccount' });
      // TWO SENTENCES NOW, AND THE SECOND ONE IS THE COMMON CASE. A refused
      // invite is what most failures here will be on an invite-only instance,
      // and "something went wrong, please try again" would send a person
      // retrying a code that can never work. The classifier owns the mapping
      // from status to meaning, and it is given `'invite'` rather than `null`
      // because this deployment IS invite-only by construction: see the same
      // argument in `sync-client.ts`'s `signUp`.
      //
      // THE SERVICE'S OWN PROSE IS STILL NEVER SHOWN. It is untranslated, and
      // §5.8.1 makes every bad invite one indistinguishable answer on purpose,
      // so there is nothing in it worth rendering. The cause goes to the
      // reporter, the reader gets a catalogue sentence.
      const failure = classifySignupFailure(cause, 'invite');
      const message = failure === 'invite-required' ? t('account.inviteRejected') : t('sync.genericError');
      dispatch({ type: 'setupFailed', message });
    }
  };

  if (state.kind === 'enter-details') {
    return (
      <form className="flex flex-col gap-6" onSubmit={handleDetailsSubmit}>
        <div className="flex flex-col gap-4 rounded-xl border bg-card p-6">
          {/* THE INVITE, ABOVE THE PASSWORD. It is the first thing a person was
              given and the first thing this instance asks for, and a field for
              it below the password would be read after the reader had already
              decided the form was about a password. `type="text"`, not
              `password`: a code that cannot be seen cannot be checked against
              the message it was copied from, and it is a one-time admission
              ticket rather than a standing credential. `autoComplete="off"` for
              the same reason. */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="account-invite">{t('account.inviteLabel')}</Label>
            <Input
              id="account-invite"
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className="font-mono"
              value={inviteToken}
              onChange={(event) => setInviteToken(event.target.value)}
            />
            <p className="text-sm text-muted-foreground">{t('account.inviteHint')}</p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="account-password">{t('account.passwordLabel')}</Label>
            <Input
              id="account-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <PasswordStrengthMeter password={password} />
            <p className="text-sm text-muted-foreground">{t('account.passwordHint')}</p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="account-password-confirm">{t('account.passwordConfirmLabel')}</Label>
            <Input
              id="account-password-confirm"
              type="password"
              autoComplete="new-password"
              value={passwordConfirmation}
              onChange={(event) => setPasswordConfirmation(event.target.value)}
            />
          </div>

          {state.error !== null && (
            <p className="text-sm text-destructive" role="alert">
              {state.error}
            </p>
          )}

          <Button type="submit" className="w-full sm:w-auto sm:self-start">
            {t('account.createAction')}
          </Button>
        </div>
      </form>
    );
  }

  if (state.kind === 'generating') {
    return <WorkingCard label={t('account.workingLabel')} />;
  }

  if (state.kind === 'error') {
    return (
      <div className="rounded-xl border bg-card p-6">
        <p className="text-sm text-destructive" role="alert">
          {state.message}
        </p>
        <Button type="button" className="mt-4" onClick={() => dispatch({ type: 'retried' })}>
          {t('account.retryAction')}
        </Button>
      </div>
    );
  }

  if (state.kind === 'complete') {
    // THE INSTANT BEFORE THE NAVIGATION, AND NOTHING MORE. "Done" dispatches
    // and navigates in the same handler, so this card is what the reader sees
    // while the router changes route. It used to be the END of the flow, which
    // left the finished account sitting on `/sign-up` under a stale "Create
    // account" heading: the screen said the account was ready and the page
    // around it still asked for one.
    return (
      <div className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('account.completeTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('account.completeBody')}</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-6">
      <h2 className="font-display text-base font-semibold">{t('account.readyTitle')}</h2>

      <div className="mt-4 flex flex-col gap-2">
        <p className="text-sm font-medium">{t('account.handleLabel')}</p>
        <p className="rounded-lg bg-muted px-3 py-2 font-mono text-base tracking-wider break-all">{state.handle}</p>
        <CopyButton
          value={state.handle}
          label={t('account.copyNameAction')}
          copiedLabel={t('account.copiedLabel')}
        />
      </div>

      <div className="mt-4 flex flex-col gap-2">
        <p className="text-sm font-medium">{t('account.recoveryCodeLabel')}</p>
        <p className="rounded-lg bg-muted px-3 py-2 font-mono text-base tracking-wider break-all">
          {state.recoveryCode}
        </p>
        <CopyButton
          value={state.recoveryCode}
          label={t('account.copyCodeAction')}
          copiedLabel={t('account.copiedLabel')}
        />
      </div>

      <p className="mt-4 text-sm text-muted-foreground">{t('account.readyBody')}</p>

      {/* The gate. A checkbox rather than a retyped code, which is what the
          upstream ceremony settled on: the retype tested typing accuracy, and
          the thing that has to be tested is that the person has a copy at all.
          The button below is disabled until this is ticked, and the reducer
          re-checks the flag so no ordering of clicks can skip it. */}
      <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-1 accent-primary"
          checked={state.hasConfirmedSaved}
          onChange={(event) => dispatch({ type: 'confirmSavedToggled', checked: event.target.checked })}
        />
        <span>{t('account.confirmSaved')}</span>
      </label>

      <Button
        type="button"
        className="mt-4 w-full sm:w-auto"
        disabled={!state.hasConfirmedSaved}
        onClick={() => {
          // THE REDUCER STILL DECIDES WHETHER THE FLOW MAY END. It re-checks
          // `hasConfirmedSaved`, so the navigation below follows a transition
          // rather than replacing it.
          dispatch({ type: 'finishRequested' });
          // HOME, BECAUSE THERE IS NO RETURN TARGET TO HONOUR. Nothing in this
          // app carries one: a gated screen redirects to `/sign-in` without
          // recording where the reader came from, and `SignInForm` lands on a
          // fixed route too. If a return path is ever added there, it belongs
          // here as well, and this is the line that reads it.
          void navigate('/');
        }}
      >
        {t('account.doneAction')}
      </Button>
    </div>
  );
}

/** The pending state every Argon2id call shows. Nothing the user triggered may look frozen. */
function WorkingCard({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card p-6" aria-live="polite">
      <Loader2 className="h-4 w-4 animate-spin text-primary" />
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
