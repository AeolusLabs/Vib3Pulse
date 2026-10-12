import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { UserXIcon } from "@/components/ui/icons";
import { useBlockedUsers, useUnblock } from "@/components/BlockButton";

export default function BlockedUsersCard() {
  const { data, isLoading } = useBlockedUsers();
  const unblock = useUnblock();
  const blocked = data?.blocked ?? [];

  return (
    <Card data-testid="card-blocked-users">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserXIcon className="h-5 w-5" />
          Blocked users
        </CardTitle>
        <CardDescription>
          People you block can't follow or message you, and neither of you appears on the other's map.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? <Skeleton className="h-10 w-full" /> : blocked.length === 0 ? (
          <p className="text-sm text-muted-foreground">You haven't blocked anyone.</p>
        ) : blocked.map((b) => {
          const name = b.displayName || b.organizationName || b.username;
          return (
            <div key={b.id} className="flex items-center gap-3" data-testid={`blocked-user-${b.id}`}>
              <Avatar className="h-9 w-9">
                <AvatarImage src={b.avatarUrl || undefined} alt="" />
                <AvatarFallback className="bg-primary/15 text-primary">{name.charAt(0).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{name}</p>
                <p className="truncate text-xs text-muted-foreground">@{b.username}</p>
              </div>
              <Button variant="outline" size="sm" className="rounded-full" disabled={unblock.isPending} onClick={() => unblock.mutate(b.id)}>
                Unblock
              </Button>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
