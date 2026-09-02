import { useTranslation } from 'react-i18next';
import { NavLink } from '#app/components/link';
import { cn } from '#app/lib/utils';
import { tabNavigationItems, type NavigationItem } from './app-sidebar';

/**
 * The mobile tab bar. It carries the three places you move between while you
 * work: Search, Lists and History. Settings and Account live in the top-left
 * navigation drawer (`app-wrapper.tsx`), which shows the same complete map the
 * desktop sidebar does.
 *
 * The three tabs are equal. There is no raised centre button, because this app
 * has no single flagship verb, and a raised tab would claim one.
 *
 * The entries come from the shared catalog, pre-ordered by each item's
 * `tab.order`, so this file lists no catalog keys or hrefs of its own and the
 * bar cannot disagree with the drawer about a destination.
 */
const BOTTOM_NAV_TABS: readonly NavigationItem[] = tabNavigationItems;

/**
 * One tab: icon over label. The active state carries the brand in three places,
 * a top rule, a faint wash and the text colour, so it never depends on hue
 * alone.
 */
function FlatTab({ tab }: { tab: NavigationItem }) {
  const { t } = useTranslation();

  return (
    <NavLink
      to={tab.to}
      // `end` so the Search tab, whose href is `/`, is active on the home page
      // only. Without it react-router treats `/` as a prefix of every route.
      end={tab.to === '/'}
      className={({ isActive }) =>
        cn(
          'relative flex flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium transition-colors',
          isActive ?
            'bg-primary/5 text-primary after:absolute after:inset-x-5 after:top-0 after:h-0.5 after:rounded-full after:bg-primary after:content-[""]'
          : 'text-muted-foreground hover:text-foreground',
        )
      }
    >
      <tab.icon className="h-5 w-5" aria-hidden="true" />
      <span>{t(tab.labelKey)}</span>
    </NavLink>
  );
}

/**
 * Mobile-only fixed bottom tab bar, hidden at md and up where the sidebar takes
 * over. The `h-14` content height plus the `env(safe-area-inset-bottom)`
 * padding is a contract: `AppWrapper` reserves matching bottom padding, so page
 * content is never hidden behind the bar.
 */
export function BottomNav() {
  const { t } = useTranslation();

  return (
    <nav
      aria-label={t('nav.bottomBarLabel')}
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      <div className="flex h-14 items-stretch">
        {BOTTOM_NAV_TABS.map((tab) => (
          <FlatTab key={tab.to} tab={tab} />
        ))}
      </div>
    </nav>
  );
}
