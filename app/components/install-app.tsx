import { useEffect, useState, type ReactElement } from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '#app/components/ui/button';
import { reportError } from '#app/lib/report-error';

/**
 * The install prompt Chromium browsers hand the page, as the members used here.
 *
 * IT IS DECLARED BECAUSE `lib.dom` DOES NOT CARRY IT. `beforeinstallprompt` is
 * a Chromium extension to the platform rather than a standard event, so no
 * ambient type exists for it. Naming only `preventDefault`, `prompt` and
 * `userChoice` keeps this declaration a statement about what the code depends
 * on, not a guess at the browser's full object.
 */
interface BeforeInstallPromptEvent {
  /** Stops the browser showing its own mini-infobar, so the page owns the moment. */
  preventDefault(): void;
  /** Opens the browser's install dialog. One event may do this ONCE. */
  prompt(): Promise<void>;
  /** Settles once the reader has answered the dialog. */
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * The event map augmentation is what makes `addEventListener` hand back the
 * type above with no assertion at the call site. Narrowing a plain `Event` with
 * `in` checks would not do it: `in` produces an intersection that still is not
 * this interface, so the narrowing would end in the cast it was meant to avoid.
 */
declare global {
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }
}

/** What this device can be offered, if anything. */
type InstallState =
  | { kind: 'unavailable' }
  | { kind: 'manual' }
  | { kind: 'ready'; event: BeforeInstallPromptEvent };

/**
 * Whether the app is already running as an installed app.
 *
 * TWO CHECKS, BECAUSE iOS ANSWERS A DIFFERENT QUESTION. Every browser that
 * supports installation reports the standalone display mode through
 * `matchMedia`. iOS Safari reports it through `navigator.standalone`, which is
 * non-standard and therefore absent from `lib.dom`, so it is read through the
 * accessor below rather than through a cast.
 */
function isInstalled(): boolean {
  if (globalThis.matchMedia('(display-mode: standalone)').matches) return true;
  return readIosStandalone(globalThis.navigator);
}

/**
 * iOS Safari's own "am I installed" flag, read without asserting anything.
 *
 * The `in` check both proves the property is there and narrows the parameter
 * enough for the comparison to typecheck, so the value is compared rather than
 * coerced: anything other than the literal `true` reads as not installed.
 */
function readIosStandalone(candidate: Navigator): boolean {
  if (!('standalone' in candidate)) return false;
  return candidate.standalone === true;
}

/**
 * Whether this is an iOS device, which is the one platform with no install API
 * at all.
 *
 * WebKit is the only engine iOS permits, and it never fires
 * `beforeinstallprompt`. iPadOS 13 and later report themselves as a Macintosh,
 * so the touch-point count is what separates an iPad from a desktop Mac, which
 * has none.
 */
function isIosDevice(nav: Navigator): boolean {
  const agent = nav.userAgent;
  if (/iPhone|iPad|iPod/.test(agent)) return true;
  return agent.includes('Macintosh') && nav.maxTouchPoints > 1;
}

/**
 * The install card on the settings screen. Renders nothing when there is
 * nothing to offer.
 *
 * WHY IT IS A CARD AND NOT A BUTTON. Three of its four states show nothing at
 * all, so a caller placing a heading and a paragraph around a bare control
 * would leave an empty card behind on most devices. The whole section is
 * therefore this component's to render or to withhold.
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
 * NOTHING TOUCHES `window` AT MODULE SCOPE, and the first render is
 * `unavailable` on every device. The detection runs in the effect, so the
 * server and the first client render agree and nothing about the device is
 * guessed during hydration.
 */
export function InstallApp(): ReactElement | null {
  const { t } = useTranslation();
  const [state, setState] = useState<InstallState>({ kind: 'unavailable' });

  useEffect(() => {
    // Already installed: there is nothing to offer, and no listener is worth
    // holding, because neither event can fire in an installed app.
    if (isInstalled()) return;

    if (isIosDevice(globalThis.navigator)) {
      setState({ kind: 'manual' });
      return;
    }

    // The default is the browser's own mini-infobar. Preventing it is what
    // moves the moment into this card, where the reader chose to look.
    const onPrompt = (event: BeforeInstallPromptEvent): void => {
      event.preventDefault();
      setState({ kind: 'ready', event });
    };

    // The card has done its job. Chromium fires this whether the install came
    // from this button or from the browser's own menu, so it is the one signal
    // that covers both.
    const onInstalled = (): void => setState({ kind: 'unavailable' });

    globalThis.addEventListener('beforeinstallprompt', onPrompt);
    globalThis.addEventListener('appinstalled', onInstalled);
    return () => {
      globalThis.removeEventListener('beforeinstallprompt', onPrompt);
      globalThis.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (state.kind === 'unavailable') return null;

  return (
    <div className="rounded-xl border bg-card p-6">
      <h2 className="font-display text-base font-semibold">{t('settings.installTitle')}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t('settings.installBody')}</p>
      {state.kind === 'manual' && <p className="mt-4 text-sm">{t('settings.installIosStep')}</p>}
      {state.kind === 'ready' && (
        <div className="mt-4">
          <Button
            type="button"
            onClick={() => {
              void runInstallPrompt(state.event, () => setState({ kind: 'unavailable' }));
            }}
          >
            <Download className="size-4" aria-hidden="true" />
            {t('settings.installAction')}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Show the browser's install dialog once, then let the event go.
 *
 * A PROMPT EVENT IS SINGLE USE. Calling `prompt()` a second time on the same
 * event rejects, so the button is withdrawn BEFORE the dialog opens rather than
 * after the reader answers: the dialog is modal in practice, but a withdrawn
 * button cannot be clicked twice by any route, including a keyboard repeat.
 *
 * A DISMISSAL IS NOT AN ERROR AND NOTHING IS SAID ABOUT IT. Chromium fires
 * `beforeinstallprompt` again on a later visit, and the listener is still
 * mounted, so the card comes back on its own. Nagging a reader who just said no
 * is the one thing this card must not do.
 *
 * @param event - the prompt event to spend.
 * @param discard - withdraws the button, called before the dialog opens.
 */
async function runInstallPrompt(event: BeforeInstallPromptEvent, discard: () => void): Promise<void> {
  discard();
  try {
    await event.prompt();
    await event.userChoice;
  } catch (cause) {
    reportError(cause, { scope: 'install-app' });
  }
}
