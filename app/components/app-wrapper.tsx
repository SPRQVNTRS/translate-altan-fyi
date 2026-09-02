import { useLoading } from '#app/context/loading';
import { Link, useNavigation, Form } from 'react-router';
import { cn } from '#app/lib/utils';
import { ArrowLeft, User, LogOut, Settings } from 'lucide-react';
import { AppSidebar } from './app-sidebar';
import { SidebarInset, SidebarProvider, SidebarTrigger } from './ui/sidebar';
import { Separator } from './ui/separator';
import { ThemeToggle } from './theme-toggle';
import { useUser } from '#app/hooks/use-user';
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
import * as React from 'react';

export default function AppWrapper({
  title,
  backTo,
  children,
}: {
  title?: string;
  backTo?: string;
  children: React.ReactNode;
}) {
  const navigation = useNavigation();
  const { isLoading } = useLoading();
  const showLoadingBar = navigation.state === 'loading' || isLoading;

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <InnerContent title={title} backTo={backTo} showLoadingBar={showLoadingBar}>
          {children}
        </InnerContent>
      </SidebarInset>
    </SidebarProvider>
  );
}

// Inner content component that can use useSidebar hook
function InnerContent({
  title,
  backTo,
  showLoadingBar,
  children,
}: {
  title?: string;
  backTo?: string;
  showLoadingBar: boolean;
  children: React.ReactNode;
}) {
  const user = useUser();

  return (
    <>
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
      <header className="flex h-16 shrink-0 items-center gap-2 border-b bg-background">
        <div className="flex items-center gap-2 px-4 w-full">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <div className="flex flex-1 items-center justify-between">
            <h1 className="text-xl font-semibold">{title || 'Dashboard'}</h1>
            <div className="flex items-center gap-3">
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
              <ThemeToggle />
            </div>
          </div>
        </div>
      </header>
      {backTo && (
        <div className="bg-muted/50 border-b px-4 py-2 sm:px-6 lg:px-8">
          <Link
            to={backTo}
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Link>
        </div>
      )}
      <div className="flex-1 p-4 md:p-6">{children}</div>
    </>
  );
}
