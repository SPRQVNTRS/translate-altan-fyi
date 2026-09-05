import type { ReactElement } from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '#app/components/ui/button';
import { useInstallPrompt } from '#app/hooks/use-install-prompt';

/**
 * The install card on the settings screen. Renders nothing when there is
 * nothing to offer.
 *
 * WHY IT IS A CARD AND NOT A BUTTON. Two of its three states show nothing at
 * all or nothing clickable, so a caller placing a heading and a paragraph
 * around a bare control would leave an empty card behind on most devices. The
 * whole section is therefore this component's to render or to withhold.
 *
 * THE THREE STATES, AND WHY EACH LOOKS LIKE IT DOES.
 *   `ready` is the only one with a button, and it exists only once a real
 *   `beforeinstallprompt` event is in hand. A button that cannot install is
 *   worse than no button.
 *
 *   `manual` is iOS. There is no install API on that platform, so the only
 *   honest thing to render is the sentence describing the Share menu. A dead
 *   button would be a lie about what tapping it does.
 *
 *   `unavailable` renders nothing, which covers a browser with no installation
 *   support, an app already installed, and the moment after an install
 *   finishes. A disabled control explaining that this browser cannot install
 *   anything is a paragraph nobody came to Settings to read.
 *
 * The detection itself is `useInstallPrompt`, shared with the navigation row,
 * so the card and the row can never disagree about this device.
 */
export function InstallApp(): ReactElement | null {
  const { t } = useTranslation();
  const offer = useInstallPrompt();

  if (offer.kind === 'unavailable') return null;

  return (
    <div className="rounded-xl border bg-card p-6">
      <h2 className="font-display text-base font-semibold">{t('settings.installTitle')}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t('settings.installBody')}</p>
      {offer.kind === 'manual' && <p className="mt-4 text-sm">{t('settings.installIosStep')}</p>}
      {offer.kind === 'ready' && (
        <div className="mt-4">
          <Button type="button" onClick={offer.install}>
            <Download className="size-4" aria-hidden="true" />
            {t('settings.installAction')}
          </Button>
        </div>
      )}
    </div>
  );
}
