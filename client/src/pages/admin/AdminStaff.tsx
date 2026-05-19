import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import AdminLayout from "./AdminLayout";
import { format } from "date-fns";
import { PlusIcon, ShieldIcon, UserXIcon, EditIcon } from "@/components/ui/icons";

type AdminRole = "super_admin" | "content_moderator" | "user_support" | "event_reviewer" | "finance_manager" | "analytics_viewer";

interface AdminUser {
  id: string;
  username: string;
  email: string;
  displayName: string;
  role: AdminRole;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

const roleLabels: Record<AdminRole, string> = {
  super_admin: "Super Admin",
  content_moderator: "Content Moderator",
  user_support: "User Support",
  event_reviewer: "Event Reviewer",
  finance_manager: "Finance Manager",
  analytics_viewer: "Analytics Viewer",
};

const roleColors: Record<AdminRole, string> = {
  super_admin: "border-purple-500 text-purple-400",
  content_moderator: "border-blue-500 text-blue-400",
  user_support: "border-green-500 text-green-400",
  event_reviewer: "border-amber-500 text-amber-400",
  finance_manager: "border-emerald-500 text-emerald-400",
  analytics_viewer: "border-slate-500 text-slate-400",
};

export default function AdminStaff() {
  const { toast } = useToast();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [formData, setFormData] = useState({
    username: "",
    email: "",
    password: "",
    displayName: "",
    role: "content_moderator" as AdminRole,
  });

  const { data: admins, isLoading } = useQuery<AdminUser[]>({
    queryKey: ["/api/admin/users/admins"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      const response = await apiRequest("POST", "/api/admin/users/admins", data);
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Admin created",
        description: "The new admin account has been created successfully",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users/admins"] });
      setCreateDialogOpen(false);
      setFormData({
        username: "",
        email: "",
        password: "",
        displayName: "",
        role: "content_moderator",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Failed to create admin",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: async (adminId: string) => {
      const response = await apiRequest("POST", `/api/admin/users/admins/${adminId}/deactivate`);
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Admin deactivated",
        description: "The admin account has been deactivated",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users/admins"] });
    },
    onError: (error: any) => {
      toast({
        title: "Failed to deactivate admin",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleCreate = () => {
    if (!formData.username || !formData.email || !formData.password || !formData.displayName) {
      toast({
        title: "Missing fields",
        description: "Please fill in all required fields",
        variant: "destructive",
      });
      return;
    }
    createMutation.mutate(formData);
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Staff Management</h1>
            <p className="text-slate-400 mt-1">
              Manage admin users and their access levels
            </p>
          </div>
          <Button
            onClick={() => setCreateDialogOpen(true)}
            className="bg-purple-600 hover:bg-purple-700"
            data-testid="button-create-admin"
          >
            <PlusIcon className="w-4 h-4 mr-2" />
            Add Staff Member
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="bg-slate-800/50 border-slate-700">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-purple-500/20 rounded-lg flex items-center justify-center">
                  <ShieldIcon className="w-5 h-5 text-purple-400" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-white">
                    {admins?.filter(a => a.isActive).length || 0}
                  </p>
                  <p className="text-sm text-slate-400">Active Staff</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-slate-800/50 border-slate-700">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-emerald-500/20 rounded-lg flex items-center justify-center">
                  <ShieldIcon className="w-5 h-5 text-emerald-400" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-white">
                    {admins?.filter(a => a.role === 'super_admin').length || 0}
                  </p>
                  <p className="text-sm text-slate-400">Super Admins</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-slate-800/50 border-slate-700">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-slate-500/20 rounded-lg flex items-center justify-center">
                  <UserXIcon className="w-5 h-5 text-slate-400" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-white">
                    {admins?.filter(a => !a.isActive).length || 0}
                  </p>
                  <p className="text-sm text-slate-400">Deactivated</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader>
            <CardTitle className="text-white">Staff Members</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-8 text-slate-400">Loading staff...</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-700">
                    <TableHead className="text-slate-400">Name</TableHead>
                    <TableHead className="text-slate-400">Email</TableHead>
                    <TableHead className="text-slate-400">Role</TableHead>
                    <TableHead className="text-slate-400">Status</TableHead>
                    <TableHead className="text-slate-400">Last Login</TableHead>
                    <TableHead className="text-slate-400 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {admins?.map((admin) => (
                    <TableRow key={admin.id} className="border-slate-700">
                      <TableCell>
                        <div>
                          <p className="font-medium text-white">{admin.displayName}</p>
                          <p className="text-sm text-slate-400">@{admin.username}</p>
                        </div>
                      </TableCell>
                      <TableCell className="text-slate-300">{admin.email}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={roleColors[admin.role]}>
                          {roleLabels[admin.role]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge 
                          variant="outline" 
                          className={admin.isActive ? "border-green-500 text-green-400" : "border-red-500 text-red-400"}
                        >
                          {admin.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-slate-400">
                        {admin.lastLoginAt 
                          ? format(new Date(admin.lastLoginAt), 'MMM d, h:mm a')
                          : "Never"
                        }
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          {admin.isActive && admin.role !== 'super_admin' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-red-400 hover:text-red-300"
                              onClick={() => {
                                if (confirm("Are you sure you want to deactivate this admin?")) {
                                  deactivateMutation.mutate(admin.id);
                                }
                              }}
                              data-testid={`button-deactivate-admin-${admin.id}`}
                            >
                              <UserXIcon className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogContent className="bg-slate-800 border-slate-700">
            <DialogHeader>
              <DialogTitle className="text-white">Add Staff Member</DialogTitle>
              <DialogDescription className="text-slate-400">
                Create a new admin account with specific role permissions.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label className="text-slate-300">Display Name</Label>
                <Input
                  value={formData.displayName}
                  onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                  placeholder="John Doe"
                  className="bg-slate-700/50 border-slate-600 text-white"
                  data-testid="input-admin-displayname"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-slate-300">Username</Label>
                <Input
                  value={formData.username}
                  onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  placeholder="johndoe"
                  className="bg-slate-700/50 border-slate-600 text-white"
                  data-testid="input-admin-username-create"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-slate-300">Email</Label>
                <Input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder="john@vibepulse.com"
                  className="bg-slate-700/50 border-slate-600 text-white"
                  data-testid="input-admin-email"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-slate-300">Password</Label>
                <Input
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  placeholder="Minimum 8 characters"
                  className="bg-slate-700/50 border-slate-600 text-white"
                  data-testid="input-admin-password-create"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-slate-300">Role</Label>
                <Select 
                  value={formData.role} 
                  onValueChange={(v: AdminRole) => setFormData({ ...formData, role: v })}
                >
                  <SelectTrigger className="bg-slate-700/50 border-slate-600 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-slate-700">
                    <SelectItem value="content_moderator">Content Moderator</SelectItem>
                    <SelectItem value="user_support">User Support</SelectItem>
                    <SelectItem value="event_reviewer">Event Reviewer</SelectItem>
                    <SelectItem value="finance_manager">Finance Manager</SelectItem>
                    <SelectItem value="analytics_viewer">Analytics Viewer</SelectItem>
                    <SelectItem value="super_admin">Super Admin</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-slate-500 mt-1">
                  {formData.role === 'super_admin' && "Full access to all features including staff management"}
                  {formData.role === 'content_moderator' && "Can moderate events, stories, and content reports"}
                  {formData.role === 'user_support' && "Can manage users, view reports, and access activity logs"}
                  {formData.role === 'event_reviewer' && "Can review and approve events"}
                  {formData.role === 'finance_manager' && "Can view financial reports and revenue data"}
                  {formData.role === 'analytics_viewer' && "Read-only access to platform analytics"}
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setCreateDialogOpen(false)}
                className="border-slate-600"
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                disabled={createMutation.isPending}
                className="bg-purple-600 hover:bg-purple-700"
                data-testid="button-confirm-create-admin"
              >
                {createMutation.isPending ? "Creating..." : "Create Admin"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
