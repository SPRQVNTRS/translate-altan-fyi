import { useReducer, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '#app/components/ui/button';
import { Input } from '#app/components/ui/input';
import { Label } from '#app/components/ui/label';
import { CopyButton } from '#app/components/sync/copy-button';
import { PassphraseStrengthMeter } from '#app/components/sync/passphrase-strength-meter';
import { isRecoveryCodeConfirmed } from '#app/components/sync/recovery-confirmation';
import { createSyncAccount } from '#app/components/sync/sync-client';
import {
  initialSyncSetupState,
  syncSetupReducer,
  validateSyncPassphrase,
} from '#app/lib/e2ee/flows/setup-flow';

/**
 * The sync setup ceremony: one screen at a time, driven by
 * `syncSetupReducer`.
 *
 * ── What holds the flow together ─────────────────────────────────────────
 *
 * The reducer owns every transition. This component is its imperative shell:
 * it collects the fields, calls the browser-side crypto, and dispatches the
 * outcome. It never decides on its own that setup is finished, which matters
 * because the last transition is a security rule and not a navigation step.
 *
 * ── The account card is three cards ──────────────────────────────────────
 *
 * `show-account-card` carries the handle AND the recovery code, and the copy
 * presents them as separate steps with a confirmation after them. `cardStep`
 * is that presentation cursor and nothing more. It cannot reach the finish:
 * completion goes through the reducer, which will not leave
 * `show-account-card` unless `hasConfirmedSaved` is true, and the only thing
 * that sets `hasConfirmedSaved` is a correctly retyped code. Moving the cursor
 * is therefore free, and no ordering of clicks in here can skip the gate.
 *
 * The passphrase, the two field values and the retyped code are plain
 * `useState` because they are FIELD CONTENTS, not flow states. None of them
 * can advance a screen.
 */
export function SyncSetupFlow() {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(syncSetupReducer, undefined, () => initialSyncSetupState());
  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirmation, setPassphraseConfirmation] = useState('');
  const [cardStep, setCardStep] = useState<'handle' | 'recovery' | 'confirm'>('handle');
  const [typedCode, setTypedCode] = useState('');
  const [hasMismatch, setHasMismatch] = useState(false);

  const handleDetailsSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    // Guards first, in the order that gives the most useful sentence: a
    // passphrase that fails the floor is told so even when the confirmation
    // field is also empty.
    const tooShort = validateSyncPassphrase(passphrase, t);
    if (tooShort !== null) {
      dispatch({ type: 'detailsRejected', message: tooShort });
      return;
    }
    if (passphrase !== passphraseConfirmation) {
      dispatch({ type: 'detailsRejected', message: t('sync.passphraseMismatch') });
      return;
    }

    dispatch({ type: 'detailsSubmitted' });
    try {
      const account = await createSyncAccount({ passphrase });
      dispatch({ type: 'setupSucceeded', handle: account.handle, recoveryCode: account.recoveryCode });
    } catch {
      // One sentence for every failure, because the catalog holds one. The
      // cause is not shown: a service's own prose is untranslated, and the
      // statuses that would deserve their own sentence (an invite-only
      // instance, a closed one) have no copy written for them yet.
      dispatch({ type: 'setupFailed', message: t('sync.genericError') });
    }
  };

  const handleConfirmSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (state.kind !== 'show-account-card') return;

    const isConfirmed = isRecoveryCodeConfirmed({ typed: typedCode, expected: state.recoveryCode });
    setHasMismatch(!isConfirmed);
    // BOTH dispatches, always. A wrong entry must also CLEAR a previously
    // granted confirmation, so a user cannot type the code once, edit it into
    // something else, and finish on the stale flag.
    dispatch({ type: 'confirmSavedToggled', checked: isConfirmed });
    dispatch({ type: 'finishRequested' });
  };

  if (state.kind === 'enter-details') {
    return (
      <form className="flex flex-col gap-6" onSubmit={handleDetailsSubmit}>
        <div className="rounded-xl border bg-card p-6">
          <h2 className="font-display text-base font-semibold">{t('sync.introTitle')}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t('sync.introBody')}</p>
        </div>

        <div className="flex flex-col gap-4 rounded-xl border bg-card p-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="sync-passphrase">{t('sync.passphraseLabel')}</Label>
            <Input
              id="sync-passphrase"
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
            <PassphraseStrengthMeter passphrase={passphrase} />
            <p className="text-sm text-muted-foreground">{t('sync.passphraseHint')}</p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="sync-passphrase-confirm">{t('sync.passphraseConfirmLabel')}</Label>
            <Input
              id="sync-passphrase-confirm"
              type="password"
              autoComplete="new-password"
              value={passphraseConfirmation}
              onChange={(event) => setPassphraseConfirmation(event.target.value)}
            />
          </div>

          {state.error !== null && (
            <p className="text-sm text-destructive" role="alert">
              {state.error}
            </p>
          )}

          <Button type="submit" className="w-full sm:w-auto sm:self-start">
            {t('sync.continueAction')}
          </Button>
        </div>
      </form>
    );
  }

  if (state.kind === 'generating') {
    return <WorkingCard label={t('sync.workingLabel')} />;
  }

  if (state.kind === 'error') {
    return (
      <div className="rounded-xl border bg-card p-6">
        <p className="text-sm text-destructive" role="alert">
          {state.message}
        </p>
        <Button type="button" className="mt-4" onClick={() => dispatch({ type: 'retried' })}>
          {t('sync.continueAction')}
        </Button>
      </div>
    );
  }

  if (state.kind === 'complete') {
    return (
      <div className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('sync.doneTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('sync.doneBody')}</p>
      </div>
    );
  }

  if (cardStep === 'handle') {
    return (
      <div className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('sync.handleTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('sync.handleBody')}</p>
        <p className="mt-4 rounded-lg bg-muted px-3 py-2 font-mono text-base tracking-wider break-all">{state.handle}</p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <CopyButton value={state.handle} label={t('sync.handleCopyAction')} copiedLabel={t('sync.handleCopied')} />
          <Button type="button" onClick={() => setCardStep('recovery')}>
            {t('sync.continueAction')}
          </Button>
        </div>
      </div>
    );
  }

  if (cardStep === 'recovery') {
    return (
      <div className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('sync.recoveryTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('sync.recoveryBody')}</p>
        <p className="mt-4 rounded-lg bg-muted px-3 py-2 font-mono text-base tracking-wider break-all">
          {state.recoveryCode}
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <CopyButton value={state.recoveryCode} label={t('sync.recoveryCopyAction')} />
          <Button type="button" onClick={() => setCardStep('confirm')}>
            {t('sync.recoveryContinueAction')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form className="rounded-xl border bg-card p-6" onSubmit={handleConfirmSubmit}>
      <h2 className="font-display text-base font-semibold">{t('sync.confirmTitle')}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t('sync.confirmBody')}</p>
      <div className="mt-4 flex flex-col gap-2">
        <Label htmlFor="sync-recovery-confirm">{t('sync.confirmLabel')}</Label>
        <Input
          id="sync-recovery-confirm"
          className="font-mono tracking-wider"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          value={typedCode}
          onChange={(event) => setTypedCode(event.target.value)}
        />
      </div>
      {hasMismatch && (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {t('sync.confirmMismatch')}
        </p>
      )}
      <Button type="submit" className="mt-4 w-full sm:w-auto">
        {t('sync.confirmFinishAction')}
      </Button>
    </form>
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
