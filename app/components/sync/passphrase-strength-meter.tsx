import { useTranslation } from 'react-i18next';
import { passphraseStrengthKey, ratePassphrase } from '#app/lib/e2ee/flows/passphrase-strength';
import { cn } from '#app/lib/utils';

/**
 * The live strength hint under the passphrase field.
 *
 * Three bands, exactly the three `ratePassphrase` can return, and the label
 * comes from `passphraseStrengthKey` rather than from a lookup table written
 * here. A second table would be a second thing to keep in step, and the way it
 * would fail is quiet: an unmapped band renders its own raw key, which reads
 * as a plausible word and nobody files a bug about it. There is no `?? key`
 * fallback for the same reason, a missing translation must be a visible hole.
 *
 * It is a HINT and never a gate. The hard floor is `validateSyncPassphrase`,
 * and this widget refuses nothing: a meter that blocks pushes people towards
 * whatever pattern satisfies it rather than towards length.
 */
const FILLED_SEGMENTS = { weak: 1, fair: 2, strong: 3 } as const;
const TOTAL_SEGMENTS = 3;

export function PassphraseStrengthMeter({ passphrase }: { passphrase: string }) {
  const { t } = useTranslation();
  const strength = ratePassphrase(passphrase);
  const filled = FILLED_SEGMENTS[strength];

  return (
    <div className="mt-2 flex items-center gap-3">
      <div className="flex flex-1 gap-1" aria-hidden="true">
        {Array.from({ length: TOTAL_SEGMENTS }, (_, index) => (
          <span
            key={index}
            className={cn('h-1 flex-1 rounded-full', index < filled ? 'bg-primary' : 'bg-muted')}
          />
        ))}
      </div>
      <span className="text-xs text-muted-foreground">{t(passphraseStrengthKey(strength))}</span>
    </div>
  );
}
