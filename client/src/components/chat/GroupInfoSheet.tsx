import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  UsersIcon,
  CameraIcon,
  PencilIcon,
  CheckIcon,
  XIcon,
  CopyIcon,
  Link2Icon,
  UserPlusIcon,
  LogOutIcon,
  ShieldIcon,
  UserMinusIcon,
  Trash2Icon,
  MoreVerticalIcon,
  Loader2Icon,
} from "@/components/ui/icons";
import { ObjectUploader } from "@/components/ObjectUploader";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { User } from "@shared/schema";
import type { AuthUser } from "@/hooks/useAuth";
import ChatSheet, { SectionTitle } from "./ChatSheet";
import PeoplePicker, { personName } from "./PeoplePicker";
import { MAX_GROUP_MEMBERS, EVENT_CHAT_CLOSES_AFTER_DAYS, type ConversationWithDetails } from "./types";

interface GroupInfoSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversation: ConversationWithDetails;
  currentUser: AuthUser;
  onLeft: () => void;
}

const rowBtn =
  "flex min-h-[44px] w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors hover:bg-muted/50 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

export default function GroupInfoSheet({ open, onOpenChange, conversation, currentUser, onLeft }: GroupInfoSheetProps) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const id = conversation.id;

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [memberToRemove, setMemberToRemove] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [toAdd, setToAdd] = useState<User[]>([]);

  useEffect(() => {
    if (!open) {
      setRenaming(false);
      setConfirmLeave(false);
      setMemberToRemove(null);
      setAddOpen(false);
      setToAdd([]);
    }
  }, [open]);

  const me = conversation.participants.find((p) => p.userId === currentUser.id);
  const isAdmin = me?.role === "admin";
  const memberCount = conversation.participants.length;
  const isFull = memberCount >= MAX_GROUP_MEMBERS;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/conversations", id] });
    queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
  };

  const renameMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("PATCH", `/api/conversations/${id}`, { name });
      return res.json();
    },
    onSuccess: () => {
      refresh();
      setRenaming(false);
    },
    onError: () => toast({ title: "Couldn't rename group", variant: "destructive" }),
  });

  const roleMutation = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: "admin" | "member" }) => {
      const res = await apiRequest("PATCH", `/api/conversations/${id}/participants/${userId}`, { role });
      return res.json();
    },
    onSuccess: () => {
      refresh();
      toast({ title: "Role updated" });
    },
    onError: () => toast({ title: "Failed to update role", variant: "destructive" }),
  });

  const removeMutation = useMutation({
    mutationFn: async (userId: string) => {
      await apiRequest("DELETE", `/api/conversations/${id}/participants/${userId}`);
    },
    onSuccess: () => {
      refresh();
      setMemberToRemove(null);
      toast({ title: "Member removed" });
    },
    onError: () => toast({ title: "Failed to remove member", variant: "destructive" }),
  });

  const leaveMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/conversations/${id}/participants/${currentUser.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      setConfirmLeave(false);
      onOpenChange(false);
      toast({ title: "Left group" });
      onLeft();
    },
    onError: (error: any) => {
      setConfirmLeave(false);
      toast({ title: "Couldn't leave", description: error?.message, variant: "destructive" });
    },
  });

  const inviteMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/conversations/${id}/invite`);
      if (!res.ok) throw new Error("Failed to generate invite link");
      const data = await res.json();
      if (!data?.inviteCode) throw new Error("Invalid response from server");
      return data as { inviteCode: string };
    },
    onSuccess: async (data) => {
      try {
        await navigator.clipboard.writeText(`${window.location.origin}/join/${data.inviteCode}`);
        setInviteCopied(true);
        setTimeout(() => setInviteCopied(false), 2000);
        toast({ title: "Invite link copied" });
      } catch {
        toast({ title: "Invite code: " + data.inviteCode });
      }
    },
    onError: () => toast({ title: "Failed to generate invite", variant: "destructive" }),
  });

  // POST /participants takes one { userId } per call, so add sequentially and report partial failures.
  const addMutation = useMutation({
    mutationFn: async (users: User[]) => {
      let added = 0;
      for (const u of users) {
        const res = await apiRequest("POST", `/api/conversations/${id}/participants`, { userId: u.id });
        if (!res.ok) break;
        added++;
      }
      return { added, total: users.length };
    },
    onSuccess: ({ added, total }) => {
      refresh();
      if (added === total) {
        toast({ title: added === 1 ? "Member added" : `${added} members added` });
        setAddOpen(false);
        setToAdd([]);
      } else {
        toast({ title: `Added ${added} of ${total}`, description: "The group may be full.", variant: "destructive" });
        setToAdd([]);
      }
    },
    onError: () => {
      refresh();
      toast({ title: "Failed to add members", variant: "destructive" });
    },
  });

  const room = MAX_GROUP_MEMBERS - memberCount;
  const toggleAdd = (u: User) => {
    if (!toAdd.some((x) => x.id === u.id) && toAdd.length >= room) {
      toast({ title: `Groups are limited to ${MAX_GROUP_MEMBERS} members`, variant: "destructive" });
      return;
    }
    setToAdd((prev) => (prev.some((x) => x.id === u.id) ? prev.filter((x) => x.id !== u.id) : [...prev, u]));
  };

  const saveName = () => {
    const name = nameDraft.trim();
    if (!name || name === conversation.name) {
      setRenaming(false);
      return;
    }
    renameMutation.mutate(name);
  };

  return (
    <>
      <ChatSheet open={open} onOpenChange={onOpenChange} title="Group info" hideHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pb-6">
          {/* Hero */}
          <div className="flex flex-col items-center px-4 pb-5 pt-8 text-center">
            <div className="relative">
              <Avatar className="h-24 w-24">
                <AvatarImage src={conversation.avatarUrl || ""} alt={conversation.name || "Group"} />
                <AvatarFallback className="bg-primary/10 text-primary">
                  <UsersIcon className="h-10 w-10" />
                </AvatarFallback>
              </Avatar>
            </div>
            {isAdmin && (
              <div className="mt-3">
                <ObjectUploader
                  onComplete={async (urls: string[]) => {
                    if (!urls[0]) return;
                    const res = await apiRequest("PATCH", `/api/conversations/${id}/avatar`, { avatarPath: urls[0] });
                    if (res.ok) {
                      refresh();
                      toast({ title: "Group avatar updated" });
                    } else {
                      toast({ title: "Failed to update avatar", variant: "destructive" });
                    }
                  }}
                  buttonVariant="ghost"
                  buttonSize="sm"
                  buttonClassName="h-11 text-primary active:scale-[0.97]"
                >
                  <CameraIcon className="mr-2 h-4 w-4" />
                  Change photo
                </ObjectUploader>
              </div>
            )}

            {renaming ? (
              <form
                className="mt-2 flex w-full max-w-xs items-center gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveName();
                }}
              >
                <Input
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  aria-label="Group name"
                  maxLength={100}
                  className="h-11"
                />
                <Button type="submit" size="icon" variant="ghost" className="h-11 w-11 shrink-0" aria-label="Save name" disabled={renameMutation.isPending}>
                  {renameMutation.isPending ? <Loader2Icon className="h-4 w-4 animate-spin" /> : <CheckIcon className="h-4 w-4" />}
                </Button>
                <Button type="button" size="icon" variant="ghost" className="h-11 w-11 shrink-0" aria-label="Cancel rename" onClick={() => setRenaming(false)}>
                  <XIcon className="h-4 w-4" />
                </Button>
              </form>
            ) : (
              <div className="mt-2 flex max-w-full items-center gap-1">
                <h2 className="truncate font-serif text-3xl font-semibold tracking-tight">{conversation.name || "Group"}</h2>
                {isAdmin && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-11 w-11 shrink-0 active:scale-[0.97]"
                    aria-label="Rename group"
                    onClick={() => {
                      setNameDraft(conversation.name || "");
                      setRenaming(true);
                    }}
                  >
                    <PencilIcon className="h-4 w-4" />
                  </Button>
                )}
              </div>
            )}
            <p className="text-sm text-muted-foreground">
              {memberCount} {memberCount === 1 ? "member" : "members"}
            </p>
            {conversation.eventId && (
              <div className="mt-3 space-y-0.5">
                <SectionTitle>Event chat</SectionTitle>
                <p className="text-xs text-muted-foreground">
                  Closes automatically {EVENT_CHAT_CLOSES_AFTER_DAYS} days after the event
                </p>
              </div>
            )}
          </div>

          {/* Invite link */}
          {isAdmin && (
            <section className="border-t px-4 py-4">
              <SectionTitle>Invite link</SectionTitle>
              <div className="mt-2 flex items-center gap-3">
                <Link2Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                  {isFull ? `Group full (${MAX_GROUP_MEMBERS} max)` : "Anyone with the link can join"}
                </p>
                <Button
                  variant="outline"
                  className="h-11 shrink-0 active:scale-[0.97]"
                  disabled={isFull || inviteMutation.isPending}
                  onClick={() => inviteMutation.mutate()}
                >
                  {inviteMutation.isPending ? (
                    <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
                  ) : inviteCopied ? (
                    <CheckIcon className="mr-2 h-4 w-4" />
                  ) : (
                    <CopyIcon className="mr-2 h-4 w-4" />
                  )}
                  {inviteCopied ? "Copied" : "Copy"}
                </Button>
              </div>
            </section>
          )}

          {/* Members */}
          <section className="border-t pt-4">
            <div className="px-4 pb-1">
              <SectionTitle>Members</SectionTitle>
            </div>
            {isAdmin && (
              <button type="button" className={`${rowBtn} text-primary`} onClick={() => setAddOpen(true)} disabled={isFull}>
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                  <UserPlusIcon className="h-5 w-5" />
                </span>
                <span className="font-medium">{isFull ? `Group full (${MAX_GROUP_MEMBERS} max)` : "Add members"}</span>
              </button>
            )}
            <ul className="divide-y divide-border">
              {conversation.participants.map((p) => {
                const isMe = p.userId === currentUser.id;
                return (
                  <li key={p.userId} className="flex items-center">
                    <button type="button" className={`${rowBtn} min-w-0 flex-1`} onClick={() => navigate(`/profile/${p.user.username}`)}>
                      <Avatar className="h-10 w-10">
                        <AvatarImage src={p.user.avatarUrl || ""} alt="" />
                        <AvatarFallback>{personName(p.user)[0]?.toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">
                          {personName(p.user)}
                          {isMe && " (You)"}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">@{p.user.username}</span>
                      </span>
                      {p.role === "admin" && (
                        <span className="flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                          <ShieldIcon className="h-3 w-3" />
                          Admin
                        </span>
                      )}
                    </button>
                    {isAdmin && !isMe && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="mr-2 h-11 w-11 shrink-0" aria-label={`Actions for ${personName(p.user)}`}>
                            <MoreVerticalIcon className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {p.role === "member" ? (
                            <DropdownMenuItem onClick={() => roleMutation.mutate({ userId: p.userId, role: "admin" })}>
                              <ShieldIcon className="mr-2 h-4 w-4" />
                              Make admin
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onClick={() => roleMutation.mutate({ userId: p.userId, role: "member" })}>
                              <UserMinusIcon className="mr-2 h-4 w-4" />
                              Remove admin
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive" onClick={() => setMemberToRemove(p.userId)}>
                            <Trash2Icon className="mr-2 h-4 w-4" />
                            Remove from group
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <div className="border-t px-4 pt-4">
            <Button
              variant="outline"
              className="h-11 w-full text-destructive hover:text-destructive active:scale-[0.97]"
              onClick={() => setConfirmLeave(true)}
            >
              <LogOutIcon className="mr-2 h-4 w-4" />
              Leave group
            </Button>
          </div>
        </div>
      </ChatSheet>

      {/* Add members picker */}
      <ChatSheet open={addOpen} onOpenChange={(o) => { setAddOpen(o); if (!o) setToAdd([]); }} title="Add members" description={`${memberCount}/${MAX_GROUP_MEMBERS} members`}>
        <div className="flex min-h-0 flex-1 flex-col">
          <PeoplePicker
            multi
            selectedIds={toAdd.map((u) => u.id)}
            onToggle={toggleAdd}
            excludeIds={conversation.participants.map((p) => p.userId)}
            disabled={addMutation.isPending}
          />
        </div>
        <div className="border-t p-4">
          <Button className="h-11 w-full active:scale-[0.97]" disabled={toAdd.length === 0 || addMutation.isPending} onClick={() => addMutation.mutate(toAdd)}>
            {addMutation.isPending && <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />}
            {toAdd.length > 0 ? `Add ${toAdd.length}` : "Add"}
          </Button>
        </div>
      </ChatSheet>

      <AlertDialog open={confirmLeave} onOpenChange={setConfirmLeave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave group?</AlertDialogTitle>
            <AlertDialogDescription>You'll no longer receive messages from this group.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                leaveMutation.mutate();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {leaveMutation.isPending && <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />}
              Leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!memberToRemove} onOpenChange={(o) => !o && setMemberToRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove member?</AlertDialogTitle>
            <AlertDialogDescription>They'll no longer be able to see or send messages in this group.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (memberToRemove) removeMutation.mutate(memberToRemove);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removeMutation.isPending && <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />}
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
