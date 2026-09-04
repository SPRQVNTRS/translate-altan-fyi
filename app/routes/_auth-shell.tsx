/**
 * The chrome the five account-door screens sit in: sign-up, confirm, sign-in,
 * forgot and reset.
 *
 * WHY THEY LEFT THE APP SHELL. `AppWrapper` opens a 256px navigation sidebar
 * for everybody, signed in or not. A `max-w-md` card inside it centres in the
 * REMAINING column, so the 2026-09-04 browser walk measured the sign-up card at
 * x=768 against a viewport centre of x=640: 128px off, and visibly pushed to
 * the right. Centring the card harder cannot fix that, because the container it
 * is centred in is the wrong one.
 *
 * `PublicWrapper` is the same chrome `/legal/*` uses: a header with the logo and
 * the theme toggle, and a container that centres on the VIEWPORT. It also
 * carries no account slot at all, which is what these screens want: a "Sign in"
 * link on the sign-in page is noise, and the reader who needs the other door
 * gets it from the card's own footer.
 *
 * `/account` STAYS IN THE APP SHELL, deliberately. It is not a door: it is a
 * screen a signed-in reader navigates to from the header, alongside their
 * lists and history, and it belongs in the same furniture as those.
 *
 * `/sign-out` is not here either. It has no component at all, only a POST.
 */
import { Outlet } from 'react-router';

import PublicWrapper from '#app/components/public-wrapper';

export default function AuthShellLayout() {
  return (
    <PublicWrapper>
      <Outlet />
    </PublicWrapper>
  );
}
