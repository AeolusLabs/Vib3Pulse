import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useParams } from "wouter";
import { MessageSquare, Plus, Search, X } from "lucide-react";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConversationItemSkeleton } from "@/components/ui/skeleton-layouts";
import { useAuth } from "@/hooks/useAuth";
import ConversationRow from "@/components/chat/ConversationRow";
import NewMessageSheet from "@/components/chat/NewMessageSheet";
import ThreadView from "@/components/chat/ThreadView";
import { conversationTitle } from "@/components/chat/chatUtils";
import type { ConversationWithDetails } from "@/components/chat/types";

type Filter = "all" | "direct" | "groups" | "unread";

// Phone: the inbox and a thread are separate screens (route-driven). md and up: inbox on the left,
// the open chat on the right, so switching chats is one click.
export default function MessagesPage() {
  const { conversationId } = useParams<{ conversationId?: string }>();
  const [, navigate] = useLocation();
  const { data: currentUser, isLoading: loadingUser } = useAuth();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [newOpen, setNewOpen] = useState(false);

  const { data: conversations, isLoading } = useQuery<ConversationWithDetails[]>({
    queryKey: ["/api/conversations"],
    enabled: !!currentUser,
    refetchOnMount: "always",
    staleTime: 0,
  });

  const unreadTotal = useMemo(() => (conversations ?? []).filter((c) => c.unreadCount > 0).length, [conversations]);

  const visible = useMemo(() => {
    if (!currentUser) return [];
    const q = query.trim().toLowerCase();
    return (conversations ?? []).filter((c) => {
      if (filter === "direct" && c.isGroup) return false;
      if (filter === "groups" && !c.isGroup) return false;
      if (filter === "unread" && c.unreadCount === 0) return false;
      if (!q) return true;
      return conversationTitle(c, currentUser.id).toLowerCase().includes(q) || (c.lastMessagePreview ?? "").toLowerCase().includes(q);
    });
  }, [conversations, filter, query, currentUser]);

  if (loadingUser) {
    return (
      <div className="min-h-screen bg-background pb-20 md:pb-0">
        <Navigation onSearch={() => {}} />
        <main className="mx-auto max-w-2xl px-4 py-6">
          {[0, 1, 2, 3].map((i) => <ConversationItemSkeleton key={i} index={i} />)}
        </main>
        <BottomNavigation />
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <Navigation onSearch={() => {}} />
        <main className="flex flex-1 items-center justify-center px-4 pb-20">
          <div className="text-center">
            <span className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full bg-primary/10"><MessageSquare className="h-7 w-7 text-primary" /></span>
            <h2 className="mb-2 font-serif text-2xl font-bold">Sign in to chat</h2>
            <p className="text-sm text-muted-foreground">Message friends and create group chats</p>
          </div>
        </main>
        <BottomNavigation />
      </div>
    );
  }

  const filters: Array<{ key: Filter; label: string }> = [
    { key: "all", label: "All" },
    { key: "direct", label: "Direct" },
    { key: "groups", label: "Groups" },
    { key: "unread", label: "Unread" },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* A phone thread is full screen, so the top bar only shows on the inbox (and always on desktop). */}
      <div className={conversationId ? "hidden md:block" : ""}><Navigation onSearch={() => {}} /></div>

      <div className={`mx-auto flex w-full max-w-[1200px] md:border-x ${conversationId ? "h-[calc(100dvh-4rem)]" : "h-[calc(100dvh-8rem)]"} md:h-[calc(100dvh-4rem)]`}>
        <section
          className={`min-h-0 w-full flex-col border-r md:flex md:w-[360px] md:flex-none lg:w-[400px] ${conversationId ? "hidden" : "flex"}`}
          aria-label="Conversations"
        >
          <div className="flex items-center gap-3 px-4 pb-2 pt-4">
            <h1 className="flex-1 font-serif text-3xl font-bold leading-none">Messages</h1>
            <Button type="button" variant="outline" size="icon" className="h-11 w-11 rounded-xl" onClick={() => setNewOpen(true)} aria-label="New message" data-testid="button-new-message">
              <Plus className="h-5 w-5" />
            </Button>
          </div>

          <div className="relative px-4 pb-2 pt-1">
            <Search className="pointer-events-none absolute left-7 top-1/2 h-4 w-4 -translate-y-[calc(50%-2px)] text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chats"
              className="h-11 rounded-xl pl-10 pr-10"
              data-testid="input-search-conversations"
            />
            {query && (
              <button type="button" className="absolute right-6 top-1/2 grid h-8 w-8 -translate-y-[calc(50%-2px)] place-items-center rounded-full" onClick={() => setQuery("")} aria-label="Clear search"><X className="h-4 w-4" /></button>
            )}
          </div>

          <div className="flex gap-2 overflow-x-auto px-4 pb-3" role="group" aria-label="Filter conversations">
            {filters.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={`inline-flex min-h-[40px] flex-none items-center gap-1.5 whitespace-nowrap rounded-full border px-4 text-sm font-medium transition-[background-color,transform] active:scale-[0.97] ${
                  filter === f.key ? "border-primary bg-primary text-primary-foreground" : "bg-card hover-elevate"
                }`}
                data-testid={`filter-${f.key}`}
              >
                {f.label}
                {f.key === "unread" && unreadTotal > 0 && <small className="text-xs opacity-85">{unreadTotal}</small>}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto border-t" data-testid="list-conversations">
            {isLoading ? (
              [0, 1, 2, 3].map((i) => <ConversationItemSkeleton key={i} index={i} />)
            ) : (conversations ?? []).length === 0 ? (
              <div className="flex flex-col items-center px-6 py-20 text-center">
                <span className="mb-4 grid h-16 w-16 place-items-center rounded-full bg-primary/10"><MessageSquare className="h-7 w-7 text-primary" /></span>
                <p className="font-semibold">No messages yet</p>
                <p className="mt-1 text-sm text-muted-foreground">Start a chat or create a group</p>
                <Button className="mt-5 h-11" onClick={() => setNewOpen(true)}>New message</Button>
              </div>
            ) : visible.length === 0 ? (
              <p className="px-6 py-16 text-center text-sm text-muted-foreground" data-testid="text-no-matches">
                {query ? "No chats match your search." : filter === "unread" ? "You're all caught up." : "Nothing here yet."}
              </p>
            ) : (
              visible.map((c) => (
                <ConversationRow key={c.id} conv={c} meId={currentUser.id} active={c.id === conversationId} onOpen={(conv) => navigate(`/messages/${conv.id}`)} />
              ))
            )}
          </div>
        </section>

        <section className={`min-h-0 min-w-0 flex-1 flex-col md:flex ${conversationId ? "flex" : "hidden"}`} aria-label="Conversation">
          {conversationId ? (
            <ThreadView key={conversationId} conversationId={conversationId} currentUser={currentUser} onBack={() => navigate("/messages")} />
          ) : (
            <div className="m-auto max-w-xs px-6 text-center" data-testid="empty-thread">
              <span className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full bg-primary/10"><MessageSquare className="h-7 w-7 text-primary" /></span>
              <p className="font-serif text-xl font-bold">Pick a chat</p>
              <p className="mt-1 text-sm text-muted-foreground">Choose a conversation on the left, or start a new one.</p>
            </div>
          )}
        </section>
      </div>

      <BottomNavigation />
      <NewMessageSheet open={newOpen} onOpenChange={setNewOpen} onCreated={(id) => navigate(`/messages/${id}`)} />
    </div>
  );
}
