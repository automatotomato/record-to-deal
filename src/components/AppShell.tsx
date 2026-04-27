import { ReactNode } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useNavigate, NavLink, Navigate } from "react-router-dom";
import { LogOut, Radar, Settings2 } from "lucide-react";

export const AppShell = ({ children }: { children: ReactNode }) => {
  const { user, loading, isAdmin, signOut } = useAuth();
  const nav = useNavigate();

  if (loading) return <div className="min-h-screen flex items-center justify-center text-xs font-mono uppercase tracking-widest text-muted-foreground">Loading…</div>;
  if (!user) return <Navigate to="/auth" replace />;

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 bg-sidebar text-sidebar-foreground flex flex-col">
        <div className="p-6 border-b border-sidebar-border">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-accent mb-1">1031</div>
          <div className="font-display text-2xl text-sidebar-foreground leading-none">Intelligence<br />Desk</div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          <NavItem to="/outreach" icon={<Radar className="h-3.5 w-3.5" />} label="Outreach" />
          {isAdmin && <NavItem to="/admin" icon={<Settings2 className="h-3.5 w-3.5" />} label="Sources" />}
        </nav>
        <div className="p-4 border-t border-sidebar-border">
          <div className="font-mono text-[10px] uppercase tracking-wider text-sidebar-foreground/50 mb-2 truncate">{user.email}</div>
          <button onClick={async () => { await signOut(); nav("/auth"); }} className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-sidebar-foreground/70 hover:text-accent">
            <LogOut className="h-3 w-3" /> Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
};

const NavItem = ({ to, icon, label }: { to: string; icon: ReactNode; label: string }) => (
  <NavLink
    to={to}
    className={({ isActive }) =>
      `flex items-center gap-2 px-3 py-2 text-xs font-mono uppercase tracking-wider rounded-sm transition-colors ${
        isActive ? "bg-sidebar-accent text-accent" : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
      }`
    }
  >
    {icon} {label}
  </NavLink>
);
