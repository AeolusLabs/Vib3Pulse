import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { UsersIcon, CalendarIcon, ImageIcon, FlagIcon, DollarSignIcon, ShieldIcon, ActivityIcon, LogOutIcon, MenuIcon, XIcon, ChevronRightIcon, AlertTriangleIcon, MegaphoneIcon, SettingsIcon, LockIcon } from "@/components/ui/icons";
import AdminMfaGate from "./AdminMfaGate";
import { LayoutDashboard } from "lucide-react";

type AdminRole = "super_admin" | "admin" | "content_moderator" | "user_support" | "event_reviewer" | "finance_manager" | "analytics_viewer";

interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: AdminRole;
  isActive: boolean;
  createdAt: string;
  mfa?: { required: boolean; enrolled: boolean; verified: boolean };
}

interface NavItem {
  label: string;
  path: string;
  icon: React.ReactNode;
  roles: AdminRole[];
}

const navItems: NavItem[] = [
  {
    label: "Dashboard",
    path: "/admin/dashboard",
    icon: <LayoutDashboard className="w-5 h-5" />,
    roles: ["super_admin", "admin", "content_moderator", "user_support", "event_reviewer", "finance_manager", "analytics_viewer"],
  },
  {
    label: "Users",
    path: "/admin/users",
    icon: <UsersIcon className="w-5 h-5" />,
    roles: ["super_admin", "admin", "user_support", "content_moderator"],
  },
  {
    label: "Moderation",
    path: "/admin/moderation",
    icon: <FlagIcon className="w-5 h-5" />,
    roles: ["super_admin", "content_moderator", "event_reviewer"],
  },
  {
    label: "Hosts",
    path: "/admin/hosts",
    icon: <UsersIcon className="w-5 h-5" />,
    roles: ["super_admin", "admin"],
  },
  {
    label: "Social events",
    path: "/admin/social-events",
    icon: <ActivityIcon className="w-5 h-5" />,
    roles: ["super_admin", "admin", "content_moderator", "event_reviewer", "analytics_viewer"],
  },
  {
    label: "Reveal access",
    path: "/admin/reveal",
    icon: <LockIcon className="w-5 h-5" />,
    roles: ["super_admin", "content_moderator", "event_reviewer"],
  },
  {
    label: "Moderation settings",
    path: "/admin/moderation-settings",
    icon: <SettingsIcon className="w-5 h-5" />,
    roles: ["super_admin", "admin"],
  },
  {
    label: "Events",
    path: "/admin/events",
    icon: <CalendarIcon className="w-5 h-5" />,
    roles: ["super_admin", "event_reviewer", "content_moderator"],
  },
  {
    label: "Stories",
    path: "/admin/stories",
    icon: <ImageIcon className="w-5 h-5" />,
    roles: ["super_admin", "content_moderator"],
  },
  {
    label: "Reports",
    path: "/admin/reports",
    icon: <FlagIcon className="w-5 h-5" />,
    roles: ["super_admin", "content_moderator", "user_support"],
  },
  {
    label: "Finance",
    path: "/admin/finance",
    icon: <DollarSignIcon className="w-5 h-5" />,
    roles: ["super_admin", "finance_manager"],
  },
  {
    label: "Staff",
    path: "/admin/staff",
    icon: <ShieldIcon className="w-5 h-5" />,
    roles: ["super_admin"],
  },
  {
    label: "Activity Log",
    path: "/admin/activity",
    icon: <ActivityIcon className="w-5 h-5" />,
    roles: ["super_admin", "user_support"],
  },
  {
    label: "SOS Alerts",
    path: "/admin/sos",
    icon: <AlertTriangleIcon className="w-5 h-5 text-amber-400" />,
    roles: ["super_admin", "user_support"],
  },
  {
    label: "Social Media",
    path: "/admin/social",
    icon: <MegaphoneIcon className="w-5 h-5" />,
    roles: ["super_admin", "finance_manager", "analytics_viewer"],
  },
  {
    label: "Settings",
    path: "/admin/settings",
    icon: <SettingsIcon className="w-5 h-5" />,
    roles: ["super_admin", "admin", "content_moderator", "user_support", "event_reviewer", "finance_manager", "analytics_viewer"],
  },
];

const roleLabels: Record<AdminRole, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  content_moderator: "Content Moderator",
  user_support: "User Support",
  event_reviewer: "Event Reviewer",
  finance_manager: "Finance Manager",
  analytics_viewer: "Analytics Viewer",
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { toast } = useToast();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const { data: admin, isLoading, error } = useQuery<AdminUser>({
    queryKey: ["/api/admin/me"],
    retry: false,
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/admin/logout");
    },
    onSuccess: () => {
      queryClient.clear();
      setLocation("/admin");
      toast({
        title: "Logged out",
        description: "You have been logged out of the admin panel",
      });
    },
  });

  useEffect(() => {
    if (error && location !== "/admin") {
      setLocation("/admin");
    }
  }, [error, location, setLocation]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-white">Loading...</div>
      </div>
    );
  }

  if (!admin) {
    return null;
  }

  // Super-admins must enrol in / pass two-factor before any page loads (the server enforces it on every request).
  if (admin.mfa?.required && !admin.mfa.verified) {
    return <AdminMfaGate enrolled={admin.mfa.enrolled} onLogout={() => logoutMutation.mutate()} />;
  }

  const filteredNavItems = navItems.filter(item => 
    item.roles.includes(admin.role)
  );

  // Direct URLs to the social-event admin pages: say so plainly instead of rendering an empty shell
  // (the server refuses these roles regardless; this is just the friendly side of that).
  const SOCIAL_ADMIN_PATHS = ["/admin/moderation", "/admin/hosts", "/admin/social-events", "/admin/reveal", "/admin/moderation-settings"];
  const here = navItems.find((n) => n.path === location);
  const blocked = !!here && SOCIAL_ADMIN_PATHS.includes(here.path) && !here.roles.includes(admin.role);

  return (
    <div className="min-h-screen bg-slate-900 flex">
      <aside className={cn(
        "fixed inset-y-0 left-0 z-50 bg-slate-800 border-r border-slate-700 transition-all duration-300",
        sidebarOpen ? "w-64" : "w-16"
      )}>
        <div className="flex flex-col h-full">
          <div className="p-4 border-b border-slate-700 flex items-center justify-between">
            {sidebarOpen && (
              <div className="flex items-center gap-2">
                <ShieldIcon className="w-6 h-6 text-purple-400" />
                <span className="font-bold text-white">Vib3Pulse Admin</span>
              </div>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="text-slate-400 hover:text-white"
              data-testid="button-toggle-sidebar"
            >
              {sidebarOpen ? <XIcon className="w-5 h-5" /> : <MenuIcon className="w-5 h-5" />}
            </Button>
          </div>

          <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
            {filteredNavItems.map((item) => {
              const isActive = location === item.path;
              return (
                <Link key={item.path} href={item.path}>
                  <div
                    className={cn(
                      "flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors",
                      isActive
                        ? "bg-purple-600/20 text-purple-400"
                        : "text-slate-400 hover:bg-slate-700 hover:text-white"
                    )}
                    data-testid={`nav-${item.label.toLowerCase().replace(" ", "-")}`}
                  >
                    {item.icon}
                    {sidebarOpen && <span>{item.label}</span>}
                    {sidebarOpen && isActive && (
                      <ChevronRightIcon className="w-4 h-4 ml-auto" />
                    )}
                  </div>
                </Link>
              );
            })}
          </nav>

          <div className="p-4 border-t border-slate-700">
            <div className={cn(
              "flex items-center gap-3",
              !sidebarOpen && "justify-center"
            )}>
              <Avatar className="w-8 h-8 bg-purple-600">
                <AvatarFallback className="bg-purple-600 text-white text-sm">
                  {admin.displayName.charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              {sidebarOpen && (
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">
                    {admin.displayName}
                  </p>
                  <p className="text-xs text-slate-400 truncate">
                    {roleLabels[admin.role]}
                  </p>
                </div>
              )}
            </div>
            <Button
              variant="ghost"
              className={cn(
                "mt-3 text-slate-400 hover:text-red-400 hover:bg-red-500/10",
                sidebarOpen ? "w-full justify-start" : "w-full justify-center"
              )}
              onClick={() => logoutMutation.mutate()}
              data-testid="button-admin-logout"
            >
              <LogOutIcon className="w-4 h-4" />
              {sidebarOpen && <span className="ml-2">Logout</span>}
            </Button>
          </div>
        </div>
      </aside>

      <main className={cn(
        "flex-1 transition-all duration-300",
        sidebarOpen ? "ml-64" : "ml-16"
      )}>
        <div className="p-6">
          {blocked ? (
            <div className="mx-auto max-w-md rounded-xl border border-slate-700 bg-slate-800/50 p-8 text-center" data-testid="no-access">
              <p className="font-medium text-white">You don't have access to this page</p>
              <p className="mt-1 text-sm text-slate-400">Your role ({roleLabels[admin.role]}) doesn't include it. Ask a super-admin if you think that's wrong.</p>
            </div>
          ) : children}
        </div>
      </main>
    </div>
  );
}
