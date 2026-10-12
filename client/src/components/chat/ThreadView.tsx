import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { CheckCheck, ChevronLeft, Info, MessageSquare, Search, Users, X } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MessageBubbleSkeleton } from "@/components/ui/skeleton-layouts";
import CreatePollModal from "@/components/CreatePollModal";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { AuthUser } from "@/hooks/useAuth";
import MessageBubble from "./MessageBubble";
import MessageActionsSheet from "./MessageActionsSheet";
import Composer, { type ComposerPayload } from "./Composer";
import GroupInfoSheet from "./GroupInfoSheet";
import SharePickerSheet from "./SharePickerSheet";
import { eventChatClosing } from "./ConversationRow";
import { buildThread, initialOf, otherParticipant, personName, seenStatus } from "./chatUtils";
import type { ChatMessage, ConversationWithDetails } from "./types";
import type { Event } from "@shared/schema";

interface ThreadViewProps {
  conversationId: string;
  currentUser: AuthUser;
  /** Phones only: the list is a separate screen there. Desktop shows list and thread side by side. */
  onBack: () => void;
}

/** One thread for direct chats and groups: same header, bubbles, actions, search and composer. */
export default function ThreadView({ conversationId, currentUser, onBack }: ThreadViewProps) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [actionsFor, setActionsFor] = useState<ChatMessage | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [pollOpen, setPollOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const { data: conversation, isLoading: loadingConversation } = useQuery<ConversationWithDetails>({
    queryKey: ["/api/conversations", conversationId],
  });
  const { data: messages = [], isLoading: loadingMessages } = useQuery<ChatMessage[]>({
    queryKey: ["/api/conversations", conversationId, "messages"],
  });
  const { data: searchResults = [], isLoading: searching } = useQuery<ChatMessage[]>({
    queryKey: ["/api/conversations", conversationId, "messages", "search", searchQuery],
    queryFn: async () => {
      const res = await fetch(`/api/conversations/${conversationId}/messages/search?q=${encodeURIComponent(searchQuery)}`, { credentials: "include" });
      if (!res.ok) throw new Error("Search failed");
      return res.json();
    },
    enabled: searchOpen && searchQuery.trim().length > 0,
  });
  const { data: event } = useQuery<Event>({ queryKey: ["/api/events", conversation?.eventId], enabled: !!conversation?.eventId });

  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchText), 300);
    return () => clearTimeout(t);
  }, [searchText]);

  // New chat: reset transient state and jump to the latest message.
  useEffect(() => {
    setReplyingTo(null);
    setActionsFor(null);
    setSearchOpen(false);
    setSearchText("");
    stick.current = true;
  }, [conversationId]);

  // Opening a chat marks it read on the server; refresh the inbox badges once the messages have loaded.
  useEffect(() => {
    if (!loadingMessages) {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"], exact: true });
      queryClient.invalidateQueries({ queryKey: ["/api/messages/unread-count"] });
    }
  }, [conversationId, loadingMessages, messages.length]);

  const shown = searchOpen ? searchResults : messages;
  const lastShown = shown[shown.length - 1];
  useEffect(() => {
    const el = scroller.current;
    if (!el || searchOpen) return;
    if (stick.current || lastShown?.senderId === currentUser.id) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [shown.length, lastShown?.id, searchOpen, currentUser.id]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [conversationId, loadingMessages]);

  const sendMutation = useMutation({
    mutationFn: async (p: ComposerPayload & { replyToId?: string; eventId?: string; venueId?: string }) => {
      let imageUrls: string[] | undefined;
      if (p.images?.length) {
        const up = await apiRequest("POST", "/api/upload-images", { images: p.images });
        imageUrls = (await up.json()).urls;
      }
      const messageType = p.videoUrl ? "video" : imageUrls?.length ? "image" : p.eventId ? "event" : p.venueId ? "venue" : "text";
      const res = await apiRequest("POST", `/api/conversations/${conversationId}/messages`, {
        content: p.content,
        messageType,
        replyToId: p.replyToId,
        eventId: p.eventId,
        venueId: p.venueId,
        imageUrls,
        videoUrl: p.videoUrl,
      });
      return res.json();
    },
    onSuccess: () => {
      stick.current = true;
      setReplyingTo(null);
      queryClient.invalidateQueries({ queryKey: ["/api/conversations", conversationId, "messages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"], exact: true });
    },
    onError: () => toast({ title: "Couldn't send message", description: "Check your connection and try again.", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (messageId: string) => apiRequest("DELETE", `/api/conversations/${conversationId}/messages/${messageId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations", conversationId, "messages"] });
      // The inbox snippet is re-pointed server-side when the latest message is deleted.
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"], exact: true });
    },
    onError: () => toast({ title: "Couldn't delete message", variant: "destructive" }),
  });

  const send = async (p: ComposerPayload) => {
    try {
      await sendMutation.mutateAsync({ ...p, replyToId: replyingTo?.id });
      return true;
    } catch {
      return false;
    }
  };

  const items = useMemo(() => buildThread(shown, !!conversation?.isGroup), [shown, conversation?.isGroup]);
  const seen = conversation && !searchOpen ? seenStatus(conversation, messages, currentUser.id) : null;
  const lastMessage = messages[messages.length - 1];
  const lastIsOwn = lastMessage?.senderId === currentUser.id && !lastMessage.isDeleted;

  if (loadingConversation) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-3 border-b p-3"><Button variant="ghost" size="icon" className="h-11 w-11 md:hidden" onClick={onBack} aria-label="Back to Messages"><ChevronLeft className="h-6 w-6" /></Button></div>
        <div className="space-y-1 p-4">{[0, 1, 2, 3].map((i) => <MessageBubbleSkeleton key={i} index={i} />)}</div>
      </div>
    );
  }
  if (!conversation) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-muted-foreground">This conversation isn't available any more.</p>
        <Button variant="outline" onClick={onBack}>Back to Messages</Button>
      </div>
    );
  }

  const isGroup = conversation.isGroup;
  const other = isGroup ? undefined : otherParticipant(conversation, currentUser.id)?.user;
  const title = isGroup ? conversation.name || "Group" : other ? personName(other) : "Unknown";
  const closing = event ? eventChatClosing(event.eventDate) : null;
  const sub = isGroup
    ? `${conversation.eventId ? "Event chat · " : ""}${conversation.participants.length} members${closing ? ` · ${closing.toLowerCase()}` : ""}`
    : `@${other?.username ?? ""}${other?.userType === "organizer" ? " · Organiser" : ""}`;

  const openTitle = () => (isGroup ? setInfoOpen(true) : other && navigate(`/profile/${other.username}`));

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="thread-view" data-kind={isGroup ? "group" : "direct"}>
      <header className="flex-shrink-0 border-b bg-background/95 backdrop-blur-sm">
        <div className="flex items-center gap-1 px-2 py-2">
          <Button variant="ghost" size="icon" className="h-11 w-11 flex-none md:hidden" onClick={onBack} aria-label="Back to Messages" data-testid="button-back">
            <ChevronLeft className="h-6 w-6" />
          </Button>
          <button type="button" onClick={openTitle} className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3 rounded-xl px-2 text-left transition-colors hover:bg-muted/60" data-testid="button-thread-title">
            <Avatar className="h-10 w-10 flex-none">
              <AvatarImage src={(isGroup ? conversation.avatarUrl : other?.avatarUrl) || ""} alt={title} />
              <AvatarFallback className="bg-primary/10 text-primary">{isGroup ? <Users className="h-5 w-5" /> : initialOf(title)}</AvatarFallback>
            </Avatar>
            <span className="min-w-0">
              <b className="block truncate font-semibold leading-tight" data-testid="text-thread-title">{title}</b>
              <small className="block truncate text-[13px] leading-tight text-muted-foreground" data-testid="text-thread-sub">{sub}</small>
            </span>
          </button>
          <Button variant="ghost" size="icon" className="h-11 w-11 flex-none" onClick={() => { setSearchOpen((v) => !v); setSearchText(""); }} aria-label="Search this chat" aria-pressed={searchOpen} data-testid="button-toggle-thread-search">
            <Search className="h-5 w-5" />
          </Button>
          {isGroup && (
            <Button variant="ghost" size="icon" className="h-11 w-11 flex-none" onClick={() => setInfoOpen(true)} aria-label="Group info" data-testid="button-group-info">
              <Info className="h-5 w-5" />
            </Button>
          )}
        </div>
        {searchOpen && (
          <div className="relative px-3 pb-3">
            <Search className="absolute left-6 top-1/2 h-4 w-4 -translate-y-[calc(50%+6px)] text-muted-foreground" />
            <Input autoFocus value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Search this chat" className="h-11 rounded-full border-border/40 bg-muted/50 pl-10 pr-10" data-testid="input-thread-search" />
            {searchText && (
              <button type="button" className="absolute right-5 top-1/2 grid h-8 w-8 -translate-y-[calc(50%+6px)] place-items-center rounded-full" onClick={() => setSearchText("")} aria-label="Clear search"><X className="h-4 w-4" /></button>
            )}
          </div>
        )}
      </header>

      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }}
        data-testid="thread-scroll"
      >
        {(searchOpen ? searching : loadingMessages) ? (
          <div className="space-y-1 py-2">{[0, 1, 2, 3].map((i) => <MessageBubbleSkeleton key={i} index={i} />)}</div>
        ) : items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center py-16 text-center">
            <span className="mb-4 grid h-16 w-16 place-items-center rounded-full bg-primary/10"><MessageSquare className="h-7 w-7 text-primary" /></span>
            <p className="font-medium">{searchOpen ? (searchQuery.trim() ? "No matches" : "Search this chat") : "No messages yet"}</p>
            {!searchOpen && <p className="mt-1 text-sm text-muted-foreground">Say hello to start the conversation</p>}
          </div>
        ) : (
          <div className="flex flex-col gap-[3px] pb-1">
            {items.map((it) =>
              it.kind === "day" ? (
                <div key={it.key} className="my-3 self-center rounded-full border bg-card px-3 py-0.5 text-xs uppercase tracking-wider text-muted-foreground">{it.label}</div>
              ) : (
                <MessageBubble
                  key={it.key}
                  message={it.message}
                  isOwn={it.message.senderId === currentUser.id}
                  first={it.first}
                  last={it.last}
                  showSender={it.showSender}
                  currentUserId={currentUser.id}
                  currentUsername={currentUser.username}
                  onOpenActions={setActionsFor}
                />
              ),
            )}
            {seen && lastIsOwn && (
              <p className="mt-0.5 flex items-center justify-end gap-1.5 pr-1 text-xs text-muted-foreground" data-testid="text-seen-indicator">
                <CheckCheck className="h-3.5 w-3.5 text-primary" />{seen.label}
              </p>
            )}
          </div>
        )}
      </div>

      {conversation.blocked ? (
        <div className="border-t px-4 py-3 text-center text-sm text-muted-foreground" data-testid="text-chat-blocked">
          You can't send messages in this chat. You can still read your history.
        </div>
      ) : (
        <Composer
          participants={conversation.participants}
          replyingTo={replyingTo}
          onCancelReply={() => setReplyingTo(null)}
          onSend={send}
          sending={sendMutation.isPending}
          onOpenPoll={() => setPollOpen(true)}
          onOpenShare={() => setShareOpen(true)}
          focusKey={conversationId}
        />
      )}

      <MessageActionsSheet
        message={actionsFor}
        isOwn={actionsFor?.senderId === currentUser.id}
        onClose={() => setActionsFor(null)}
        onReply={setReplyingTo}
        onDelete={(m) => deleteMutation.mutate(m.id)}
      />
      <CreatePollModal open={pollOpen} onOpenChange={setPollOpen} conversationId={conversationId} />
      <SharePickerSheet
        open={shareOpen}
        onOpenChange={setShareOpen}
        onPick={(item) => sendMutation.mutate({ content: "", eventId: item.type === "event" ? item.id : undefined, venueId: item.type === "venue" ? item.id : undefined })}
      />
      {isGroup && (
        <GroupInfoSheet open={infoOpen} onOpenChange={setInfoOpen} conversation={conversation} currentUser={currentUser} onLeft={onBack} />
      )}
    </div>
  );
}
