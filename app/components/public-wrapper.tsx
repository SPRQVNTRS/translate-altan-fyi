import { ThemeToggle } from './theme-toggle';
import { Layers, User, LogOut, Settings } from 'lucide-react';
import * as React from 'react';
import { Link, Form, useNavigation } from 'react-router';
import { cn } from '#app/lib/utils';
import { useLoading } from '#app/context/loading';
import { useOptionalUser } from '#app/hooks/use-user';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Button } from './ui/button';
import { Avatar, AvatarFallback } from './ui/avatar';

export default function PublicWrapper({
  children,
  showLogo = true,
}: {
  children: React.ReactNode;
  showLogo?: boolean;
}) {
  const user = useOptionalUser();
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
              <span className="text-lg font-semibold text-foreground">AppName</span>
            </a>
          )}
        </div>
        <div className="flex items-center gap-3">
          {user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="flex items-center gap-2">
                  <Avatar className="h-7 w-7">
                    <AvatarFallback className="text-sm">
                      {user.name.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="hidden sm:inline text-sm">{user.name}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel>My Account</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/profile" className="flex items-center cursor-pointer">
                    <User className="mr-2 h-4 w-4" />
                    Profile
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/dashboard" className="flex items-center cursor-pointer">
                    <Settings className="mr-2 h-4 w-4" />
                    Dashboard
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="p-0">
                  <Form action="/logout" method="post" className="w-full">
                    <button className="flex items-center w-full px-2 py-1.5 text-sm cursor-pointer">
                      <LogOut className="mr-2 h-4 w-4" />
                      Logout
                    </button>
                  </Form>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Link
              to="/login"
              className="inline-flex items-center rounded-md border border-input px-3 py-1.5 text-sm text-foreground hover:bg-accent hover:text-accent-foreground"
            >
              Login
            </Link>
          )}
          <ThemeToggle />
        </div>
      </header>
      <div className="container mx-auto max-w-3xl px-4 py-12 md:py-16">{children}</div>
    </div>
  );
}
