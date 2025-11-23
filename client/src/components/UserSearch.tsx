import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { User } from "@shared/schema";
import { ScrollArea } from "@/components/ui/scroll-area";

interface UserSearchProps {
  onUserSelect: (user: User) => void;
  filterUserType?: "social" | "organizer";
  placeholder?: string;
  excludeUserId?: string;
}

export function UserSearch({ onUserSelect, filterUserType, placeholder, excludeUserId }: UserSearchProps) {
  const [searchQuery, setSearchQuery] = useState("");

  const { data: users, isLoading } = useQuery<User[]>({
    queryKey: ["/api/users/search", searchQuery],
    queryFn: async () => {
      if (!searchQuery.trim()) return [];
      const response = await fetch(`/api/users/search?q=${encodeURIComponent(searchQuery)}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to search users");
      return response.json();
    },
    enabled: searchQuery.length > 0,
  });

  const filteredUsers = users?.filter((user) => {
    if (filterUserType && user.userType !== filterUserType) return false;
    if (excludeUserId && user.id === excludeUserId) return false;
    return true;
  });

  return (
    <div className="space-y-2">
      <Input
        type="text"
        placeholder={placeholder || "Search users..."}
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        data-testid="input-user-search"
      />
      
      {searchQuery && (
        <ScrollArea className="h-[300px] rounded-md border">
          {isLoading ? (
            <div className="p-4 text-sm text-muted-foreground">Searching...</div>
          ) : filteredUsers && filteredUsers.length > 0 ? (
            <div className="p-2 space-y-1">
              {filteredUsers.map((user) => (
                <button
                  key={user.id}
                  onClick={() => onUserSelect(user)}
                  className="w-full flex items-center gap-3 p-2 rounded-md hover-elevate active-elevate-2 text-left"
                  data-testid={`button-select-user-${user.id}`}
                >
                  <Avatar>
                    <AvatarFallback>
                      {user.userType === "organizer"
                        ? (user.organizationName?.[0] || user.username[0]).toUpperCase()
                        : (user.displayName?.[0] || user.username[0]).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium text-sm" data-testid={`text-user-name-${user.id}`}>
                      {user.userType === "organizer"
                        ? user.organizationName || user.username
                        : user.displayName || user.username}
                    </p>
                    <p className="text-xs text-muted-foreground">@{user.username}</p>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="p-4 text-sm text-muted-foreground">
              {searchQuery ? "No users found" : "Type to search"}
            </div>
          )}
        </ScrollArea>
      )}
    </div>
  );
}
