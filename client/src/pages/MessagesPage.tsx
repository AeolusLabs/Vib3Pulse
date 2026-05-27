import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import CreateGroupModal from "@/components/CreateGroupModal";
import GroupChatView from "@/components/GroupChatView";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { format, formatDistanceToNow } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import type { User, Message, Event, Venue, Conversation, ConversationParticipant, ConversationMessage, Story } from "@shared/schema";
import { SendIcon, ArrowLeftIcon, SearchIcon, UserPlusIcon, ReplyIcon, XIcon, CalendarIcon, MapPinIcon, Building2Icon, UsersIcon, PlusIcon, MessageSquareIcon, ChevronDownIcon, ImageIcon, PlayIcon } from "@/components/ui/icons";

type ConversationWithDetails = Conversation & {
  participants: Array<ConversationParticipant & { user: User }>;
  lastMessage: ConversationMessage | null;
  unreadCount: number;
};

function MessageAttachedEvent({ eventId, isOwnMessage }: { eventId: string; isOwnMessage: boolean }) {
  const [, navigate] = useLocation();
  const { data: event } = useQuery<Event>({
    queryKey: ['/api/events', eventId],
    enabled: !!eventId,
  });

  if (!event) return null;

  return (
    <div 
      className={`mt-2 p-2 rounded-lg cursor-pointer ${
        isOwnMessage 
          ? 'bg-primary-foreground/20 hover:bg-primary-foreground/30' 
          : 'bg-background/50 hover:bg-background/70'
      }`}
      onClick={(e) => {
        e.stopPropagation();
        navigate(`/events/${event.id}`);
      }}
    >
      <div className="flex gap-2">
        {event.imageUrl && (
          <img 
            src={event.imageUrl} 
            alt={event.title}
            className="w-12 h-12 rounded object-cover flex-shrink-0"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1 mb-0.5">
            <CalendarIcon className="h-3 w-3" />
            <span className="text-xs font-medium">Event</span>
          </div>
          <p className="text-sm font-medium line-clamp-1">{event.title}</p>
          <p className="text-xs opacity-70 flex items-center gap-1">
            <MapPinIcon className="h-3 w-3" />
            <span className="line-clamp-1">{event.location}</span>
          </p>
        </div>
      </div>
    </div>
  );
}

function MessageAttachedVenue({ venueId, isOwnMessage }: { venueId: string; isOwnMessage: boolean }) {
  const [, navigate] = useLocation();
  const { data: venue } = useQuery<Venue>({
    queryKey: ['/api/venues', venueId],
    enabled: !!venueId,
  });

  if (!venue) return null;

  return (
    <div 
      className={`mt-2 p-2 rounded-lg cursor-pointer ${
        isOwnMessage 
          ? 'bg-primary-foreground/20 hover:bg-primary-foreground/30' 
          : 'bg-background/50 hover:bg-background/70'
      }`}
      onClick={(e) => {
        e.stopPropagation();
        navigate(`/venues/${venue.id}`);
      }}
    >
      <div className="flex gap-2">
        {(venue.coverImageUrl || venue.imageUrl) && (
          <img 
            src={venue.coverImageUrl || venue.imageUrl || ""} 
            alt={venue.name}
            className="w-12 h-12 rounded object-cover flex-shrink-0"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1 mb-0.5">
            <Building2Icon className="h-3 w-3" />
            <span className="text-xs font-medium">Venue</span>
          </div>
          <p className="text-sm font-medium line-clamp-1">{venue.name}</p>
          {venue.city && (
            <p className="text-xs opacity-70 flex items-center gap-1">
              <MapPinIcon className="h-3 w-3" />
              <span className="line-clamp-1">{venue.city}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

type ConversationMessageWithSender = ConversationMessage & {
  sender: User;
  replyTo?: ConversationMessage & { sender: User };
  story?: Story & { user: User };
};

function StoryReplyCard({ story, isOwnMessage }: { story?: Story & { user: User }; isOwnMessage: boolean }) {
  const [, navigate] = useLocation();
  const isExpired = story ? new Date(story.expiresAt) < new Date() : true;
  const isAvailable = !!story && !isExpired;

  return (
    <div className="mb-2.5">
      <div
        role={isAvailable ? "button" : undefined}
        tabIndex={isAvailable ? 0 : undefined}
        className={`relative w-28 h-[198px] rounded-xl overflow-hidden select-none bg-black/30 ${
          isAvailable
            ? "cursor-pointer active:scale-[0.97] transition-transform"
            : "cursor-default opacity-60"
        }`}
        onClick={(e) => {
          if (!isAvailable) return;
          e.stopPropagation();
          navigate(`/stories/${story!.id}`);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && isAvailable) navigate(`/stories/${story!.id}`);
        }}
      >
        {isAvailable ? (
          <img src={story!.imageUrl} alt="Story" className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
            <ImageIcon className={`h-5 w-5 ${isOwnMessage ? "text-white/40" : "text-muted-foreground/60"}`} />
            <p className={`text-[10px] ${isOwnMessage ? "text-white/40" : "text-muted-foreground/60"}`}>
              Story expired
            </p>
          </div>
        )}
        {isAvailable && (
          <>
            {story!.type === "video" && (
              <div className="absolute top-1.5 left-1.5">
                <div className="bg-black/50 rounded-full p-1">
                  <PlayIcon className="h-3 w-3 text-white" />
                </div>
              </div>
            )}
            <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent px-2 py-2">
              <p className="text-white text-[10px] font-medium leading-tight truncate">
                @{story!.user.username}
              </p>
            </div>
          </>
        )}
      </div>
      <p className={`text-[10px] mt-1 ${isOwnMessage ? "text-white/50" : "text-muted-foreground"}`}>
        Replied to story
      </p>
    </div>
  );
}

export default function MessagesPage() {
  const { conversationId } = useParams<{ conversationId?: string }>();
  const [, navigate] = useLocation();
  const [messageText, setMessageText] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [newChatDialogOpen, setNewChatDialogOpen] = useState(false);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [selectedConversation, setSelectedConversation] = useState<ConversationWithDetails | null>(null);
  const [replyingTo, setReplyingTo] = useState<ConversationMessageWithSender | null>(null);
  const [pendingShare, setPendingShare] = useState<{ type: 'event' | 'venue'; id: string; title?: string; name?: string } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const { toast } = useToast();

  const { data: currentUser, isLoading: loadingUser } = useAuth();

  const { data: conversations, isLoading: conversationsLoading } = useQuery<ConversationWithDetails[]>({
    queryKey: ['/api/conversations'],
    enabled: !!currentUser,
    refetchOnMount: 'always',
    staleTime: 0,
  });

  const { data: conversationMessages = [], isLoading: messagesLoading } = useQuery<ConversationMessageWithSender[]>({
    queryKey: ['/api/conversations', conversationId, 'messages'],
    enabled: !!conversationId && !!selectedConversation,
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shareParam = params.get('share');
    let shareData: { type: 'event' | 'venue'; id: string; title?: string; name?: string } | null = null;
    if (shareParam) {
      try { shareData = JSON.parse(decodeURIComponent(shareParam)); } catch {}
      window.history.replaceState({}, '', window.location.pathname);
    }
    if (!shareData) {
      try {
        const stored = localStorage.getItem('shareToMessage');
        if (stored) shareData = JSON.parse(stored);
      } catch {}
    }
    localStorage.removeItem('shareToMessage');
    if (shareData?.type && shareData?.id) setPendingShare(shareData);
  }, []);

  useEffect(() => {
    if (pendingShare && !conversationId) setNewChatDialogOpen(true);
  }, [pendingShare, conversationId]);

  const currentUserId = currentUser?.id;
  const { data: followingList = [], isLoading: followingLoading, refetch: refetchFollowing } = useQuery<User[]>({
    queryKey: ['/api/follows/me/following'],
    enabled: !!currentUserId,
    staleTime: 30000,
    refetchOnMount: true,
  });

  useEffect(() => {
    if (newChatDialogOpen && currentUserId) {
      refetchFollowing();
    }
  }, [newChatDialogOpen, currentUserId, refetchFollowing]);

  const filteredFollowing = followingList.filter(user => {
    if (!debouncedSearchQuery) return true;
    const searchLower = debouncedSearchQuery.toLowerCase();
    return (
      user.username.toLowerCase().includes(searchLower) ||
      (user.displayName?.toLowerCase().includes(searchLower)) ||
      (user.organizationName?.toLowerCase().includes(searchLower))
    );
  });

  useEffect(() => {
    if (conversationId && conversations) {
      const found = conversations.find((c) => c.id === conversationId);
      if (found) {
        setSelectedConversation(found);
      }
    } else if (!conversationId) {
      setSelectedConversation(null);
    }
    setReplyingTo(null);
  }, [conversationId, conversations]);

  const createDirectConversationMutation = useMutation({
    mutationFn: async (userId: string) => {
      const response = await apiRequest("POST", "/api/conversations/direct", { userId });
      return response.json();
    },
    onSuccess: (conversation) => {
      queryClient.invalidateQueries({ queryKey: ['/api/conversations'] });
      setNewChatDialogOpen(false);
      setSearchQuery("");
      navigate(`/messages/${conversation.id}`);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to start conversation", variant: "destructive" });
    },
  });

  const sendMessageMutation = useMutation({
    mutationFn: async ({ content, replyToId, eventId, venueId }: {
      content: string;
      replyToId?: string;
      eventId?: string;
      venueId?: string;
    }) => {
      return await apiRequest('POST', `/api/conversations/${conversationId}/messages`, {
        content,
        messageType: eventId ? 'event' : venueId ? 'venue' : 'text',
        replyToId,
        eventId,
        venueId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/conversations', conversationId, 'messages'] });
      queryClient.invalidateQueries({ queryKey: ['/api/conversations'] });
      setMessageText("");
      setReplyingTo(null);
      setPendingShare(null);
    },
  });

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'new_message' || data.type === 'message_sent' || data.type === 'message_read') {
          queryClient.invalidateQueries({ queryKey: ['/api/conversations'] });
          if (conversationId) {
            queryClient.invalidateQueries({ queryKey: ['/api/conversations', conversationId, 'messages'] });
          }
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, [conversationId]);

  const handleSendMessage = () => {
    if ((messageText.trim() || pendingShare) && conversationId) {
      sendMessageMutation.mutate({
        content: messageText.trim() || (pendingShare?.type === 'event'
          ? `Check out this event: ${pendingShare.title}`
          : `Check out this venue: ${pendingShare?.name}`),
        replyToId: replyingTo?.id,
        eventId: pendingShare?.type === 'event' ? pendingShare.id : undefined,
        venueId: pendingShare?.type === 'venue' ? pendingShare.id : undefined,
      });
    }
  };

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [conversationMessages]);

  useEffect(() => {
    if (conversationId && inputRef.current) {
      inputRef.current.focus();
    }
  }, [conversationId]);

  const formatMessageTime = (date: Date) => {
    const now = new Date();
    const messageDate = new Date(date);
    const diffInHours = (now.getTime() - messageDate.getTime()) / (1000 * 60 * 60);
    
    if (diffInHours < 24) {
      return format(messageDate, 'p');
    } else if (diffInHours < 168) {
      return format(messageDate, 'EEE p');
    } else {
      return format(messageDate, 'MMM d, p');
    }
  };

  const handleBack = () => {
    navigate('/messages');
    setSelectedConversation(null);
  };

  const handleGroupCreated = (id: string) => {
    navigate(`/messages/${id}`);
  };

  const handleSelectConversation = (conv: ConversationWithDetails) => {
    navigate(`/messages/${conv.id}`);
  };

  if (loadingUser) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <Navigation onSearch={() => {}} />
        <main className="flex-1 container mx-auto px-4 py-6 pb-20 max-w-2xl">
          <Skeleton className="h-10 w-48 mb-6" />
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        </main>
        <BottomNavigation />
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <Navigation onSearch={() => {}} />
        <main className="flex-1 flex items-center justify-center px-4 pb-20">
          <div className="text-center">
            <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
              <MessageSquareIcon className="h-7 w-7 text-primary" />
            </div>
            <h2 className="text-xl font-semibold mb-2">Sign in to chat</h2>
            <p className="text-muted-foreground text-sm">Message friends and create group chats</p>
          </div>
        </main>
        <BottomNavigation />
      </div>
    );
  }

  if (conversationId && selectedConversation?.isGroup) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <div className="flex-1 h-[calc(100vh-64px)]">
          <GroupChatView
            conversationId={conversationId}
            currentUser={currentUser}
            onBack={handleBack}
          />
        </div>
        <BottomNavigation />
      </div>
    );
  }

  if (conversationId && selectedConversation && !selectedConversation.isGroup) {
    const otherParticipant = selectedConversation.participants.find(
      (p) => p.userId !== currentUser.id
    );
    const otherUser = otherParticipant?.user;

    return (
      <div className="h-[calc(100dvh-4rem)] md:h-dvh bg-background flex flex-col overflow-hidden">
        {/* Sticky chat header */}
        <div className="flex-shrink-0 border-b border-border/50 bg-background/95 backdrop-blur-sm">
          <Navigation onSearch={() => {}} />
          <div className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full h-9 w-9 text-muted-foreground hover:text-foreground"
              onClick={handleBack}
              data-testid="button-back"
            >
              <ArrowLeftIcon className="h-5 w-5" />
            </Button>
            {otherUser && (
              <>
                <Avatar className="h-9 w-9 ring-2 ring-primary/20">
                  <AvatarImage src={otherUser.avatarUrl || ""} alt={otherUser.displayName || otherUser.username} />
                  <AvatarFallback className="bg-primary/10 text-primary font-semibold text-sm">
                    {(otherUser.displayName || otherUser.organizationName || otherUser.username).charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm text-foreground leading-tight truncate" data-testid="text-other-user-name">
                    {otherUser.displayName || otherUser.organizationName || otherUser.username}
                  </p>
                  <p className="text-xs text-muted-foreground leading-tight">@{otherUser.username}</p>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Scrollable messages */}
        <main className="flex-1 overflow-hidden flex flex-col max-w-[1200px] mx-auto w-full px-4 sm:px-6 lg:px-8">
          <ScrollArea className="flex-1 py-4">
            {messagesLoading ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className={`h-12 w-2/3 rounded-2xl ${i % 2 === 0 ? "ml-auto" : ""}`} />
                ))}
              </div>
            ) : conversationMessages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full py-16 text-center">
                <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                  <MessageSquareIcon className="h-7 w-7 text-primary" />
                </div>
                <p className="font-medium text-foreground">No messages yet</p>
                <p className="text-sm text-muted-foreground mt-1">Say hello to start the conversation</p>
              </div>
            ) : (
              <div className="space-y-1">
                {conversationMessages.map((message, idx) => {
                  const isOwnMessage = message.senderId === currentUser?.id;
                  const prevMsg = conversationMessages[idx - 1];
                  const showTimeDivider = !prevMsg ||
                    new Date(message.createdAt).getTime() - new Date(prevMsg.createdAt).getTime() > 5 * 60 * 1000;

                  return (
                    <div key={message.id}>
                      {showTimeDivider && (
                        <p className="text-center text-[11px] text-muted-foreground/60 my-3">
                          {formatMessageTime(message.createdAt)}
                        </p>
                      )}
                      <div
                        className={`flex ${isOwnMessage ? 'justify-end' : 'justify-start'} group mb-0.5`}
                        data-testid={`message-${message.id}`}
                      >
                        <div className={`flex items-end gap-1.5 max-w-[75%] ${isOwnMessage ? 'flex-row-reverse' : 'flex-row'}`}>
                          <div
                            className={`px-4 py-2.5 text-sm leading-relaxed break-words ${
                              isOwnMessage
                                ? 'bg-violet-600 text-white rounded-2xl rounded-br-sm'
                                : 'bg-muted text-foreground rounded-2xl rounded-bl-sm'
                            }`}
                          >
                            {message.messageType === 'story_reply' && (
                              <StoryReplyCard story={message.story} isOwnMessage={isOwnMessage} />
                            )}
                            {message.replyTo && (
                              <div
                                className={`mb-2 px-2 py-1.5 rounded-lg border-l-2 ${
                                  isOwnMessage
                                    ? 'bg-white/10 border-white/50'
                                    : 'bg-background/60 border-primary/40'
                                }`}
                              >
                                <p className={`text-[11px] font-medium flex items-center gap-1 mb-0.5 ${isOwnMessage ? 'text-white/70' : 'text-muted-foreground'}`}>
                                  <ReplyIcon className="h-3 w-3" />
                                  {message.replyTo.sender?.username || 'Unknown'}
                                </p>
                                <p className={`text-xs line-clamp-1 ${isOwnMessage ? 'text-white/60' : 'text-muted-foreground'}`}>
                                  {message.replyTo.content}
                                </p>
                              </div>
                            )}
                            {message.content}
                            {message.eventId && (
                              <MessageAttachedEvent eventId={message.eventId} isOwnMessage={isOwnMessage} />
                            )}
                            {message.venueId && (
                              <MessageAttachedVenue venueId={message.venueId} isOwnMessage={isOwnMessage} />
                            )}
                          </div>
                          <button
                            className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity p-1 text-muted-foreground hover:text-foreground rounded-full hover:bg-muted"
                            onClick={() => { setReplyingTo(message); inputRef.current?.focus(); }}
                            data-testid={`button-reply-${message.id}`}
                          >
                            <ReplyIcon className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
            )}
          </ScrollArea>

          {/* Reply banner + input bar */}
          <div className="flex-shrink-0 pb-4 md:pb-6">
            {pendingShare && (
              <div className="mb-2 px-3 py-2.5 bg-violet-600/10 border border-violet-500/20 rounded-xl flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  {pendingShare.type === 'event'
                    ? <CalendarIcon className="h-4 w-4 text-violet-400 shrink-0" />
                    : <Building2Icon className="h-4 w-4 text-violet-400 shrink-0" />
                  }
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium text-violet-400 leading-none mb-0.5">
                      {pendingShare.type === 'event' ? 'Attaching event' : 'Attaching venue'}
                    </p>
                    <p className="text-sm font-medium text-foreground truncate">
                      {pendingShare.title || pendingShare.name}
                    </p>
                  </div>
                </div>
                <button
                  className="text-muted-foreground hover:text-foreground p-1.5 rounded-full hover:bg-muted transition-colors duration-150 flex-shrink-0"
                  onClick={() => setPendingShare(null)}
                  aria-label="Remove attachment"
                >
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {replyingTo && (
              <div className="mb-2 px-4 py-2.5 bg-muted/60 rounded-xl border border-border/40 flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-primary flex items-center gap-1 mb-0.5">
                    <ReplyIcon className="h-3 w-3" />Replying to @{replyingTo.sender?.username || 'Unknown'}
                  </p>
                  <p className="text-xs text-muted-foreground line-clamp-1">{replyingTo.content}</p>
                </div>
                <button
                  className="text-muted-foreground hover:text-foreground p-0.5 rounded flex-shrink-0"
                  onClick={() => setReplyingTo(null)}
                  data-testid="button-cancel-reply"
                >
                  <XIcon className="h-4 w-4" />
                </button>
              </div>
            )}
            <form
              onSubmit={(e) => { e.preventDefault(); handleSendMessage(); }}
              className="flex items-center gap-2"
            >
              <Input
                ref={inputRef}
                type="text"
                placeholder={pendingShare ? "Add a message (optional)…" : "Type a message…"}
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                className="flex-1 h-11 rounded-full bg-muted/50 border-border/40 focus-visible:ring-1 focus-visible:ring-primary px-5 text-sm"
                data-testid="input-message"
              />
              <button
                type="submit"
                disabled={(!messageText.trim() && !pendingShare) || sendMessageMutation.isPending}
                className="h-11 w-11 rounded-full bg-violet-600 hover:bg-violet-500 disabled:opacity-40 flex items-center justify-center text-white transition-colors flex-shrink-0"
                data-testid="button-send"
              >
                <SendIcon className="h-4 w-4" />
              </button>
            </form>
          </div>
        </main>

        <BottomNavigation />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation onSearch={() => {}} />

      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-bold font-serif text-foreground">Messages</h1>
          
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button data-testid="button-new-message">
                <PlusIcon className="h-4 w-4 mr-2" />
                New Message
                <ChevronDownIcon className="h-4 w-4 ml-2" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem 
                onClick={() => setNewChatDialogOpen(true)}
                data-testid="menu-item-new-chat"
              >
                <MessageSquareIcon className="h-4 w-4 mr-2" />
                New Chat
              </DropdownMenuItem>
              <DropdownMenuItem 
                onClick={() => setCreateGroupOpen(true)}
                data-testid="menu-item-new-group"
              >
                <UsersIcon className="h-4 w-4 mr-2" />
                New Group
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {conversationsLoading ? (
          <div className="rounded-xl border border-border/40 overflow-hidden divide-y divide-border/30">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-4 p-4">
                <Skeleton className="h-14 w-14 rounded-full flex-shrink-0" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-48" />
                </div>
              </div>
            ))}
          </div>
        ) : !conversations || conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <MessageSquareIcon className="h-7 w-7 text-primary" />
            </div>
            <p className="font-semibold text-foreground">No messages yet</p>
            <p className="text-sm text-muted-foreground mt-1">Start a conversation or create a group to chat</p>
          </div>
        ) : (
          <div className="rounded-xl border border-border/40 overflow-hidden divide-y divide-border/30">
            {conversations.map((conv) => {
              const isGroup = conv.isGroup;
              const otherParticipants = conv.participants.filter(
                (p) => p.userId !== currentUser.id
              );
              const hasUnread = conv.unreadCount > 0;

              return (
                <div
                  key={conv.id}
                  className="flex items-center gap-4 p-4 cursor-pointer hover:bg-muted/40 transition-colors"
                  onClick={() => handleSelectConversation(conv)}
                  data-testid={`conversation-${conv.id}`}
                >
                  <div className="relative flex-shrink-0">
                    {isGroup ? (
                      <Avatar className={`h-14 w-14 ${hasUnread ? 'ring-2 ring-violet-500/50' : ''}`}>
                        <AvatarImage src={conv.avatarUrl || ""} alt={conv.name || "Group"} />
                        <AvatarFallback className="bg-primary/10 text-primary">
                          <UsersIcon className="h-5 w-5" />
                        </AvatarFallback>
                      </Avatar>
                    ) : (
                      <Avatar className={`h-14 w-14 ${hasUnread ? 'ring-2 ring-violet-500/50' : ''}`}>
                        <AvatarImage
                          src={otherParticipants[0]?.user.avatarUrl || ""}
                          alt={otherParticipants[0]?.user.displayName || otherParticipants[0]?.user.username}
                        />
                        <AvatarFallback className="bg-primary/10 text-primary font-semibold">
                          {(otherParticipants[0]?.user.displayName || otherParticipants[0]?.user.username || "?")[0].toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                    )}
                    {hasUnread && (
                      <span
                        className="absolute -top-0.5 -right-0.5 h-5 min-w-[20px] flex items-center justify-center rounded-full bg-violet-600 text-white text-[10px] font-bold px-1"
                        data-testid={`badge-unread-${conv.id}`}
                      >
                        {conv.unreadCount}
                      </span>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-0.5 gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <h3 className={`truncate text-sm ${hasUnread ? 'font-bold text-foreground' : 'font-semibold text-foreground/90'}`}>
                          {isGroup
                            ? conv.name
                            : otherParticipants[0]?.user.displayName ||
                              otherParticipants[0]?.user.username ||
                              "Unknown"}
                        </h3>
                        {isGroup && (
                          <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full shrink-0 flex items-center gap-0.5">
                            <UsersIcon className="h-2.5 w-2.5" />
                            {conv.participants.length}
                          </span>
                        )}
                      </div>
                      {conv.lastMessage && (
                        <span className={`text-xs shrink-0 ${hasUnread ? 'text-violet-400 font-medium' : 'text-muted-foreground'}`}>
                          {formatDistanceToNow(new Date(conv.lastMessage.createdAt), { addSuffix: true })}
                        </span>
                      )}
                    </div>
                    <p className={`text-sm truncate ${hasUnread ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                      {conv.lastMessage ? (
                        conv.lastMessage.content ||
                        (conv.lastMessage.messageType === "poll" ? "Poll created" :
                         conv.lastMessage.messageType === "image" ? "Sent an image" :
                         conv.lastMessage.messageType === "event" ? "Shared an event" :
                         conv.lastMessage.messageType === "venue" ? "Shared a venue" :
                         conv.lastMessage.messageType === "post" ? "Shared a post" :
                         "Sent a message")
                      ) : (
                        "Start the conversation"
                      )}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      <BottomNavigation />

      <Dialog open={newChatDialogOpen} onOpenChange={setNewChatDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New Chat</DialogTitle>
            <DialogDescription>
              Choose someone you follow to start a conversation
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            {pendingShare && (
              <div className="flex items-center gap-2.5 px-3 py-2.5 bg-violet-600/10 border border-violet-500/20 rounded-xl">
                {pendingShare.type === 'event'
                  ? <CalendarIcon className="h-4 w-4 text-violet-400 shrink-0" />
                  : <Building2Icon className="h-4 w-4 text-violet-400 shrink-0" />
                }
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] text-violet-400 font-medium leading-none mb-0.5">
                    {pendingShare.type === 'event' ? 'Sharing event' : 'Sharing venue'}
                  </p>
                  <p className="text-sm font-medium text-foreground truncate">
                    {pendingShare.title || pendingShare.name}
                  </p>
                </div>
              </div>
            )}
            <div className="relative">
              <SearchIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Filter by name or username..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
                data-testid="input-filter-following"
              />
            </div>
            
            <ScrollArea className="h-[300px]">
              {followingLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : followingList.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <UserPlusIcon className="h-12 w-12 mx-auto mb-2 opacity-20" />
                  <p>You're not following anyone yet</p>
                  <p className="text-sm mt-1">Follow people to message them</p>
                </div>
              ) : filteredFollowing.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <SearchIcon className="h-12 w-12 mx-auto mb-2 opacity-20" />
                  <p>No matches found</p>
                </div>
              ) : (
                <div className="rounded-xl border border-border/40 overflow-hidden divide-y divide-border/30">
                  {filteredFollowing.map((user) => (
                    <div
                      key={user.id}
                      className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-muted/40 transition-colors"
                      onClick={() => createDirectConversationMutation.mutate(user.id)}
                      data-testid={`following-user-${user.id}`}
                    >
                      <Avatar className="h-10 w-10 ring-2 ring-border/40">
                        <AvatarImage src={user.avatarUrl || ""} alt={user.displayName || user.username} />
                        <AvatarFallback className="bg-primary/10 text-primary font-semibold">
                          {(user.displayName || user.organizationName || user.username).charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm text-foreground truncate">
                          {user.displayName || user.organizationName || user.username}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">@{user.username}</p>
                      </div>
                      {user.userType === "organizer" && (
                        <span className="text-[10px] font-semibold bg-violet-600/20 text-violet-400 px-2 py-0.5 rounded-full shrink-0">
                          Organizer
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>
        </DialogContent>
      </Dialog>

      <CreateGroupModal
        open={createGroupOpen}
        onOpenChange={setCreateGroupOpen}
        onGroupCreated={handleGroupCreated}
      />
    </div>
  );
}
