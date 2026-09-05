import { useEffect, useState } from 'react';
import { reportError } from '#app/lib/report-error';

/**
 * WHAT THIS DEVICE CAN BE OFFERED, AS ONE ANSWER FOR EVERY SURFACE.
 *
 * Two places ask: the card on `/settings` (`app/components/install-app.tsx`)
 * and the row in the navigation (`app-sidebar.tsx` and the drawer in
 * `app-wrapper.tsx`). The detection lives here so they cannot disagree about
 * whether this browser can install the app.
 *
 * NOTHING TOUCHES `window` AT MODULE SCOPE, AND THE FIRST ANSWER IS ALWAYS
 * `unavailable`. That is the whole point of the hook rather than a function
 * called during render. Reading `navigator` or `matchMedia` while rendering
 * gives the server one answer and the browser another; React keeps the server's
 * markup and never repairs the difference, so the reader is left with a control
 * that can never do anything. Here the server renders nothing, the effect runs
 * after mount, and the offer appears only once it is real.
 */
export type InstallOffer =
  | { kind: 'unavailable' }
  | { kind: 'manual' }
  | { kind: 'ready'; install: () => void };

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

/** The internal state, which holds the event the public offer only spends. */
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
 * What this device can be offered right now.
 *
 * `unavailable` covers a browser with no installation support, an app already
 * installed, the server render, and the moment after an install finishes.
 * `manual` is iOS, where the only honest offer is the sentence about the Share
 * menu. `ready` carries a live prompt event and is the only state with anything
 * to click.
 *
 * @returns The current offer. Never `ready` before mount.
 */
export function useInstallPrompt(): InstallOffer {
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
    // moves the moment into the app, where the reader chose to look.
    const onPrompt = (event: BeforeInstallPromptEvent): void => {
      event.preventDefault();
      setState({ kind: 'ready', event });
    };

    // The offer has done its job. Chromium fires this whether the install came
    // from our button or from the browser's own menu, so it is the one signal
    // that covers both.
    const onInstalled = (): void => setState({ kind: 'unavailable' });

    globalThis.addEventListener('beforeinstallprompt', onPrompt);
    globalThis.addEventListener('appinstalled', onInstalled);
    return () => {
      globalThis.removeEventListener('beforeinstallprompt', onPrompt);
      globalThis.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (state.kind === 'unavailable') return { kind: 'unavailable' };
  if (state.kind === 'manual') return { kind: 'manual' };

  const { event } = state;
  return {
    kind: 'ready',
    install: () => {
      void runInstallPrompt(event, () => setState({ kind: 'unavailable' }));
    },
  };
}

/**
 * Show the browser's install dialog once, then let the event go.
 *
 * A PROMPT EVENT IS SINGLE USE. Calling `prompt()` a second time on the same
 * event rejects, so the offer is withdrawn BEFORE the dialog opens rather than
 * after the reader answers: the dialog is modal in practice, but a withdrawn
 * button cannot be clicked twice by any route, including a keyboard repeat.
 *
 * A DISMISSAL IS NOT AN ERROR AND NOTHING IS SAID ABOUT IT. Chromium fires
 * `beforeinstallprompt` again on a later visit, and the listener is still
 * mounted, so the offer comes back on its own. Nagging a reader who just said
 * no is the one thing this must not do.
 *
 * @param event - the prompt event to spend.
 * @param discard - withdraws the offer, called before the dialog opens.
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
