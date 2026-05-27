import { useState, useMemo, useCallback } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import type { User, Conversation, ConversationParticipant, ConversationMessage } from "@shared/schema";
import {
  Share2Icon,
  SearchIcon,
  CopyIcon,
  NewspaperIcon,
  CheckIcon,
  UsersIcon,
  SendIcon,
  Loader2Icon,
  UploadIcon,
} from "@/components/ui/icons";

export interface ShareData {
  type: "event" | "venue" | "post" | "story";
  id: string;
  title?: string;
  name?: string;
  imageUrl?: string | null;
}

interface UnifiedShareModalProps {
  open: boolean;
  onClose: () => void;
  shareData: ShareData;
}

type ConversationWithDetails = Conversation & {
  participants: Array<ConversationParticipant & { user: User }>;
  lastMessage: ConversationMessage | null;
  unreadCount: number;
};

type ContactItem =
  | { kind: "conversation"; id: string; conv: ConversationWithDetails }
  | { kind: "user"; id: string; user: User };

function getShareUrl(data: ShareData): string {
  const base = window.location.origin;
  if (data.type === "event") return `${base}/event/${data.id}`;
  if (data.type === "venue") return `${base}/discover?venue=${data.id}`;
  if (data.type === "post") return `${base}/posts/${data.id}`;
  return base;
}

function getDisplayName(data: ShareData): string {
  return data.title || data.name || "this item";
}

export default function UnifiedShareModal({
  open,
  onClose,
  shareData,
}: UnifiedShareModalProps) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { data: currentUser } = useAuth();

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isSending, setIsSending] = useState(false);

  const { data: conversations = [], isLoading: convsLoading } = useQuery<ConversationWithDetails[]>({
    queryKey: ["/api/conversations"],
    enabled: open && !!currentUser,
    staleTime: 30000,
  });

  const { data: following = [], isLoading: followingLoading } = useQuery<User[]>({
    queryKey: ["/api/follows/me/following"],
    enabled: open && !!currentUser,
    staleTime: 30000,
  });

  const existingDirectUserIds = useMemo(
    () =>
      new Set(
        conversations
          .filter((c) => !c.isGroup)
          .flatMap((c) =>
            c.participants
              .filter((p) => p.userId !== currentUser?.id)
              .map((p) => p.userId)
          )
      ),
    [conversations, currentUser?.id]
  );

  const allContacts = useMemo<ContactItem[]>(() => {
    const convContacts: ContactItem[] = [...conversations]
      .sort((a, b) => {
        const aTime = a.lastMessage?.createdAt ? new Date(a.lastMessage.createdAt).getTime() : 0;
        const bTime = b.lastMessage?.createdAt ? new Date(b.lastMessage.createdAt).getTime() : 0;
        return bTime - aTime;
      })
      .map((conv) => ({ kind: "conversation", id: conv.id, conv }));

    const newUserContacts: ContactItem[] = following
      .filter((u) => !existingDirectUserIds.has(u.id))
      .map((u) => ({ kind: "user", id: u.id, user: u }));

    return [...convContacts, ...newUserContacts];
  }, [conversations, following, existingDirectUserIds]);

  const filteredContacts = useMemo<ContactItem[]>(() => {
    if (!search.trim()) return allContacts;
    const q = search.toLowerCase();
    return allContacts.filter((contact) => {
      if (contact.kind === "conversation") {
        const conv = contact.conv;
        if (conv.isGroup) return conv.name?.toLowerCase().includes(q) ?? false;
        const other = conv.participants.find((p) => p.userId !== currentUser?.id)?.user;
        return !!(
          other?.username.toLowerCase().includes(q) ||
          other?.displayName?.toLowerCase().includes(q) ||
          (other as any)?.organizationName?.toLowerCase().includes(q)
        );
      }
      const u = contact.user;
      return (
        u.username.toLowerCase().includes(q) ||
        (u.displayName?.toLowerCase().includes(q) ?? false) ||
        ((u as any).organizationName?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [allContacts, search, currentUser?.id]);

  const isLoading = convsLoading || followingLoading;

  const toggleContact = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleClose = () => {
    if (isSending) return;
    setSelected(new Set());
    setSearch("");
    onClose();
  };

  const handlePostToFeed = () => {
    const data =
      shareData.type === "event"
        ? { type: "event", id: shareData.id, title: shareData.title }
        : { type: "venue", id: shareData.id, name: shareData.name };
    sessionStorage.setItem("shareToFeed", JSON.stringify(data));
    navigate("/feed");
    handleClose();
  };

  const handleCopyLink = async () => {
    const url = getShareUrl(shareData);
    await navigator.clipboard.writeText(url);
    toast({ title: "Link copied!", description: "Share link copied to clipboard." });
  };

  const handleShareVia = async () => {
    const url = getShareUrl(shareData);
    const name = getDisplayName(shareData);
    try {
      if (navigator.share) {
        await navigator.share({
          title: name,
          text: `Check out "${name}" on Vib3Pulse`,
          url,
        });
      } else {
        await navigator.clipboard.writeText(url);
        toast({ title: "Link copied!", description: "Share link copied to clipboard." });
      }
    } catch {
      // User cancelled native share sheet — no action needed
    }
  };

  const handleSend = async () => {
    if (selected.size === 0 || isSending) return;
    setIsSending(true);
    let sent = 0;

    for (const contactId of selected) {
      const contact =
        filteredContacts.find((c) => c.id === contactId) ||
        allContacts.find((c) => c.id === contactId);
      if (!contact) continue;

      try {
        let convId: string;

        if (contact.kind === "conversation") {
          convId = contact.conv.id;
        } else {
          const resp = await apiRequest("POST", "/api/conversations/direct", {
            userId: contact.user.id,
          });
          const newConv = await resp.json();
          convId = newConv.id;
        }

        await apiRequest("POST", `/api/conversations/${convId}/messages`, {
          content: "",
          messageType: shareData.type,
          eventId: shareData.type === "event" ? shareData.id : undefined,
          venueId: shareData.type === "venue" ? shareData.id : undefined,
          postId: shareData.type === "post" ? shareData.id : undefined,
        });

        sent++;
      } catch {
        // Continue with remaining recipients
      }
    }

    setIsSending(false);

    if (sent > 0) {
      toast({
        title: "Shared!",
        description: `Sent to ${sent} ${sent === 1 ? "person" : "people"}.`,
      });
    } else {
      toast({ title: "Couldn't send", description: "Something went wrong. Please try again.", variant: "destructive" });
    }

    setTimeout(() => {
      setSelected(new Set());
      setSearch("");
      onClose();
    }, 250);
  };

  const displayName = getDisplayName(shareData);
  const showPostToFeed = shareData.type === "event" || shareData.type === "venue";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent
        className="sm:max-w-md p-0 overflow-hidden gap-0"
        data-testid="modal-unified-share"
      >
        {/* ── Header ──────────────────────────────────────────── */}
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="font-serif flex items-center gap-2 text-base">
            <Share2Icon className="h-4 w-4 text-primary" />
            Share
          </DialogTitle>
        </DialogHeader>

        {/* ── Item preview ────────────────────────────────────── */}
        {displayName && (
          <div className="flex items-center gap-3 px-5 pb-3">
            {shareData.imageUrl && (
              <img
                src={shareData.imageUrl}
                alt={displayName}
                className="w-11 h-11 rounded-lg object-cover flex-shrink-0 border border-border/40"
              />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold truncate text-foreground leading-tight">
                {displayName}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5 capitalize">
                {shareData.type}
              </p>
            </div>
          </div>
        )}

        <Separator />

        {/* ── Quick actions ────────────────────────────────────── */}
        <div
          className={cn(
            "flex items-start justify-center gap-8 px-5 py-4",
            !showPostToFeed && "gap-12"
          )}
        >
          {showPostToFeed && (
            <button
              className="flex flex-col items-center gap-1.5 group cursor-pointer"
              onClick={handlePostToFeed}
              aria-label="Post to Feed"
              data-testid="button-share-post-to-feed"
            >
              <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center transition-colors duration-150 group-hover:bg-primary/20 active:scale-[0.96]">
                <NewspaperIcon className="h-5 w-5 text-primary" />
              </div>
              <span className="text-[11px] font-medium text-muted-foreground group-hover:text-foreground transition-colors duration-150 whitespace-nowrap">
                Post to Feed
              </span>
            </button>
          )}

          <button
            className="flex flex-col items-center gap-1.5 group cursor-pointer"
            onClick={handleCopyLink}
            aria-label="Copy link"
            data-testid="button-share-copy-link"
          >
            <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center transition-colors duration-150 group-hover:bg-primary/20 active:scale-[0.96]">
              <CopyIcon className="h-5 w-5 text-primary" />
            </div>
            <span className="text-[11px] font-medium text-muted-foreground group-hover:text-foreground transition-colors duration-150 whitespace-nowrap">
              Copy Link
            </span>
          </button>

          <button
            className="flex flex-col items-center gap-1.5 group cursor-pointer"
            onClick={handleShareVia}
            aria-label="Share via..."
            data-testid="button-share-via"
          >
            <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center transition-colors duration-150 group-hover:bg-primary/20 active:scale-[0.96]">
              <UploadIcon className="h-5 w-5 text-primary" />
            </div>
            <span className="text-[11px] font-medium text-muted-foreground group-hover:text-foreground transition-colors duration-150 whitespace-nowrap">
              Share via…
            </span>
          </button>
        </div>

        <Separator />

        {/* ── Search ───────────────────────────────────────────── */}
        <div className="relative px-4 pt-3 pb-2">
          <SearchIcon className="absolute left-7 top-1/2 -translate-y-[3px] h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            type="text"
            placeholder="Search people & groups…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 h-9 text-sm rounded-full bg-muted/50 border-border/40 focus-visible:ring-1 focus-visible:ring-primary/60"
            data-testid="input-share-search"
          />
        </div>

        {/* ── Contact list ─────────────────────────────────────── */}
        <ScrollArea className="h-[260px]">
          <div className="px-3 pb-2">
            {isLoading ? (
              <div className="space-y-1 px-1 py-1">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="flex items-center gap-3 px-2 py-2.5">
                    <Skeleton className="h-10 w-10 rounded-full flex-shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3.5 w-28" />
                      <Skeleton className="h-3 w-20" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filteredContacts.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-[200px] text-center">
                <UsersIcon className="h-9 w-9 text-muted-foreground/25 mb-2.5" />
                <p className="text-sm font-medium text-muted-foreground">No people found</p>
                <p className="text-xs text-muted-foreground/70 mt-1">
                  {search ? "Try a different search" : "Follow people to send them things"}
                </p>
              </div>
            ) : (
              <>
                {filteredContacts.length > 0 && !search && (
                  <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-2 pt-1 pb-1.5">
                    People &amp; Groups
                  </p>
                )}
                <div className="space-y-0.5">
                  {filteredContacts.map((contact, index) => {
                    const isSelected = selected.has(contact.id);
                    let name = "";
                    let subtitle = "";
                    let avatarUrl: string | null | undefined;
                    let avatarFallback = "?";
                    let isGroup = false;

                    if (contact.kind === "conversation") {
                      const conv = contact.conv;
                      isGroup = !!conv.isGroup;
                      if (conv.isGroup) {
                        name = conv.name || "Group";
                        subtitle = `${conv.participants.length} members`;
                        avatarUrl = conv.avatarUrl;
                        avatarFallback = (conv.name || "G")[0].toUpperCase();
                      } else {
                        const other = conv.participants.find(
                          (p) => p.userId !== currentUser?.id
                        )?.user;
                        name =
                          other?.displayName ||
                          (other as any)?.organizationName ||
                          other?.username ||
                          "Unknown";
                        subtitle = `@${other?.username}`;
                        avatarUrl = other?.avatarUrl;
                        avatarFallback = name[0]?.toUpperCase() || "?";
                      }
                    } else {
                      const u = contact.user;
                      name = u.displayName || (u as any).organizationName || u.username;
                      subtitle = `@${u.username}`;
                      avatarUrl = u.avatarUrl;
                      avatarFallback = name[0]?.toUpperCase() || "?";
                    }

                    return (
                      <button
                        key={contact.id}
                        className={cn(
                          "w-full flex items-center gap-3 px-2 py-2.5 rounded-xl text-left",
                          "transition-all duration-150 cursor-pointer",
                          "hover:bg-muted/60 active:scale-[0.98]",
                          isSelected && "bg-primary/10 hover:bg-primary/15",
                          "animate-share-contact-in"
                        )}
                        style={{
                          animationDelay: `${Math.min(index * 28, 200)}ms`,
                          animationFillMode: "both",
                        }}
                        onClick={() => toggleContact(contact.id)}
                        data-testid={`share-contact-${contact.id}`}
                      >
                        <Avatar className="h-10 w-10 flex-shrink-0 ring-1 ring-border/30">
                          {isGroup ? (
                            <>
                              <AvatarImage src={avatarUrl || ""} alt={name} />
                              <AvatarFallback className="bg-violet-500/15 text-violet-600 dark:text-violet-400 text-sm font-semibold">
                                <UsersIcon className="h-4 w-4" />
                              </AvatarFallback>
                            </>
                          ) : (
                            <>
                              <AvatarImage src={avatarUrl || ""} alt={name} />
                              <AvatarFallback className="bg-primary/10 text-primary font-semibold text-sm">
                                {avatarFallback}
                              </AvatarFallback>
                            </>
                          )}
                        </Avatar>

                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-foreground truncate leading-tight">
                            {name}
                          </p>
                          <p className="text-xs text-muted-foreground truncate mt-0.5">
                            {subtitle}
                          </p>
                        </div>

                        {isGroup && !isSelected && (
                          <span className="text-[10px] font-semibold bg-violet-500/15 text-violet-600 dark:text-violet-400 px-2 py-0.5 rounded-full flex-shrink-0 mr-1">
                            Group
                          </span>
                        )}

                        <div
                          className={cn(
                            "h-5 w-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all duration-150",
                            isSelected
                              ? "bg-primary border-primary scale-110"
                              : "border-border/50 bg-transparent"
                          )}
                        >
                          {isSelected && (
                            <CheckIcon className="h-3 w-3 text-primary-foreground" />
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </ScrollArea>

        {/* ── Send bar ─────────────────────────────────────────── */}
        <div className="px-4 py-3.5 border-t border-border/40">
          <Button
            className={cn(
              "w-full h-11 text-sm font-semibold transition-all duration-150",
              "active:scale-[0.98]",
              selected.size === 0 && "opacity-60"
            )}
            disabled={selected.size === 0 || isSending}
            onClick={handleSend}
            data-testid="button-share-send"
          >
            {isSending ? (
              <>
                <Loader2Icon className="h-4 w-4 mr-2 animate-spin" />
                Sending…
              </>
            ) : selected.size > 0 ? (
              <>
                <SendIcon className="h-4 w-4 mr-2" />
                Send to {selected.size} {selected.size === 1 ? "person" : "people"}
              </>
            ) : (
              <>
                <SendIcon className="h-4 w-4 mr-2" />
                Send
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}