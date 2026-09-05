/**
 * The install entry in the navigation.
 *
 * There is no DOM library in this repo (see `account-ui.test.ts`), so what is
 * checked here is the catalog contract the rows read: one entry, in the catalog
 * file, labelled with the sentence the settings card already uses, and not a
 * destination.
 *
 * The hydration rule the entry depends on cannot be tested without a DOM. It is
 * held by construction instead: `useInstallPrompt` starts at `unavailable` and
 * only an effect can move it, so neither row exists in the server markup.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { installNavigationAction, navigationItems } from '#app/components/app-sidebar';
import enCommon from '#app/locales/en/common.json';
import deCommon from '#app/locales/de/common.json';

describe('install navigation entry', () => {
  it('is not a destination, so the catalog and the tab bar never see it', () => {
    assert.ok(!('to' in installNavigationAction));
    const labels = navigationItems.map((item) => item.labelKey);
    assert.ok(!labels.includes(installNavigationAction.labelKey));
  });

  it('reuses the settings card label rather than a second phrasing', () => {
    assert.equal(installNavigationAction.labelKey, 'settings.installTitle');
  });

  it('has that label in both locales', () => {
    // A missing key would already fail the typecheck, since these catalogs are
    // typed by their own JSON. This asserts the value is worth rendering.
    assert.ok(enCommon.settings.installTitle.length > 0);
    assert.ok(deCommon.settings.installTitle.length > 0);
  });
});
