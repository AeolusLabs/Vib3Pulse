import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export interface BlockedUser {
  id: string;
  username: string;
  displayName: string | null;
  organizationName: string | null;
  avatarUrl: string | null;
}

export function useBlockedUsers() {
  return useQuery<{ blocked: BlockedUser[] }>({ queryKey: ["/api/blocks"] });
}

export function useUnblock() {
  const { toast } = useToast();
  return useMutation({
    mutationFn: (userId: string) => apiRequest("DELETE", `/api/blocks/${userId}`),
    onSuccess: () => queryClient.invalidateQueries(), // blocks, chats and map all depend on it
    onError: () => toast({ title: "Couldn't unblock", variant: "destructive" }),
  });
}

// Block / unblock another user. Blocking also removes any follow between you and hides you from each
// other on the map; the confirm step says so because it can't be undone by re-following alone.
export default function BlockButton({ userId, name }: { userId: string; name: string }) {
  const { toast } = useToast();
  const { data } = useBlockedUsers();
  const unblock = useUnblock();
  const isBlocked = !!data?.blocked.some((b) => b.id === userId);

  const block = useMutation({
    mutationFn: () => apiRequest("PUT", `/api/blocks/${userId}`),
    onSuccess: () => {
      queryClient.invalidateQueries();
      toast({ title: `Blocked ${name}` });
    },
    onError: () => toast({ title: "Couldn't block this user", variant: "destructive" }),
  });

  if (isBlocked) {
    return (
      <Button variant="ghost" size="sm" className="rounded-full text-muted-foreground" disabled={unblock.isPending} onClick={() => unblock.mutate(userId)} data-testid="button-unblock">
        Unblock
      </Button>
    );
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="rounded-full text-muted-foreground" data-testid="button-block">Block</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Block {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            You will both stop following each other, and neither of you will be able to follow or message the other.
            You will also disappear from each other's maps. You can unblock them any time in Account Settings.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => block.mutate()} data-testid="button-confirm-block">Block</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
