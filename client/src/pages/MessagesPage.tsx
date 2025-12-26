import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import CreateGroupModal from "@/components/CreateGroupModal";
import GroupChatView from "@/components/GroupChatView";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Send, ArrowLeft, Search, UserPlus, Reply, X, Calendar, MapPin, Building2, Users, Plus, MessageSquare, ChevronDown } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import type { User, Message, Event, Venue, Conversation, ConversationParticipant, ConversationMessage } from "@shared/schema";

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
            <Calendar className="h-3 w-3" />
            <span className="text-xs font-medium">Event</span>
          </div>
          <p className="text-sm font-medium line-clamp-1">{event.title}</p>
          <p className="text-xs opacity-70 flex items-center gap-1">
            <MapPin className="h-3 w-3" />
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
            <Building2 className="h-3 w-3" />
            <span className="text-xs font-medium">Venue</span>
          </div>
          <p className="text-sm font-medium line-clamp-1">{venue.name}</p>
          {venue.city && (
            <p className="text-xs opacity-70 flex items-center gap-1">
              <MapPin className="h-3 w-3" />
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
};

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
    mutationFn: async ({ content, replyToId }: { content: string; replyToId?: string }) => {
      return await apiRequest('POST', `/api/conversations/${conversationId}/messages`, {
        content,
        messageType: 'text',
        replyToId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/conversations', conversationId, 'messages'] });
      queryClient.invalidateQueries({ queryKey: ['/api/conversations'] });
      setMessageText("");
      setReplyingTo(null);
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
    if (messageText.trim() && conversationId) {
      sendMessageMutation.mutate({
        content: messageText,
        replyToId: replyingTo?.id,
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
        <main className="flex-1 container mx-auto px-4 py-6 pb-20 max-w-2xl flex items-center justify-center">
          <Card className="w-full max-w-md">
            <CardContent className="pt-6 text-center">
              <MessageSquare className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h2 className="text-xl font-semibold mb-2">Sign in to chat</h2>
              <p className="text-muted-foreground">
                Message friends and create group chats
              </p>
            </CardContent>
          </Card>
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
      <div className="min-h-screen bg-background pb-20 md:pb-0 flex flex-col">
        <Navigation onSearch={() => {}} />

        <main className="flex-1 flex flex-col max-w-[1200px] mx-auto w-full px-4 sm:px-6 lg:px-8 py-8">
          <Card className="mb-4">
            <CardHeader className="pb-4">
              <div className="flex items-center gap-3">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleBack}
                  data-testid="button-back"
                >
                  <ArrowLeft className="h-5 w-5" />
                </Button>
                
                {otherUser && (
                  <>
                    <Avatar className="h-10 w-10">
                      <AvatarImage src={otherUser.avatarUrl || ""} alt={otherUser.displayName || otherUser.username} />
                      <AvatarFallback className="bg-primary/10 text-primary">
                        {(otherUser.displayName || otherUser.organizationName || otherUser.username).charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1">
                      <h2 className="font-semibold text-foreground" data-testid="text-other-user-name">
                        {otherUser.displayName || otherUser.organizationName || otherUser.username}
                      </h2>
                      <p className="text-sm text-muted-foreground">@{otherUser.username}</p>
                    </div>
                  </>
                )}
              </div>
            </CardHeader>
          </Card>

          <Card className="flex-1 flex flex-col mb-4">
            <ScrollArea className="flex-1 p-6">
              {messagesLoading ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-16 w-2/3" />
                  ))}
                </div>
              ) : conversationMessages.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-muted-foreground">No messages yet</p>
                  <p className="text-sm text-muted-foreground mt-2">Send a message to start the conversation</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {conversationMessages.map((message) => {
                    const isOwnMessage = message.senderId === currentUser?.id;
                    return (
                      <div
                        key={message.id}
                        className={`flex ${isOwnMessage ? 'justify-end' : 'justify-start'} group`}
                        data-testid={`message-${message.id}`}
                      >
                        <div className={`flex items-end gap-1 max-w-[70%] ${isOwnMessage ? 'flex-row-reverse' : 'flex-row'}`}>
                          <div
                            className={`rounded-lg px-4 py-2 ${
                              isOwnMessage
                                ? 'bg-primary text-primary-foreground'
                                : 'bg-muted text-foreground'
                            }`}
                          >
                            {message.replyTo && (
                              <div 
                                className={`mb-2 p-2 rounded border-l-2 ${
                                  isOwnMessage 
                                    ? 'bg-primary-foreground/10 border-primary-foreground/50' 
                                    : 'bg-background/50 border-foreground/30'
                                }`}
                              >
                                <p className={`text-xs font-medium ${isOwnMessage ? 'text-primary-foreground/80' : 'text-foreground/70'}`}>
                                  <Reply className="h-3 w-3 inline mr-1" />
                                  {message.replyTo.sender?.username || 'Unknown'}
                                </p>
                                <p className={`text-xs line-clamp-2 ${isOwnMessage ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
                                  {message.replyTo.content}
                                </p>
                              </div>
                            )}
                            <p className="break-words">{message.content}</p>
                            
                            <div className={`flex items-center gap-1 mt-1 ${isOwnMessage ? 'justify-end' : 'justify-start'}`}>
                              <p className={`text-xs ${isOwnMessage ? 'text-primary-foreground/90' : 'text-muted-foreground'}`}>
                                {formatMessageTime(message.createdAt)}
                              </p>
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 opacity-30 hover:opacity-100 focus:opacity-100 transition-opacity"
                            onClick={() => {
                              setReplyingTo(message);
                              inputRef.current?.focus();
                            }}
                            data-testid={`button-reply-${message.id}`}
                          >
                            <Reply className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </ScrollArea>
          </Card>

          <Card>
            <CardContent className="p-4">
              {replyingTo && (
                <div className="mb-3 p-3 bg-muted rounded-lg border-l-2 border-primary">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground flex items-center gap-1">
                        <Reply className="h-3 w-3" />
                        Replying to {replyingTo.sender?.username || 'Unknown'}
                      </p>
                      <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
                        {replyingTo.content}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0"
                      onClick={() => setReplyingTo(null)}
                      data-testid="button-cancel-reply"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSendMessage();
                }}
                className="flex gap-3"
              >
                <Input
                  ref={inputRef}
                  type="text"
                  placeholder="Type a message..."
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  className="flex-1"
                  data-testid="input-message"
                />
                <Button
                  type="submit"
                  disabled={!messageText.trim() || sendMessageMutation.isPending}
                  data-testid="button-send"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </form>
            </CardContent>
          </Card>
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
                <Plus className="h-4 w-4 mr-2" />
                New Message
                <ChevronDown className="h-4 w-4 ml-2" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem 
                onClick={() => setNewChatDialogOpen(true)}
                data-testid="menu-item-new-chat"
              >
                <MessageSquare className="h-4 w-4 mr-2" />
                New Chat
              </DropdownMenuItem>
              <DropdownMenuItem 
                onClick={() => setCreateGroupOpen(true)}
                data-testid="menu-item-new-group"
              >
                <Users className="h-4 w-4 mr-2" />
                New Group
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {conversationsLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : !conversations || conversations.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center">
              <MessageSquare className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground">No messages yet</p>
              <p className="text-sm text-muted-foreground mt-2">
                Start a conversation or create a group to chat
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {conversations.map((conv) => {
              const isGroup = conv.isGroup;
              const otherParticipants = conv.participants.filter(
                (p) => p.userId !== currentUser.id
              );

              return (
                <Card
                  key={conv.id}
                  className="hover-elevate cursor-pointer"
                  onClick={() => handleSelectConversation(conv)}
                  data-testid={`conversation-${conv.id}`}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center gap-4">
                      <div className="relative">
                        {isGroup ? (
                          conv.avatarUrl ? (
                            <Avatar className="h-12 w-12">
                              <AvatarImage src={conv.avatarUrl} alt={conv.name || "Group"} />
                              <AvatarFallback className="bg-primary/10 text-primary">
                                <Users className="h-5 w-5" />
                              </AvatarFallback>
                            </Avatar>
                          ) : (
                            <div className="flex -space-x-2">
                              {conv.participants.slice(0, 3).map((p, i) => (
                                <Avatar 
                                  key={p.userId} 
                                  className="h-10 w-10 border-2 border-background"
                                  style={{ zIndex: 3 - i }}
                                >
                                  <AvatarImage src={p.user.avatarUrl || ""} />
                                  <AvatarFallback className="text-xs bg-primary/10 text-primary">
                                    {(p.user.displayName || p.user.username)[0].toUpperCase()}
                                  </AvatarFallback>
                                </Avatar>
                              ))}
                              {conv.participants.length > 3 && (
                                <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center text-xs font-medium border-2 border-background">
                                  +{conv.participants.length - 3}
                                </div>
                              )}
                            </div>
                          )
                        ) : (
                          <Avatar className="h-12 w-12">
                            <AvatarImage 
                              src={otherParticipants[0]?.user.avatarUrl || ""} 
                              alt={otherParticipants[0]?.user.displayName || otherParticipants[0]?.user.username} 
                            />
                            <AvatarFallback className="bg-primary/10 text-primary">
                              {(otherParticipants[0]?.user.displayName || otherParticipants[0]?.user.username || "?")[0].toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                        )}
                        {conv.unreadCount > 0 && (
                          <Badge 
                            className="absolute -top-1 -right-1 h-5 min-w-[20px] flex items-center justify-center p-0 px-1.5 text-xs bg-primary"
                            data-testid={`badge-unread-${conv.id}`}
                          >
                            {conv.unreadCount}
                          </Badge>
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1 gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <h3 className={`font-semibold truncate ${conv.unreadCount > 0 ? 'text-foreground' : 'text-foreground/90'}`}>
                              {isGroup
                                ? conv.name
                                : otherParticipants[0]?.user.displayName ||
                                  otherParticipants[0]?.user.username ||
                                  "Unknown"}
                            </h3>
                            {isGroup && (
                              <Badge variant="secondary" className="text-xs shrink-0">
                                <Users className="h-3 w-3 mr-1" />
                                {conv.participants.length}
                              </Badge>
                            )}
                          </div>
                          {conv.lastMessage && (
                            <span className="text-xs text-muted-foreground shrink-0">
                              {formatDistanceToNow(new Date(conv.lastMessage.createdAt), { addSuffix: true })}
                            </span>
                          )}
                        </div>
                        <p className={`text-sm truncate ${conv.unreadCount > 0 ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
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
                  </CardContent>
                </Card>
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
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
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
                  <UserPlus className="h-12 w-12 mx-auto mb-2 opacity-20" />
                  <p>You're not following anyone yet</p>
                  <p className="text-sm mt-1">Follow people to message them</p>
                </div>
              ) : filteredFollowing.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Search className="h-12 w-12 mx-auto mb-2 opacity-20" />
                  <p>No matches found</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredFollowing.map((user) => (
                    <Card
                      key={user.id}
                      className="hover-elevate cursor-pointer"
                      onClick={() => createDirectConversationMutation.mutate(user.id)}
                      data-testid={`following-user-${user.id}`}
                    >
                      <CardContent className="p-3">
                        <div className="flex items-center gap-3">
                          <Avatar className="h-10 w-10">
                            <AvatarImage src={user.avatarUrl || ""} alt={user.displayName || user.username} />
                            <AvatarFallback className="bg-primary/10 text-primary">
                              {(user.displayName || user.organizationName || user.username).charAt(0).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          
                          <div className="flex-1 min-w-0">
                            <h3 className="font-semibold text-foreground truncate">
                              {user.displayName || user.organizationName || user.username}
                            </h3>
                            <p className="text-sm text-muted-foreground truncate">
                              @{user.username}
                            </p>
                          </div>
                          
                          {user.userType === "organizer" && (
                            <Badge variant="default" className="bg-primary">
                              Organizer
                            </Badge>
                          )}
                        </div>
                      </CardContent>
                    </Card>
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
