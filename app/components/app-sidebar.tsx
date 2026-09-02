import * as React from 'react';
import {
  HomeIcon,
  Settings,
  Users,
  Layers,
  Workflow,
  Building2,
  Shield,
  ArrowLeft,
  type LucideIcon,
} from 'lucide-react';
import { useUser } from '#app/hooks/use-user';
import { useOptionalTenant, isOrgAdmin } from '#app/hooks/use-tenant';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarGroupLabel,
  SidebarSeparator,
  useSidebar,
} from '#app/components/ui/sidebar';
import { Link, useLocation, useParams } from 'react-router';

type NavigationItem = {
  name: string;
  to: string;
  icon?: React.ComponentType<React.SVGProps<SVGSVGElement>> | LucideIcon;
  /** Only show for org admins (owner/admin role in org) */
  orgAdminOnly?: boolean;
};

/** Navigation items scoped to the current organization */
function getOrgNavigationItems(orgSlug: string): NavigationItem[] {
  return [
    { name: 'Dashboard', to: `/org/${orgSlug}/dashboard`, icon: HomeIcon },
    { name: 'Workflows', to: `/org/${orgSlug}/workflows`, icon: Workflow },
    { name: 'Users', to: `/org/${orgSlug}/users`, icon: Users, orgAdminOnly: true },
  ];
}

/** Superadmin navigation items (cross-tenant platform management) */
const superadminItems: NavigationItem[] = [
  { name: 'Organizations', to: '/super/orgs', icon: Building2 },
  { name: 'Users', to: '/super/users', icon: Users },
];

function Logo({ orgSlug, isSuperContext }: { orgSlug?: string; isSuperContext?: boolean }) {
  const { state } = useSidebar();
  const isCollapsed = state === 'collapsed';

  // Logo links to: org dashboard > super orgs > select org
  const linkTo = orgSlug
    ? `/org/${orgSlug}/dashboard`
    : isSuperContext
      ? '/super/orgs'
      : '/select-org';

  return (
    <Link to={linkTo} className="flex items-center gap-3 transition-all duration-200 ease-in-out hover:opacity-80 px-4">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sidebar-primary">
        <Layers className="h-5 w-5 text-sidebar-primary-foreground" />
      </div>
      {!isCollapsed && <span className="text-lg font-semibold text-sidebar-foreground">AppName</span>}
    </Link>
  );
}

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const user = useUser();
  const tenant = useOptionalTenant();
  const location = useLocation();
  const params = useParams();
  const orgSlug = params['orgSlug'];

  // Detect if we're in superadmin context (on /super/* routes)
  const isSuperContext = location.pathname.startsWith('/super');

  // Check if user is superadmin
  const isSuperadmin = user.isSuperadmin;

  // Check if user is org admin (owner/admin role in current org)
  const isAdmin = isOrgAdmin(tenant?.orgRole) || isSuperadmin;

  // Get org-scoped navigation if we have an org context
  const orgNavigationItems = orgSlug ? getOrgNavigationItems(orgSlug) : [];

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader className="h-16 border-b px-0">
        <div className="flex h-full items-center">
          <Logo orgSlug={orgSlug} isSuperContext={isSuperContext} />
        </div>
      </SidebarHeader>
      <SidebarContent>
        {/* Superadmin Navigation (when on /super/* routes) */}
        {isSuperContext && isSuperadmin && (
          <>
            {/* Back to Org button */}
            <SidebarGroup>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild>
                    <Link to="/dashboard" className="text-muted-foreground">
                      <ArrowLeft />
                      <span>Back to Dashboard</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
            <SidebarSeparator />
            <SidebarGroup>
              <SidebarGroupLabel>
                <Shield className="h-3 w-3 mr-1" />
                Platform Admin
              </SidebarGroupLabel>
              <SidebarMenu>
                {superadminItems.map((item) => {
                  const isActive = location.pathname === item.to;
                  return (
                    <SidebarMenuItem key={item.name}>
                      <SidebarMenuButton asChild isActive={isActive}>
                        <Link to={item.to}>
                          {item.icon && <item.icon />}
                          <span>{item.name}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          </>
        )}

        {/* Organization Navigation (when on /org/:orgSlug/* routes) */}
        {orgSlug && orgNavigationItems.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Navigation</SidebarGroupLabel>
            <SidebarMenu>
              {orgNavigationItems.map((item) => {
                // Skip org admin items for non-admins
                if (item.orgAdminOnly && !isAdmin) return null;
                const isActive = location.pathname === item.to || location.pathname.startsWith(item.to + '/');
                return (
                  <SidebarMenuItem key={item.name}>
                    <SidebarMenuButton asChild isActive={isActive}>
                      <Link to={item.to}>
                        {item.icon && <item.icon />}
                        <span>{item.name}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        )}

        {/* Superadmin menu items (visible to superadmins when in org context) */}
        {orgSlug && isSuperadmin && (
          <>
            <SidebarSeparator />
            <SidebarGroup>
              <SidebarGroupLabel>
                <Shield className="h-3 w-3 mr-1" />
                Superadmin
              </SidebarGroupLabel>
              <SidebarMenu>
                {superadminItems.map((item) => {
                  const isActive = location.pathname === item.to;
                  return (
                    <SidebarMenuItem key={item.name}>
                      <SidebarMenuButton asChild isActive={isActive}>
                        <Link to={item.to}>
                          {item.icon && <item.icon />}
                          <span>{item.name}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          </>
        )}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          {orgSlug && (
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={location.pathname === `/org/${orgSlug}/settings`}>
                <Link to={`/org/${orgSlug}/settings`}>
                  <Settings />
                  <span>Settings</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <Link to="/dashboard">
                <Building2 />
                <span>Switch Org</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
