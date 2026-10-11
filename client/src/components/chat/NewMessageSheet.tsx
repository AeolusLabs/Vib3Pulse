import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { XIcon, Loader2Icon } from "@/components/ui/icons";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { User } from "@shared/schema";
import ChatSheet, { Segmented } from "./ChatSheet";
import PeoplePicker, { personName } from "./PeoplePicker";
import { MAX_GROUP_MEMBERS } from "./types";

type Mode = "chat" | "group";

interface NewMessageSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (conversationId: string) => void;
}

export default function NewMessageSheet({ open, onOpenChange, onCreated }: NewMessageSheetProps) {
  const [mode, setMode] = useState<Mode>("chat");
  const [groupName, setGroupName] = useState("");
  const [selected, setSelected] = useState<User[]>([]);
  const { toast } = useToast();

  useEffect(() => {
    if (!open) {
      setMode("chat");
      setGroupName("");
      setSelected([]);
    }
  }, [open]);

  const done = (conversationId: string) => {
    queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
    onOpenChange(false);
    onCreated(conversationId);
  };

  const directMutation = useMutation({
    mutationFn: async (userId: string) => (await apiRequest("POST", "/api/conversations/direct", { userId })).json(),
    onSuccess: (c) => done(c.id),
    onError: () => toast({ title: "Couldn't start chat", variant: "destructive" }),
  });

  const groupMutation = useMutation({
    mutationFn: async (data: { name: string; participantIds: string[] }) =>
      (await apiRequest("POST", "/api/conversations/group", data)).json(),
    onSuccess: (c) => done(c.id),
    onError: () => toast({ title: "Couldn't create group", variant: "destructive" }),
  });

  // The creator counts toward the server-side cap, so picks + 1 <= MAX_GROUP_MEMBERS.
  const maxPicks = MAX_GROUP_MEMBERS - 1;

  const toggle = (user: User) => {
    if (!selected.some((u) => u.id === user.id) && selected.length >= maxPicks) {
      toast({ title: `Groups are limited to ${MAX_GROUP_MEMBERS} members`, variant: "destructive" });
      return;
    }
    setSelected((prev) =>
      prev.some((u) => u.id === user.id) ? prev.filter((u) => u.id !== user.id) : [...prev, user]
    );
  };

  const canCreate = !!groupName.trim() && selected.length >= 1 && !groupMutation.isPending;

  return (
    <ChatSheet open={open} onOpenChange={onOpenChange} title="New message">
      <div className="px-4 pb-3">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "chat", label: "Chat" },
            { value: "group", label: "Group" },
          ]}
        />
      </div>

      {mode === "group" && (
        <div className="space-y-3 border-t px-4 py-3">
          <Input
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="Group name"
            aria-label="Group name"
            maxLength={100}
            className="h-11"
          />
          {selected.length > 0 && (
            <ul className="flex max-h-24 flex-wrap gap-2 overflow-y-auto">
              {selected.map((u) => (
                <li key={u.id} className="flex items-center gap-1.5 rounded-full border bg-card py-1 pl-1 pr-1 text-xs">
                  <Avatar className="h-6 w-6">
                    <AvatarImage src={u.avatarUrl || ""} alt="" />
                    <AvatarFallback className="text-[10px]">{personName(u)[0]?.toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span className="max-w-[110px] truncate">{personName(u)}</span>
                  <button
                    type="button"
                    onClick={() => toggle(u)}
                    aria-label={`Remove ${personName(u)}`}
                    className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:text-foreground active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            {selected.length + 1}/{MAX_GROUP_MEMBERS} members including you
          </p>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col border-t pt-3">
        {mode === "chat" ? (
          <PeoplePicker onPick={(u) => directMutation.mutate(u.id)} disabled={directMutation.isPending} />
        ) : (
          <PeoplePicker multi selectedIds={selected.map((u) => u.id)} onToggle={toggle} />
        )}
      </div>

      {mode === "group" && (
        <div className="border-t p-4">
          <Button
            className="h-11 w-full active:scale-[0.97]"
            disabled={!canCreate}
            onClick={() => groupMutation.mutate({ name: groupName.trim(), participantIds: selected.map((u) => u.id) })}
          >
            {groupMutation.isPending && <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />}
            Create group
          </Button>
        </div>
      )}
    </ChatSheet>
  );
}
