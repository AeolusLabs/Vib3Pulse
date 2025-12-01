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
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Search, Ban, UserX, Eye } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import AdminLayout from "./AdminLayout";
import { format } from "date-fns";

interface User {
  id: string;
  username: string;
  email: string;
  displayName: string | null;
  userType: string;
  createdAt: string;
}

export default function AdminUsers() {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [suspendDialogOpen, setSuspendDialogOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [suspendReason, setSuspendReason] = useState("");
  const [isPermanent, setIsPermanent] = useState(false);

  const { data, isLoading } = useQuery<{ users: User[]; total: number }>({
    queryKey: ["/api/admin/users"],
  });

  const suspendMutation = useMutation({
    mutationFn: async (data: { userId: string; reason: string; isPermanent: boolean }) => {
      const response = await apiRequest("POST", `/api/admin/users/${data.userId}/suspend`, {
        reason: data.reason,
        isPermanent: data.isPermanent,
      });
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "User suspended",
        description: "The user has been suspended successfully",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      setSuspendDialogOpen(false);
      setSelectedUser(null);
      setSuspendReason("");
      setIsPermanent(false);
    },
    onError: (error: any) => {
      toast({
        title: "Failed to suspend user",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const filteredUsers = data?.users.filter(user =>
    user.username.toLowerCase().includes(searchQuery.toLowerCase()) ||
    user.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (user.displayName?.toLowerCase().includes(searchQuery.toLowerCase()))
  ) || [];

  const handleSuspend = () => {
    if (selectedUser && suspendReason.trim()) {
      suspendMutation.mutate({
        userId: selectedUser.id,
        reason: suspendReason,
        isPermanent,
      });
    }
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">User Management</h1>
            <p className="text-slate-400 mt-1">
              {data?.total || 0} total users
            </p>
          </div>
        </div>

        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader>
            <div className="flex items-center gap-4">
              <div className="relative flex-1 max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <Input
                  placeholder="Search users..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10 bg-slate-700/50 border-slate-600 text-white"
                  data-testid="input-search-users"
                />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-8 text-slate-400">Loading users...</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-700">
                    <TableHead className="text-slate-400">User</TableHead>
                    <TableHead className="text-slate-400">Email</TableHead>
                    <TableHead className="text-slate-400">Type</TableHead>
                    <TableHead className="text-slate-400">Joined</TableHead>
                    <TableHead className="text-slate-400 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredUsers.map((user) => (
                    <TableRow key={user.id} className="border-slate-700">
                      <TableCell>
                        <div>
                          <p className="font-medium text-white">{user.displayName || user.username}</p>
                          <p className="text-sm text-slate-400">@{user.username}</p>
                        </div>
                      </TableCell>
                      <TableCell className="text-slate-300">{user.email}</TableCell>
                      <TableCell>
                        <Badge 
                          variant="outline" 
                          className={user.userType === 'organizer' ? 'border-purple-500 text-purple-400' : 'border-slate-500 text-slate-400'}
                        >
                          {user.userType}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-slate-400">
                        {format(new Date(user.createdAt), 'MMM d, yyyy')}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-slate-400 hover:text-white"
                            data-testid={`button-view-user-${user.id}`}
                          >
                            <Eye className="w-4 h-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-amber-400 hover:text-amber-300"
                            onClick={() => {
                              setSelectedUser(user);
                              setSuspendDialogOpen(true);
                            }}
                            data-testid={`button-suspend-user-${user.id}`}
                          >
                            <Ban className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Dialog open={suspendDialogOpen} onOpenChange={setSuspendDialogOpen}>
          <DialogContent className="bg-slate-800 border-slate-700">
            <DialogHeader>
              <DialogTitle className="text-white">Suspend User</DialogTitle>
              <DialogDescription className="text-slate-400">
                Suspend {selectedUser?.username}'s account. They will be unable to access the platform.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label className="text-slate-300">Reason for suspension</Label>
                <Textarea
                  value={suspendReason}
                  onChange={(e) => setSuspendReason(e.target.value)}
                  placeholder="Enter the reason for suspension..."
                  className="bg-slate-700/50 border-slate-600 text-white"
                  data-testid="input-suspend-reason"
                />
              </div>
              <div className="flex items-center gap-3">
                <Switch
                  id="permanent"
                  checked={isPermanent}
                  onCheckedChange={setIsPermanent}
                  data-testid="switch-permanent-suspension"
                />
                <Label htmlFor="permanent" className="text-slate-300">
                  Permanent suspension (no expiry)
                </Label>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setSuspendDialogOpen(false)}
                className="border-slate-600"
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleSuspend}
                disabled={!suspendReason.trim() || suspendMutation.isPending}
                data-testid="button-confirm-suspend"
              >
                {suspendMutation.isPending ? "Suspending..." : "Suspend User"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
