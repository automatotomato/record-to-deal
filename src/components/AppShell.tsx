import { ReactNode } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useNavigate, NavLink, Navigate } from "react-router-dom";
import { LogOut, Radar, Settings2, BookOpen, ChevronsUpDown } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  SidebarInset,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";

export const AppShell = ({ children }: { children: ReactNode }) => {
  const { user, loading, isAdmin, signOut } = useAuth();
  const nav = useNavigate();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (!user) return <Navigate to="/auth" replace />;

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full bg-background">
        <Sidebar collapsible="icon">
          <SidebarHeader className="border-b border-sidebar-border">
            <div className="flex items-center gap-2 px-2 py-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
                <Radar className="h-4 w-4" />
              </div>
              <div className="flex flex-col leading-tight group-data-[collapsible=icon]:hidden">
                <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-sidebar-primary">
                  1031
                </span>
                <span className="font-display text-base text-sidebar-foreground">
                  Intelligence Desk
                </span>
              </div>
            </div>
          </SidebarHeader>

          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <NavMenuItem to="/outreach" icon={<Radar />} label="Outreach" />
                  {isAdmin && (
                    <>
                      <NavMenuItem to="/admin" icon={<Settings2 />} label="Sources" />
                      <NavMenuItem to="/project-guide" icon={<BookOpen />} label="Project Guide" />
                    </>
                  )}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>

          <SidebarFooter className="border-t border-sidebar-border">
            <SidebarMenu>
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-sidebar-foreground text-xs font-semibold uppercase">
                        {user.email?.[0] ?? "?"}
                      </div>
                      <div className="grid flex-1 text-left text-xs leading-tight group-data-[collapsible=icon]:hidden">
                        <span className="truncate text-sidebar-foreground">{user.email}</span>
                        <span className="truncate text-[10px] text-sidebar-foreground/60">
                          {isAdmin ? "Admin" : "Member"}
                        </span>
                      </div>
                      <ChevronsUpDown className="ml-auto h-4 w-4 opacity-60 group-data-[collapsible=icon]:hidden" />
                    </SidebarMenuButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="right" align="end" className="w-56">
                    <DropdownMenuLabel className="text-xs font-normal">
                      <div className="flex flex-col">
                        <span className="font-medium">{user.email}</span>
                        <span className="text-muted-foreground">
                          {isAdmin ? "Administrator" : "Member"}
                        </span>
                      </div>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={async () => {
                        await signOut();
                        nav("/auth");
                      }}
                    >
                      <LogOut className="mr-2 h-4 w-4" /> Sign out
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>

        <SidebarInset className="flex flex-col min-w-0">
          <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-border bg-background/80 backdrop-blur px-4">
            <SidebarTrigger />
            <Separator orientation="vertical" className="mx-1 h-5" />
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              1031 Intelligence Desk
            </span>
          </header>
          <main className="flex-1 overflow-auto">{children}</main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
};

const NavMenuItem = ({
  to,
  icon,
  label,
}: {
  to: string;
  icon: ReactNode;
  label: string;
}) => {
  const { setOpenMobile, isMobile } = useSidebar();
  return (
    <SidebarMenuItem>
      <NavLink to={to} end onClick={() => isMobile && setOpenMobile(false)}>
        {({ isActive }) => (
          <SidebarMenuButton isActive={isActive} tooltip={label}>
            {icon}
            <span>{label}</span>
          </SidebarMenuButton>
        )}
      </NavLink>
    </SidebarMenuItem>
  );
};
