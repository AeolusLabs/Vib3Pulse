import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import type { User } from "@shared/schema";
import { UsersIcon, UserPlusIcon } from "@/components/ui/icons";

type FollowUser = Pick<User, "id" | "username" | "displayName" | "organizationName" | "userType">;

interface FollowersFollowingDialogProps {
  userId: string;
  username: string;
  followersCount: number;
  followingCount: number;
  initialTab?: "followers" | "following";
  trigger: React.ReactNode;
}

function UserListItem({ user, onNavigate }: { user: FollowUser; onNavigate: (username: string) => void }) {
  const displayName = user.userType === "social" 
    ? (user.displayName || user.username) 
    : (user.organizationName || user.username);
  
  return (
    <button
      onClick={() => onNavigate(user.username)}
      className="w-full flex items-center gap-3 p-3 hover-elevate rounded-md transition-colors text-left"
      data-testid={`user-item-${user.id}`}
    >
      <Avatar className="h-10 w-10 border border-border">
        <AvatarImage src="" alt={displayName} />
        <AvatarFallback className="bg-primary/10 text-primary text-sm">
          {displayName.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-foreground truncate">{displayName}</p>
        <p className="text-sm text-muted-foreground truncate">@{user.username}</p>
      </div>
    </button>
  );
}

function UserListSkeleton() {
  return (
    <div className="space-y-2">
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex items-center gap-3 p-3">
          <Skeleton className="h-10 w-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ type }: { type: "followers" | "following" }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      {type === "followers" ? (
        <>
          <UsersIcon className="h-12 w-12 text-muted-foreground/50 mb-4" />
          <p className="text-muted-foreground font-medium">No followers yet</p>
          <p className="text-sm text-muted-foreground mt-1">
            When people follow this account, they'll appear here
          </p>
        </>
      ) : (
        <>
          <UserPlusIcon className="h-12 w-12 text-muted-foreground/50 mb-4" />
          <p className="text-muted-foreground font-medium">Not following anyone</p>
          <p className="text-sm text-muted-foreground mt-1">
            When this account follows people, they'll appear here
          </p>
        </>
      )}
    </div>
  );
}

export default function FollowersFollowingDialog({
  userId,
  username,
  followersCount,
  followingCount,
  initialTab = "followers",
  trigger,
}: FollowersFollowingDialogProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"followers" | "following">(initialTab);
  const [, navigate] = useLocation();

  const { data: followers = [], isLoading: loadingFollowers } = useQuery<FollowUser[]>({
    queryKey: [`/api/follows/${userId}/followers`],
    enabled: open && activeTab === "followers",
  });

  const { data: following = [], isLoading: loadingFollowing } = useQuery<FollowUser[]>({
    queryKey: [`/api/follows/${userId}/following`],
    enabled: open && activeTab === "following",
  });

  const handleNavigate = (targetUsername: string) => {
    setOpen(false);
    navigate(`/profile/${targetUsername}`);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px] p-0" data-testid="dialog-followers-following">
        <DialogHeader className="p-6 pb-0">
          <DialogTitle className="text-xl font-semibold">@{username}</DialogTitle>
        </DialogHeader>
        
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "followers" | "following")} className="w-full">
          <TabsList className="w-full grid grid-cols-2 rounded-none border-b bg-transparent h-12">
            <TabsTrigger 
              value="followers" 
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
              data-testid="tab-followers"
            >
              <span className="font-semibold">{followersCount}</span>
              <span className="ml-1 text-muted-foreground">Followers</span>
            </TabsTrigger>
            <TabsTrigger 
              value="following"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
              data-testid="tab-following"
            >
              <span className="font-semibold">{followingCount}</span>
              <span className="ml-1 text-muted-foreground">Following</span>
            </TabsTrigger>
          </TabsList>
          
          <TabsContent value="followers" className="m-0">
            <ScrollArea className="h-[400px]">
              <div className="p-2">
                {loadingFollowers ? (
                  <UserListSkeleton />
                ) : followers.length === 0 ? (
                  <EmptyState type="followers" />
                ) : (
                  <div className="space-y-1">
                    {followers.map((user) => (
                      <UserListItem 
                        key={user.id} 
                        user={user} 
                        onNavigate={handleNavigate}
                      />
                    ))}
                  </div>
                )}
              </div>
            </ScrollArea>
          </TabsContent>
          
          <TabsContent value="following" className="m-0">
            <ScrollArea className="h-[400px]">
              <div className="p-2">
                {loadingFollowing ? (
                  <UserListSkeleton />
                ) : following.length === 0 ? (
                  <EmptyState type="following" />
                ) : (
                  <div className="space-y-1">
                    {following.map((user) => (
                      <UserListItem 
                        key={user.id} 
                        user={user} 
                        onNavigate={handleNavigate}
                      />
                    ))}
                  </div>
                )}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
