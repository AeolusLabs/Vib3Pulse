import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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

import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import AdminLayout from "./AdminLayout";
import AdminFilterBar from "@/components/admin/AdminFilterBar";
import AdminPagination from "@/components/admin/AdminPagination";
import { exportToCsv } from "@/lib/exportToCsv";
import { format } from "date-fns";
import { BanIcon, EyeIcon, Trash2Icon, CheckCircleIcon, SparklesIcon, DownloadIcon } from "@/components/ui/icons";

const PAGE_LIMIT = 50;

interface ActiveSuspension {
  id: string;
  reason: string;
  isPermanent: boolean;
}

interface User {
  id: string;
  username: string;
  email: string;
  displayName: string | null;
  userType: string;
  createdAt: string;
  activeSuspension: ActiveSuspension | null;
  freePromotionCredits: number;
  organizationName?: string | null;
  bio?: string | null;
  location?: string | null;
  contactEmail?: string | null;
  phoneNumber?: string | null;
  isVerified?: boolean;
  isOfficial?: boolean;
  onboardingComplete?: boolean;
}

export default function AdminUsers() {
  const { toast } = useToast();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [suspendDialogOpen, setSuspendDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [suspendReason, setSuspendReason] = useState("");
  const [isPermanent, setIsPermanent] = useState(false);
  const [creditsDialogOpen, setCreditsDialogOpen] = useState(false);
  const [creditsInput, setCreditsInput] = useState("0");

  // Debounce the search box ~300ms before it drives a refetch, and reset
  // back to the first page whenever the effective search term changes.
  useEffect(() => {
    const handle = setTimeout(() => {
      setSearch(searchInput);
      setOffset(0);
    }, 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const queryUrl = (() => {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_LIMIT));
    params.set("offset", String(offset));
    if (search.trim()) params.set("search", search.trim());
    return `/api/admin/users?${params.toString()}`;
  })();

  const { data, isLoading } = useQuery<{ users: User[]; total: number }>({
    queryKey: [queryUrl],
  });

  // The query key is now the full "/api/admin/users?limit=...&offset=..."
  // URL (so each page/search/filter combo caches separately), so a plain
  // invalidateQueries({ queryKey: ["/api/admin/users"] }) no longer matches
  // it by prefix — match by predicate on the URL prefix instead.
  const invalidateUsers = () => {
    queryClient.invalidateQueries({
      predicate: (query) =>
        typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/admin/users"),
    });
  };

  const suspendMutation = useMutation({
    mutationFn: async (data: { userId: string; reason: string; isPermanent: boolean }) => {
      const response = await apiRequest("POST", `/api/admin/users/${data.userId}/suspend`, {
        reason: data.reason,
        isPermanent: data.isPermanent,
      });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "User suspended", description: "The user has been suspended successfully" });
      invalidateUsers();
      setSuspendDialogOpen(false);
      setSelectedUser(null);
      setSuspendReason("");
      setIsPermanent(false);
    },
    onError: (error: any) => {
      toast({ title: "Failed to suspend user", description: error.message, variant: "destructive" });
    },
  });

  const liftMutation = useMutation({
    mutationFn: async ({ userId, suspensionId }: { userId: string; suspensionId: string }) => {
      const response = await apiRequest("POST", `/api/admin/users/${userId}/suspensions/${suspensionId}/lift`);
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Suspension lifted", description: "The user's suspension has been removed" });
      invalidateUsers();
    },
    onError: (error: any) => {
      toast({ title: "Failed to lift suspension", description: error.message, variant: "destructive" });
    },
  });

  const creditsMutation = useMutation({
    mutationFn: async ({ userId, credits }: { userId: string; credits: number }) => {
      const response = await apiRequest("PATCH", `/api/admin/users/${userId}/promotion-credits`, { credits });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Promotion credits updated" });
      invalidateUsers();
      setCreditsDialogOpen(false);
      setSelectedUser(null);
    },
    onError: (error: any) => {
      toast({ title: "Failed to update promotion credits", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (userId: string) => {
      const response = await apiRequest("DELETE", `/api/admin/users/${userId}`);
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "User deleted", description: "The user account has been permanently deleted" });
      invalidateUsers();
      setDeleteDialogOpen(false);
      setSelectedUser(null);
    },
    onError: (error: any) => {
      toast({ title: "Failed to delete user", description: error.message, variant: "destructive" });
    },
  });

  const users = data?.users || [];
  const total = data?.total || 0;

  const handleSuspend = () => {
    if (selectedUser && suspendReason.trim()) {
      suspendMutation.mutate({ userId: selectedUser.id, reason: suspendReason, isPermanent });
    }
  };

  const handleSaveCredits = () => {
    const parsed = parseInt(creditsInput, 10);
    if (selectedUser && Number.isInteger(parsed) && parsed >= 0) {
      creditsMutation.mutate({ userId: selectedUser.id, credits: parsed });
    }
  };

  const handleExport = () => {
    exportToCsv(
      "users",
      users.map((u) => ({
        id: u.id,
        username: u.username,
        email: u.email,
        displayName: u.displayName,
        userType: u.userType,
        status: u.activeSuspension ? "suspended" : "active",
        freePromotionCredits: u.freePromotionCredits,
        joined: u.createdAt,
      }))
    );
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">User Management</h1>
            <p className="text-slate-400 mt-1">{total} total users</p>
          </div>
        </div>

        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <AdminFilterBar
                search={searchInput}
                onSearchChange={setSearchInput}
                searchPlaceholder="Search users..."
              />
              <Button
                variant="outline"
                size="sm"
                className="border-slate-600 text-slate-300 shrink-0"
                onClick={handleExport}
                disabled={users.length === 0}
                data-testid="button-export-users"
              >
                <DownloadIcon className="w-4 h-4 mr-2" /> Export
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-8 text-slate-400">Loading users...</div>
            ) : users.length === 0 ? (
              <div className="text-center py-8 text-slate-400">No users found</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-700">
                    <TableHead className="text-slate-400">User</TableHead>
                    <TableHead className="text-slate-400">Email</TableHead>
                    <TableHead className="text-slate-400">Type</TableHead>
                    <TableHead className="text-slate-400">Status</TableHead>
                    <TableHead className="text-slate-400">Promo Credits</TableHead>
                    <TableHead className="text-slate-400">Joined</TableHead>
                    <TableHead className="text-slate-400 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user) => (
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
                      <TableCell>
                        {user.activeSuspension ? (
                          <Badge variant="outline" className="border-red-500 text-red-400">Suspended</Badge>
                        ) : (
                          <Badge variant="outline" className="border-green-500 text-green-400">Active</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-slate-300">
                        {user.freePromotionCredits > 0 ? (
                          <Badge variant="outline" className="border-purple-500 text-purple-400">
                            {user.freePromotionCredits}
                          </Badge>
                        ) : (
                          <span className="text-slate-500">0</span>
                        )}
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
                            onClick={() => { setSelectedUser(user); setDetailDialogOpen(true); }}
                            data-testid={`button-view-user-${user.id}`}
                          >
                            <EyeIcon className="w-4 h-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-purple-400 hover:text-purple-300"
                            onClick={() => {
                              setSelectedUser(user);
                              setCreditsInput(String(user.freePromotionCredits));
                              setCreditsDialogOpen(true);
                            }}
                            data-testid={`button-edit-credits-${user.id}`}
                          >
                            <SparklesIcon className="w-4 h-4" />
                          </Button>
                          {user.activeSuspension ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-green-400 hover:text-green-300"
                              onClick={() => liftMutation.mutate({ userId: user.id, suspensionId: user.activeSuspension!.id })}
                              disabled={liftMutation.isPending}
                              data-testid={`button-lift-suspension-${user.id}`}
                            >
                              <CheckCircleIcon className="w-4 h-4" />
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-amber-400 hover:text-amber-300"
                              onClick={() => { setSelectedUser(user); setSuspendDialogOpen(true); }}
                              data-testid={`button-suspend-user-${user.id}`}
                            >
                              <BanIcon className="w-4 h-4" />
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-red-400 hover:text-red-300"
                            onClick={() => { setSelectedUser(user); setDeleteDialogOpen(true); }}
                            data-testid={`button-delete-user-${user.id}`}
                          >
                            <Trash2Icon className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <AdminPagination offset={offset} limit={PAGE_LIMIT} total={total} onOffsetChange={setOffset} />
          </CardContent>
        </Card>

        {/* User Detail Dialog */}
        <Dialog open={detailDialogOpen} onOpenChange={setDetailDialogOpen}>
          <DialogContent className="bg-slate-800 border-slate-700">
            <DialogHeader>
              <DialogTitle className="text-white">User Details</DialogTitle>
              <DialogDescription className="text-slate-400">
                {selectedUser?.displayName || selectedUser?.username}
              </DialogDescription>
            </DialogHeader>
            {selectedUser && (
              <div className="space-y-3 py-2 text-sm">
                <div className="flex justify-between border-b border-slate-700 pb-2">
                  <span className="text-slate-400">Username</span>
                  <span className="text-white">@{selectedUser.username}</span>
                </div>
                <div className="flex justify-between border-b border-slate-700 pb-2">
                  <span className="text-slate-400">Email</span>
                  <span className="text-white">{selectedUser.email}</span>
                </div>
                {selectedUser.organizationName && (
                  <div className="flex justify-between border-b border-slate-700 pb-2">
                    <span className="text-slate-400">Organization</span>
                    <span className="text-white">{selectedUser.organizationName}</span>
                  </div>
                )}
                <div className="flex justify-between border-b border-slate-700 pb-2">
                  <span className="text-slate-400">Account Type</span>
                  <Badge
                    variant="outline"
                    className={selectedUser.userType === 'organizer' ? 'border-purple-500 text-purple-400' : 'border-slate-500 text-slate-400'}
                  >
                    {selectedUser.userType}
                  </Badge>
                </div>
                <div className="flex justify-between border-b border-slate-700 pb-2">
                  <span className="text-slate-400">Joined</span>
                  <span className="text-white">{format(new Date(selectedUser.createdAt), 'MMM d, yyyy')}</span>
                </div>
                <div className="flex justify-between border-b border-slate-700 pb-2">
                  <span className="text-slate-400">Status</span>
                  {selectedUser.activeSuspension ? (
                    <Badge variant="outline" className="border-red-500 text-red-400">Suspended</Badge>
                  ) : (
                    <Badge variant="outline" className="border-green-500 text-green-400">Active</Badge>
                  )}
                </div>
                {selectedUser.activeSuspension && (
                  <div className="border-b border-slate-700 pb-2">
                    <span className="text-slate-400">Suspension reason</span>
                    <p className="text-white mt-1">{selectedUser.activeSuspension.reason}</p>
                    {selectedUser.activeSuspension.isPermanent && (
                      <Badge variant="outline" className="border-red-500 text-red-400 mt-1">Permanent</Badge>
                    )}
                  </div>
                )}
                <div className="flex justify-between border-b border-slate-700 pb-2">
                  <span className="text-slate-400">Promo Credits</span>
                  <span className="text-white">{selectedUser.freePromotionCredits}</span>
                </div>
                {(selectedUser.isVerified || selectedUser.isOfficial) && (
                  <div className="flex justify-between border-b border-slate-700 pb-2">
                    <span className="text-slate-400">Badges</span>
                    <div className="flex gap-2">
                      {selectedUser.isVerified && (
                        <Badge variant="outline" className="border-blue-500 text-blue-400">Verified</Badge>
                      )}
                      {selectedUser.isOfficial && (
                        <Badge variant="outline" className="border-amber-500 text-amber-400">Official</Badge>
                      )}
                    </div>
                  </div>
                )}
                {selectedUser.location && (
                  <div className="flex justify-between">
                    <span className="text-slate-400">Location</span>
                    <span className="text-white">{selectedUser.location}</span>
                  </div>
                )}
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setDetailDialogOpen(false)} className="border-slate-600">
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Suspend Dialog */}
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
              <Button variant="outline" onClick={() => setSuspendDialogOpen(false)} className="border-slate-600">
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

        {/* Promotion Credits Dialog */}
        <Dialog open={creditsDialogOpen} onOpenChange={setCreditsDialogOpen}>
          <DialogContent className="bg-slate-800 border-slate-700">
            <DialogHeader>
              <DialogTitle className="text-white">Free Promotion Credits</DialogTitle>
              <DialogDescription className="text-slate-400">
                Set how many free promotions {selectedUser?.username} can use. Each credit waives payment on
                one event or venue promotion. Currently: {selectedUser?.freePromotionCredits ?? 0}.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-4">
              <Label className="text-slate-300">Credits</Label>
              <Input
                type="number"
                min={0}
                max={1000}
                value={creditsInput}
                onChange={(e) => setCreditsInput(e.target.value)}
                className="bg-slate-700/50 border-slate-600 text-white"
                data-testid="input-promotion-credits"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreditsDialogOpen(false)} className="border-slate-600">
                Cancel
              </Button>
              <Button
                onClick={handleSaveCredits}
                disabled={creditsMutation.isPending}
                data-testid="button-save-promotion-credits"
              >
                {creditsMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Dialog */}
        <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <DialogContent className="bg-slate-800 border-slate-700">
            <DialogHeader>
              <DialogTitle className="text-white">Delete User</DialogTitle>
              <DialogDescription className="text-slate-400">
                Permanently delete <span className="text-white font-medium">@{selectedUser?.username}</span>. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteDialogOpen(false)} className="border-slate-600">
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => selectedUser && deleteMutation.mutate(selectedUser.id)}
                disabled={deleteMutation.isPending}
                data-testid="button-confirm-delete-user"
              >
                {deleteMutation.isPending ? "Deleting..." : "Delete Permanently"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
