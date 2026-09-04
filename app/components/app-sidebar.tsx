import * as React from 'react';
import { BookMarked, History, ScrollText, Search, Settings, ShieldCheck, UserRound, type LucideIcon } from 'lucide-react';
import { useLocation, useRouteLoaderData } from 'react-router';
import { useTranslation } from 'react-i18next';
import { cn } from '#app/lib/utils';
import { Link } from '#app/components/link';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from '#app/components/ui/sidebar';

/**
 * Where a destination sits in the drawer and the sidebar: with the day-to-day
 * destinations, or in the visually separated footer group that carries the
 * things you set once (Settings, Account).
 */
export type NavigationGroup = 'primary' | 'footer';

export type NavigationItem = {
  /**
   * A key into the `common` catalog under `app/locales`, not a word.
   * Every surface that renders a row resolves it through `t()`, so the three
   * navs and the header title are translated from one entry rather than four.
   */
  labelKey: string;
  to: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>> | LucideIcon;
  group: NavigationGroup;
  /**
   * Present only for the destinations the mobile tab bar also carries. The
   * `order` is the tab-bar slot, kept here so the bar and the drawer can never
   * drift into two different labels for one destination.
   */
  tab?: { order: number };
  /**
   * Present only for the operator link. `visibleFooterNavigationItems` is the
   * one place this is read, so an ordinary reader and an anonymous visitor
   * never have the row in the DOM at all, not merely hidden with CSS.
   */
  requiresSuperadmin?: boolean;
};

/**
 * The whole map of the app, in one place. Three surfaces read it: the desktop
 * sidebar below, the mobile drawer in `app-wrapper.tsx`, and the mobile tab bar
 * in `bottom-nav.tsx`. A wording or href change lands in one entry and all
 * three move together.
 *
 * The three primary entries are equal. This app has no flagship verb, so the
 * tab bar is three flat tabs, with no raised centre button.
 */
export const navigationItems: NavigationItem[] = [
  { labelKey: 'nav.search', to: '/', icon: Search, group: 'primary', tab: { order: 1 } },
  { labelKey: 'nav.lists', to: '/lists', icon: BookMarked, group: 'primary', tab: { order: 2 } },
  { labelKey: 'nav.history', to: '/history', icon: History, group: 'primary', tab: { order: 3 } },
  { labelKey: 'nav.settings', to: '/settings', icon: Settings, group: 'footer' },
  { labelKey: 'nav.account', to: '/account', icon: UserRound, group: 'footer' },
  // No `tab`: the mobile bar stays three tabs. Sources is a licence
  // obligation the reader consults once, not a place they go every day.
  { labelKey: 'nav.attribution', to: '/attribution', icon: ScrollText, group: 'footer' },
  // The operator link, last in the catalog and last in the footer group.
  // `/super` itself is a redirect to `/super/llm` (`routes/super/index-redirect.ts`),
  // never a 404, and `superadminMiddleware` re-checks the flag on every
  // request this link can lead to.
  { labelKey: 'nav.admin', to: '/super', icon: ShieldCheck, group: 'footer', requiresSuperadmin: true },
];

/** The day-to-day destinations, in catalog order: the top block of the drawer and the sidebar. */
export const primaryNavigationItems: NavigationItem[] = navigationItems.filter((item) => item.group === 'primary');

/** The separated group at the bottom of the drawer and the sidebar. */
export const footerNavigationItems: NavigationItem[] = navigationItems.filter((item) => item.group === 'footer');

/**
 * The footer group as a reader with `isSuperadmin` should actually see it.
 *
 * A row marked `requiresSuperadmin` is DROPPED, not merely hidden, for
 * anybody else: an anonymous visitor and a signed-in reader who is not a
 * superadmin both pass `isSuperadmin: false` here and get no such element in
 * the DOM. Both the sidebar and the mobile drawer read this instead of
 * `footerNavigationItems` directly, so the two surfaces cannot drift.
 *
 * @param isSuperadmin - the root loader's `isSuperadmin`, itself a display
 *   convenience: `superadminMiddleware` is what actually gates `/super/*`.
 */
export function visibleFooterNavigationItems(isSuperadmin: boolean): NavigationItem[] {
  return footerNavigationItems.filter((item) => !item.requiresSuperadmin || isSuperadmin);
}

/**
 * The mobile tab bar's destinations, in bar order. Derived rather than
 * re-listed, so the bar cannot label a destination differently from the drawer.
 */
export const tabNavigationItems: NavigationItem[] = navigationItems
  .filter((item) => item.tab !== undefined)
  .toSorted((a, b) => (a.tab?.order ?? 0) - (b.tab?.order ?? 0));

/**
 * Which nav item, if any, the current URL belongs to. The longest matching
 * href wins, so a future `/settings/theme` highlights that row rather than
 * both it and `/settings`.
 *
 * The root href needs its own rule. Search lives at `/`, and a plain
 * `startsWith` would mark it active on every page in the app, because every
 * path starts with a slash. `/` therefore matches only when the pathname is
 * exactly `/`, which is what the first branch below expresses.
 *
 * Pure and exported, so the sidebar, the drawer and a unit test share one rule.
 *
 * @param pathname - the current `location.pathname`.
 * @returns the winning item's `to`, or `null` when the URL is outside the catalog.
 */
export function activeNavigationHref(
  pathname: string,
  items: readonly NavigationItem[] = navigationItems,
): string | null {
  return items.reduce<string | null>((best, item) => {
    const isMatch = item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(item.to + '/');
    if (!isMatch) return best;
    return best === null || item.to.length > best.length ? item.to : best;
  }, null);
}

/**
 * The brand mark. There is no icon asset in `public/` yet, so the expanded rail
 * shows a wordmark set in the display face, and the collapsed rail shows a
 * compact square mark, which keeps the icon rail from reading as empty chrome.
 */
function Logo() {
  const { state } = useSidebar();
  const isCollapsed = state === 'collapsed';

  return (
    <Link
      to="/"
      className={cn(
        'flex items-center gap-3 px-4 transition-all duration-200 ease-in-out hover:opacity-80',
        // The collapsed rail is `--sidebar-width-icon` (3rem) minus the
        // header's own padding, which leaves exactly the 2rem the mark
        // occupies. Any leftover padding or gap here squeezes it, so both
        // collapse to zero and the mark centers.
        isCollapsed && 'justify-center gap-0 px-0',
      )}
    >
      {isCollapsed ?
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary font-display text-sm font-semibold text-primary-foreground"
        >
          t
        </span>
      : <span className="font-display text-lg font-semibold text-sidebar-foreground">translate</span>}
    </Link>
  );
}

/** One sidebar row, shared by the primary group and the footer group. */
function NavigationRow({ item, isActive }: { item: NavigationItem; isActive: boolean }) {
  const { t } = useTranslation();

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive}>
        <Link to={item.to}>
          <item.icon />
          <span>{t(item.labelKey)}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation();
  const location = useLocation();
  const activeHref = activeNavigationHref(location.pathname);
  // Read through the root loader, the same source `AccountSlot` reads: a
  // display convenience, never a gate. See `visibleFooterNavigationItems`.
  const rootData = useRouteLoaderData<{ isSuperadmin: boolean }>('root');
  const footerItems = visibleFooterNavigationItems(rootData?.isSuperadmin ?? false);

  return (
    <Sidebar collapsible="icon" {...props}>
      {/* The same brand-tinted hairline the app header closes with. At md and
          up the two rules sit at the same height and meet in the middle of the
          screen, so an untinted one here would show as a colour break. */}
      <SidebarHeader className="h-16 border-b border-primary/20 px-0">
        <div className="flex h-full items-center">
          <Logo />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{t('nav.groupLabel')}</SidebarGroupLabel>
          <SidebarMenu>
            {primaryNavigationItems.map((item) => (
              <NavigationRow key={item.to} item={item} isActive={activeHref === item.to} />
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      {/* Settings and Account are things you set once, not places you go every
          day, so they sit below a rule rather than as two more equal rows. */}
      <SidebarFooter>
        <SidebarSeparator className="mx-0" />
        <SidebarMenu>
          {footerItems.map((item) => (
            <NavigationRow key={item.to} item={item} isActive={activeHref === item.to} />
          ))}
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
