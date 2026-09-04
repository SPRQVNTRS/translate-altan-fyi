import { ThemeToggle } from './theme-toggle';
import { Layers } from 'lucide-react';
import * as React from 'react';
import { useNavigation } from 'react-router';
import { cn } from '#app/lib/utils';
import { APP_NAME } from '#app/lib/app-name';
import { useLoading } from '#app/context/loading';

export default function PublicWrapper({
  children,
  showLogo = true,
}: {
  children: React.ReactNode;
  showLogo?: boolean;
}) {
  const navigation = useNavigation();
  const { isLoading } = useLoading();
  const showLoadingBar = navigation.state === 'loading' || isLoading;

  return (
    <div className="min-h-screen pt-16">
      {/* Loading Bar */}
      <div className="fixed top-0 left-0 right-0 h-1 bg-transparent z-50 pointer-events-none">
        <div
          className={cn(
            'absolute inset-0 overflow-hidden',
            showLoadingBar ? 'opacity-100' : 'opacity-0',
            'transition-opacity duration-200',
          )}
        >
          <div
            className={cn(
              'h-full bg-linear-to-r from-blue-500 via-purple-500 to-pink-500',
              'absolute top-0 left-0 w-1/3',
              'animate-loading-bar',
            )}
          />
        </div>
      </div>
      <header className="fixed top-0 left-0 right-0 h-16 px-4 z-50 flex items-center justify-between bg-background/80 backdrop-blur-sm border-b">
        <div>
          {showLogo && (
            <a href="/" className="flex items-center gap-3 font-medium hover:opacity-80 transition-opacity">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
                <Layers className="h-5 w-5 text-primary-foreground" />
              </div>
              <span className="font-display text-lg font-semibold text-foreground">{APP_NAME}</span>
            </a>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* NO ACCOUNT MENU, AND NO SIGN-IN LINK. This wrapper is the chrome
              for the `/legal/*` pages and the 404 page. It carried a profile
              and dashboard dropdown until M189 (ADR-0010). Both pointed at
              org screens that no longer exist, and the menu itself read a
              `users` row this product never provisioned. The account surface
              lives inside the app shell, on `/account`. */}
          <ThemeToggle />
        </div>
      </header>
      <div className="container mx-auto max-w-3xl px-4 py-12 md:py-16">{children}</div>
    </div>
  );
}
