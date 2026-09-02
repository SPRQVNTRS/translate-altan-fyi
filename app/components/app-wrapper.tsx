import * as React from 'react';
import { useLocation, useNavigation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Menu } from 'lucide-react';
import { Link } from '#app/components/link';
import { ThemeToggle } from '#app/components/theme-toggle';
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
 * The product name, a lowercase wordmark and a proper noun. It stays literal in
 * every language: a name is not copy, and translating it would give the app two
 * identities.
 */
const APP_NAME = 'translate';

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
  // When a route passes no title, the nav catalog already knows the name of the
  // screen the user is on, so the header reads it from there rather than making
  // every route repeat its own label.
  const activeHref = activeNavigationHref(location.pathname);
  const activeItem = navigationItems.find((item) => item.to === activeHref);
  const activeLabel = activeItem && t(activeItem.labelKey);

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
                {title ?? activeLabel ?? APP_NAME}
              </h1>
            </div>
            <div className="flex items-center gap-3">
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
      <BottomNav />
    </>
  );
}
