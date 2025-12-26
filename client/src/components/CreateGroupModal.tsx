import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Search, Users, X, Loader2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { User } from "@shared/schema";

interface CreateGroupModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGroupCreated?: (conversationId: string) => void;
}

export default function CreateGroupModal({ open, onOpenChange, onGroupCreated }: CreateGroupModalProps) {
  const [groupName, setGroupName] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedUsers, setSelectedUsers] = useState<User[]>([]);
  const { toast } = useToast();

  const { data: following } = useQuery<User[]>({
    queryKey: ['/api/follows/me/following'],
    enabled: open,
  });

  const { data: searchResults } = useQuery<User[]>({
    queryKey: ['/api/users/search', searchQuery],
    enabled: open && searchQuery.length >= 2,
  });

  const createGroupMutation = useMutation({
    mutationFn: async (data: { name: string; participantIds: string[] }) => {
      const response = await apiRequest("POST", "/api/conversations/group", data);
      return response.json();
    },
    onSuccess: (conversation) => {
      toast({ title: "Group created!", description: `"${groupName}" is ready` });
      queryClient.invalidateQueries({ queryKey: ['/api/conversations'] });
      setGroupName("");
      setSelectedUsers([]);
      setSearchQuery("");
      onOpenChange(false);
      if (onGroupCreated) {
        onGroupCreated(conversation.id);
      }
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create group", variant: "destructive" });
    },
  });

  const toggleUser = (user: User) => {
    setSelectedUsers((prev) => {
      const isSelected = prev.some((u) => u.id === user.id);
      if (isSelected) {
        return prev.filter((u) => u.id !== user.id);
      }
      return [...prev, user];
    });
  };

  const removeSelectedUser = (userId: string) => {
    setSelectedUsers((prev) => prev.filter((u) => u.id !== userId));
  };

  const handleCreate = () => {
    if (!groupName.trim()) {
      toast({ title: "Enter a group name", variant: "destructive" });
      return;
    }
    if (selectedUsers.length < 1) {
      toast({ title: "Select at least one member", variant: "destructive" });
      return;
    }
    createGroupMutation.mutate({
      name: groupName.trim(),
      participantIds: selectedUsers.map((u) => u.id),
    });
  };

  const usersToShow = searchQuery.length >= 2
    ? searchResults || []
    : following || [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="modal-create-group">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Create Group Chat
          </DialogTitle>
          <DialogDescription>
            Add a name and select members to start a group conversation
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="group-name">Group Name</Label>
            <Input
              id="group-name"
              placeholder="e.g., Friday Night Squad"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              data-testid="input-group-name"
            />
          </div>

          {selectedUsers.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {selectedUsers.map((user) => (
                <Badge
                  key={user.id}
                  variant="secondary"
                  className="flex items-center gap-1 pl-1 pr-2"
                  data-testid={`badge-selected-user-${user.id}`}
                >
                  <Avatar className="h-5 w-5">
                    <AvatarImage src={user.avatarUrl || ""} />
                    <AvatarFallback className="text-[10px]">
                      {user.displayName?.[0] || user.username[0]}
                    </AvatarFallback>
                  </Avatar>
                  <span className="text-xs">{user.displayName || user.username}</span>
                  <button
                    onClick={() => removeSelectedUser(user.id)}
                    className="ml-1 hover:text-destructive"
                    data-testid={`button-remove-user-${user.id}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}

          <div className="space-y-2">
            <Label>Add Members</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search users..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
                data-testid="input-search-members"
              />
            </div>
          </div>

          <ScrollArea className="h-48">
            <div className="space-y-1">
              {usersToShow.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  {searchQuery ? "No users found" : "Follow people to add them to groups"}
                </p>
              ) : (
                usersToShow.map((user) => {
                  const isSelected = selectedUsers.some((u) => u.id === user.id);
                  return (
                    <div
                      key={user.id}
                      className="flex items-center gap-3 p-2 rounded-lg hover-elevate cursor-pointer"
                      onClick={() => toggleUser(user)}
                      data-testid={`user-row-${user.id}`}
                    >
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleUser(user)}
                        data-testid={`checkbox-user-${user.id}`}
                      />
                      <Avatar className="h-9 w-9">
                        <AvatarImage src={user.avatarUrl || ""} />
                        <AvatarFallback>
                          {user.displayName?.[0] || user.username[0]}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {user.displayName || user.username}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          @{user.username}
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>

          <div className="flex gap-2 justify-end">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              data-testid="button-cancel-group"
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={createGroupMutation.isPending || !groupName.trim() || selectedUsers.length < 1}
              data-testid="button-create-group"
            >
              {createGroupMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Group
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
