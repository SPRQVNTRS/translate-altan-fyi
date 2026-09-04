/**
 * The `/super` sidebar row: shown only when `isSuperadmin` is true.
 *
 * There is no DOM library in this repo (see `account-ui.test.ts`), so this
 * tests the pure filter both the sidebar and the mobile drawer call rather
 * than a rendered tree. `AppSidebar` and `NavDrawer` (`app-wrapper.tsx`) both
 * pass `visibleFooterNavigationItems` the same `isSuperadmin` boolean the root
 * loader hands them, so one test of the filter covers both surfaces: the
 * element is dropped from the list entirely, not merely styled away.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { footerNavigationItems, visibleFooterNavigationItems } from '#app/components/app-sidebar';

const ADMIN_HREF = '/super';

describe('sidebar admin link', () => {
  it('is present in the catalog exactly once, as a superadmin-only footer row', () => {
    const matches = footerNavigationItems.filter((item) => item.to === ADMIN_HREF);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.requiresSuperadmin, true);
  });

  it('renders the admin link for a superadmin', () => {
    const hrefs = visibleFooterNavigationItems(true).map((item) => item.to);
    assert.ok(hrefs.includes(ADMIN_HREF), `expected ${ADMIN_HREF} in ${JSON.stringify(hrefs)}`);
  });

  it('omits the admin link for a signed-in reader who is not a superadmin', () => {
    // The root loader hands `visibleFooterNavigationItems` the same
    // `isSuperadmin: false` for an ordinary signed-in reader as for nobody at
    // all (see `readUserForDisplay` in `app/middleware/auth.ts`), so this and
    // the anonymous case below exercise the one boolean that decides both.
    const hrefs = visibleFooterNavigationItems(false).map((item) => item.to);
    assert.ok(!hrefs.includes(ADMIN_HREF), `did not expect ${ADMIN_HREF} in ${JSON.stringify(hrefs)}`);
  });

  it('omits the admin link for an anonymous visitor', () => {
    // `root.tsx`'s loader answers `isSuperadmin: false` when `readUserForDisplay`
    // returns `null`, and its offline `clientLoader` fallback answers the same
    // `false`: both paths land here.
    const hrefs = visibleFooterNavigationItems(false).map((item) => item.to);
    assert.ok(!hrefs.includes(ADMIN_HREF), `did not expect ${ADMIN_HREF} in ${JSON.stringify(hrefs)}`);
  });
});
