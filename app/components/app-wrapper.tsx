import * as React from 'react';
import { useLocation, useMatches, useNavigation, useRouteLoaderData } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Menu } from 'lucide-react';
import { Link } from '#app/components/link';
import { ThemeToggle } from '#app/components/theme-toggle';
import { APP_NAME } from '#app/lib/app-name';
import { routeTitle } from '#app/lib/route-title';
import { cn } from '#app/lib/utils';
import {
  activeNavigationHref,
  AppSidebar,
  footerNavigationItems,
  navigationItems,
  primaryNavigationItems,
  type NavigationItem,
} from './app-sidebar';
import { BottomNav } from './bottom-nav';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from './ui/sheet';
import { SidebarInset, SidebarProvider, SidebarTrigger } from './ui/sidebar';

/**
 * A thin navigation indicator across the top of the chrome, shown only while a
 * navigation is in flight. The bar itself is the `--animate-loading-bar` token
 * from `app.css`, so its timing is set once for the whole app.
 */
function ProgressBar() {
  const navigation = useNavigation();
  if (navigation.state === 'idle') return null;

  return (
    <div className="fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden" aria-hidden="true">
      <div className="h-full w-1/3 animate-loading-bar bg-primary" />
    </div>
  );
}

/** One drawer row's classes. Active rows carry the brand the same way the sidebar's do. */
function drawerItemClasses(isActive: boolean): string {
  return cn(
    'flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
    isActive ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted',
  );
}

/** One drawer destination, the drawer's counterpart to the sidebar's row. */
function DrawerRow({
  item,
  isActive,
  onNavigate,
}: {
  item: NavigationItem;
  isActive: boolean;
  onNavigate: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      aria-current={isActive ? 'page' : undefined}
      className={drawerItemClasses(isActive)}
    >
      <item.icon className="h-4 w-4" aria-hidden="true" />
      <span>{t(item.labelKey)}</span>
    </Link>
  );
}

/**
 * The mobile navigation drawer. It renders the same catalog the desktop sidebar
 * does, in the same order and with the same footer separation, so a phone user
 * and a laptop user see one map of the app rather than two.
 *
 * `md:hidden`, because at md and up the sidebar is already on screen. There is
 * no logo image to tap yet, so the trigger is a real button with an accessible
 * label rather than a decorative mark.
 */
function NavDrawer() {
  const { t } = useTranslation();
  const location = useLocation();
  const [isOpen, setIsOpen] = React.useState(false);
  const close = (): void => setIsOpen(false);
  const activeHref = activeNavigationHref(location.pathname);

  return (
    <Sheet open={isOpen} onOpenChange={setIsOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="size-9 shrink-0 md:hidden" aria-label={t('nav.openMenu')}>
          <Menu className="size-5" aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-72 gap-0 p-0 md:hidden">
        <SheetHeader className="border-b">
          <SheetTitle className="font-display text-lg">{APP_NAME}</SheetTitle>
          <SheetDescription className="sr-only">{t('nav.drawerDescription')}</SheetDescription>
        </SheetHeader>
        <nav className="flex flex-col gap-1 p-2">
          {primaryNavigationItems.map((item) => (
            <DrawerRow key={item.to} item={item} isActive={activeHref === item.to} onNavigate={close} />
          ))}
          {/* The same footer separation the sidebar draws: the things you set
              once sit below a rule, not among the places you go every day. */}
          <Separator className="my-2" />
          {footerNavigationItems.map((item) => (
            <DrawerRow key={item.to} item={item} isActive={activeHref === item.to} onNavigate={close} />
          ))}
        </nav>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The account slot in the header: a sign-in name, or the way to get one.
 *
 * BOTH STATES ARE A DOOR, AND THAT IS THE POINT. Until M189 the shell showed
 * an anonymous visitor nothing at all about accounts, which was correct while
 * the product was anonymous by default and wrong the moment M184 made an
 * account mandatory: an invited reader had to be told a URL by hand. A signed
 * in reader gets the opposite job done, seeing which account this device is
 * carrying.
 *
 * IT READS THE ROOT LOADER, NOT A SESSION. `userEmail` is a label for the
 * chrome and nothing more; every real gate re-reads the user itself on the
 * server. It comes from `root` rather than from a layout loader so it survives
 * the offline fallback in `root.tsx` unchanged.
 *
 * `truncate` with a width cap, because an address can be long and the header
 * must not grow a second line on a narrow phone.
 *
 * On `/sign-in` and `/sign-up` an anonymous visitor is already on the door or
 * its sibling, so the slot renders nothing there rather than a link to the
 * page they are already reading.
 */
function AccountSlot() {
  const { t } = useTranslation();
  const location = useLocation();
  const rootData = useRouteLoaderData<{ userEmail: string | null }>('root');
  const email = rootData?.userEmail ?? null;

  if (email === null && (location.pathname === '/sign-in' || location.pathname === '/sign-up')) {
    return null;
  }

  if (email === null) {
    return (
      <Link
        to="/sign-in"
        className="text-sm font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
      >
        {t('account.signInAction')}
      </Link>
    );
  }

  return (
    <Link to="/account" className="flex max-w-32 items-center gap-1 text-sm hover:text-primary">
      <span className="sr-only">{t('account.title')}</span>
      <span className="truncate font-mono text-xs">{email}</span>
    </Link>
  );
}

/**
 * The imprint and privacy links, at the bottom of every screen in the shell.
 *
 * A German Impressum has to be reachable from every page in two clicks, and
 * `/settings` was the only entry point these two documents had. They are NOT in
 * the nav catalog on purpose: the sidebar and the tab bar are places a person
 * goes, and a privacy policy is not one of them. A quiet footer line is where a
 * reader looks for them, and it costs the navigation nothing.
 *
 * The labels come from the `legal` namespace, so the footer and the strip at
 * the bottom of each document read the same word.
 */
function LegalFooter() {
  const { t } = useTranslation('legal');

  return (
    <footer className="border-t px-4 pb-[calc(env(safe-area-inset-bottom)+5rem)] pt-4 text-xs text-muted-foreground md:px-6 md:pb-4">
      <nav aria-label={t('links.title')}>
        <ul className="flex list-none flex-wrap gap-x-4 gap-y-1 pl-0">
          <li>
            <Link to="/legal/imprint" className="underline underline-offset-4 hover:text-foreground">
              {t('links.imprint')}
            </Link>
          </li>
          <li>
            <Link to="/legal/privacy" className="underline underline-offset-4 hover:text-foreground">
              {t('links.privacy')}
            </Link>
          </li>
        </ul>
      </nav>
    </footer>
  );
}

export default function AppWrapper({
  title,
  backTo,
  children,
}: {
  title?: string;
  backTo?: string;
  children: React.ReactNode;
}) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <InnerContent title={title} backTo={backTo}>
          {children}
        </InnerContent>
      </SidebarInset>
    </SidebarProvider>
  );
}

function InnerContent({ title, backTo, children }: { title?: string; backTo?: string; children: React.ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const matches = useMatches();
  // When a route passes no title, two fallbacks answer for it, in order. A
  // route can name itself through a `handle` (see `#app/lib/route-title`),
  // which is the only way a screen inside this layout can reach the header at
  // all. Failing that, the nav catalog already knows the name of the screen the
  // user is on, so the header reads it from there rather than making every
  // route repeat its own label. Screens outside the catalog, `/search` and
  // `/entry/:id`, are exactly why the handle exists: without it the h1 fell all
  // the way back to the wordmark and the mobile header said "translate" twice.
  const activeHref = activeNavigationHref(location.pathname);
  const activeItem = navigationItems.find((item) => item.to === activeHref);
  const activeLabel = activeItem && t(activeItem.labelKey);
  const handleTitle = routeTitle(matches, (key) => t(key));

  return (
    <>
      <ProgressBar />
      {/* The chrome sits on `bg-card`, not `bg-background`, so the header is a
          treated surface rather than the same fill as the page under it.
          `border-primary/20` tints the closing hairline the way the active tab
          is tinted, and `AppSidebar`'s header carries the same value so the two
          rules read as one line across the chrome at md and up. */}
      <header className="flex min-h-16 shrink-0 items-center gap-2 border-b border-primary/20 bg-card">
        <div className="flex w-full items-center gap-2.5 px-4">
          {/* Desktop only. Below md the drawer trigger beside it opens the same
              list, and two triggers for one sheet is one too many. */}
          <SidebarTrigger className="-ml-1 hidden md:inline-flex" />
          <Separator orientation="vertical" className="mr-2 hidden h-4 md:block" />
          <NavDrawer />
          <div className="flex flex-1 items-center justify-between">
            <div className="flex min-w-0 flex-col justify-center gap-px">
              {/* The wordmark, mobile only. At md and up the sidebar's own logo
                  renders this exact word a few pixels away, and a second one
                  there is a duplicate rather than emphasis. Decorative: the
                  page title below names the screen for assistive tech. */}
              <span
                aria-hidden="true"
                className="font-display text-xs font-semibold leading-none text-primary md:hidden"
              >
                {APP_NAME}
              </span>
              {/* `truncate`, because a long title would otherwise wrap the
                  header to a second line on a narrow phone. */}
              <h1 className="truncate font-display text-lg font-semibold leading-tight tracking-tight md:text-xl">
                {title ?? handleTitle ?? activeLabel ?? APP_NAME}
              </h1>
            </div>
            <div className="flex items-center gap-3">
              <AccountSlot />
              <ThemeToggle />
            </div>
          </div>
        </div>
      </header>
      {backTo && (
        <div className="border-b bg-muted/50 px-4 py-2 sm:px-6 lg:px-8">
          <Link
            to={backTo}
            className="inline-flex items-center text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('nav.back')}
          </Link>
        </div>
      )}
      {/* The bottom padding clears the mobile tab bar, so page content is never
          hidden behind it. The sidebar owns navigation at md and up, where the
          bar is gone and the padding drops back to normal. */}
      <div className="flex-1 p-4 pb-[calc(env(safe-area-inset-bottom)+5rem)] md:p-6 md:pb-6">{children}</div>
      <LegalFooter />
      <BottomNav />
    </>
  );
}
