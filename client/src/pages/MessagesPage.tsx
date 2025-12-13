import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import NewMessageModal from "@/components/NewMessageModal";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Send, ArrowLeft, Check, CheckCheck, Search, UserPlus, Reply, X, Calendar, MapPin, Building2 } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import type { User, Message, Event, Venue } from "@shared/schema";

type Conversation = {
  otherUser: User;
  lastMessage: Message;
  unreadCount: number;
};

type MessageWithUsers = Message & {
  sender: User;
  receiver: User;
  replyTo?: Message & { sender: User };
};

type ShareData = {
  type: "event" | "venue";
  id: string;
  title?: string;
  name?: string;
};

// Helper component to display attached event in message
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

// Helper component to display attached venue in message
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

export default function MessagesPage() {
  const { userId } = useParams<{ userId?: string }>();
  const [, navigate] = useLocation();
  const [messageText, setMessageText] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [searchDialogOpen, setSearchDialogOpen] = useState(false);
  const [replyingTo, setReplyingTo] = useState<MessageWithUsers | null>(null);
  const [newMessageModalOpen, setNewMessageModalOpen] = useState(false);
  const [attachedEvent, setAttachedEvent] = useState<Event | null>(null);
  const [attachedVenue, setAttachedVenue] = useState<Venue | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const markedAsReadRef = useRef<string | null>(null);
  const { toast } = useToast();

  const { data: currentUser } = useAuth();

  // Check for shared event/venue data on every navigation to this page
  // Check URL params first (survives login redirects), then localStorage as backup
  useEffect(() => {
    const checkShareData = () => {
      // First check URL params (more reliable across login redirects)
      const urlParams = new URLSearchParams(window.location.search);
      const shareParam = urlParams.get('share');
      let shareDataStr = shareParam ? decodeURIComponent(shareParam) : null;
      
      // Fall back to localStorage if no URL param
      if (!shareDataStr) {
        shareDataStr = localStorage.getItem("shareToMessage");
      }
      
      if (shareDataStr) {
        try {
          const shareData: ShareData = JSON.parse(shareDataStr);
          
          // Clear the URL param to avoid re-processing on refresh
          if (shareParam) {
            const newUrl = window.location.pathname;
            window.history.replaceState({}, '', newUrl);
          }
          
          // Fetch the event or venue details
          if (shareData.type === "event") {
            fetch(`/api/events/${shareData.id}`)
              .then(res => res.json())
              .then(event => {
                setAttachedEvent(event);
                setNewMessageModalOpen(true);
                localStorage.removeItem("shareToMessage"); // Clear after successful open
              })
              .catch(err => {
                console.error("Failed to fetch event:", err);
                localStorage.removeItem("shareToMessage");
              });
          } else if (shareData.type === "venue") {
            fetch(`/api/venues/${shareData.id}`)
              .then(res => res.json())
              .then(venue => {
                setAttachedVenue(venue);
                setNewMessageModalOpen(true);
                localStorage.removeItem("shareToMessage");
              })
              .catch(err => {
                console.error("Failed to fetch venue:", err);
                localStorage.removeItem("shareToMessage");
              });
          }
        } catch (e) {
          console.error("Failed to parse share data:", e);
          localStorage.removeItem("shareToMessage");
        }
      }
    };

    // Check immediately on mount/navigation
    checkShareData();
    
    // Also check when the page becomes visible (for when user returns via back button)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        checkShareData();
      }
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [userId]);

  const handleCloseNewMessageModal = () => {
    setNewMessageModalOpen(false);
    setAttachedEvent(null);
    setAttachedVenue(null);
  };

  const { data: conversations = [], isLoading: conversationsLoading } = useQuery<Conversation[]>({
    queryKey: ['/api/messages'],
    enabled: !userId,
    refetchOnMount: 'always',
    staleTime: 0,
  });

  const { data: conversation = [], isLoading: conversationLoading } = useQuery<MessageWithUsers[]>({
    queryKey: [`/api/messages/${userId}`],
    enabled: !!userId,
  });

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 300);
    
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const { data: searchResults = [], isLoading: searchLoading } = useQuery<User[]>({
    queryKey: [`/api/users/search?q=${debouncedSearchQuery}`],
    enabled: debouncedSearchQuery.length >= 2,
  });

  // Fetch current user's following list using stable endpoint (requires auth)
  const currentUserId = currentUser?.id;
  const { data: followingList = [], isLoading: followingLoading, refetch: refetchFollowing } = useQuery<User[]>({
    queryKey: ['/api/follows/me/following'],
    enabled: !!currentUserId,
    staleTime: 30000,
    refetchOnMount: true,
  });

  // Refetch following list when dialog opens
  useEffect(() => {
    if (searchDialogOpen && currentUserId) {
      refetchFollowing();
    }
  }, [searchDialogOpen, currentUserId, refetchFollowing]);

  // Filter following list based on search query
  const filteredFollowing = followingList.filter(user => {
    if (!debouncedSearchQuery) return true;
    const searchLower = debouncedSearchQuery.toLowerCase();
    return (
      user.username.toLowerCase().includes(searchLower) ||
      (user.displayName?.toLowerCase().includes(searchLower)) ||
      (user.organizationName?.toLowerCase().includes(searchLower))
    );
  });

  const sendMessageMutation = useMutation({
    mutationFn: async ({ content, replyToId }: { content: string; replyToId?: string }) => {
      return await apiRequest('POST', '/api/messages', {
        receiverId: userId,
        content,
        replyToId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/messages/${userId}`] });
      queryClient.invalidateQueries({ queryKey: ['/api/messages'] });
      setMessageText("");
      setReplyingTo(null);
    },
  });

  const markAsReadMutation = useMutation({
    mutationFn: async (messageId: string) => {
      return await apiRequest('PATCH', `/api/messages/${messageId}/read`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/messages/${userId}`] });
      queryClient.invalidateQueries({ queryKey: ['/api/messages'] });
    },
  });

  // WebSocket connection
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'new_message') {
          // Refresh conversation list
          queryClient.invalidateQueries({ queryKey: ['/api/messages'] });
          
          // If we're viewing the conversation with this user, refresh it
          if (userId && (data.message.senderId === userId || data.message.receiverId === userId)) {
            queryClient.invalidateQueries({ queryKey: [`/api/messages/${userId}`] });
            
            // Mark as read if we're viewing this conversation
            if (data.message.senderId === userId && !data.message.isRead) {
              setTimeout(() => {
                markAsReadMutation.mutate(data.message.id);
              }, 500);
            }
          }
        } else if (data.type === 'message_sent') {
          // Message we sent from another device
          queryClient.invalidateQueries({ queryKey: ['/api/messages'] });
          if (userId) {
            queryClient.invalidateQueries({ queryKey: [`/api/messages/${userId}`] });
          }
        } else if (data.type === 'message_read') {
          // Message was read
          queryClient.invalidateQueries({ queryKey: [`/api/messages/${userId}`] });
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, [userId]);

  const handleSendMessage = () => {
    if (messageText.trim() && userId) {
      sendMessageMutation.mutate({
        content: messageText,
        replyToId: replyingTo?.id,
      });
    }
  };

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [conversation]);

  // Auto-focus input when conversation opens
  useEffect(() => {
    if (userId && inputRef.current) {
      inputRef.current.focus();
    }
  }, [userId]);

  // Reset marked-as-read tracking when conversation changes
  useEffect(() => {
    markedAsReadRef.current = null;
  }, [userId]);

  // Refetch conversations when returning to the list view
  // This ensures the unread badges are updated after viewing a conversation
  useEffect(() => {
    if (!userId) {
      // Delay to ensure any pending mark-as-read operations complete on the server
      const timer = setTimeout(() => {
        queryClient.refetchQueries({ queryKey: ['/api/messages'] });
      }, 350);
      return () => clearTimeout(timer);
    }
  }, [userId]);

  // Mark unread messages as read when viewing conversation
  useEffect(() => {
    if (!userId || conversation.length === 0 || !currentUser?.id) {
      return;
    }
    
    // Skip if we've already marked this conversation as read
    if (markedAsReadRef.current === userId) {
      return;
    }
    
    const currentUserIdForRead = currentUser.id;
    const unreadMessages = conversation.filter(
      (msg) => msg.isRead === false && msg.receiverId === currentUserId
    );
    
    if (unreadMessages.length === 0) {
      return;
    }
    
    // Mark that we're processing this conversation
    markedAsReadRef.current = userId;
    
    // Mark the last unread message as read (marks all previous as read too)
    const lastUnread = unreadMessages[unreadMessages.length - 1];
    
    // Use a small delay to ensure everything is loaded
    const timer = setTimeout(() => {
      markAsReadMutation.mutate(lastUnread.id);
    }, 100);
    
    return () => clearTimeout(timer);
  }, [userId, conversation, currentUser?.id]);

  // Format timestamp with relative time for recent messages
  const formatMessageTime = (date: Date) => {
    const now = new Date();
    const messageDate = new Date(date);
    const diffInHours = (now.getTime() - messageDate.getTime()) / (1000 * 60 * 60);
    
    if (diffInHours < 24) {
      return format(messageDate, 'p'); // Just time for today
    } else if (diffInHours < 168) { // Less than a week
      return format(messageDate, 'EEE p'); // Day and time
    } else {
      return format(messageDate, 'MMM d, p'); // Date and time
    }
  };

  // Conversation List View
  if (!userId) {
    return (
      <div className="min-h-screen bg-background pb-20 md:pb-0">
        <Navigation onSearch={() => {}} />

        <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-3xl font-bold font-serif text-foreground">Messages</h1>
            
            <Dialog open={searchDialogOpen} onOpenChange={setSearchDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" data-testid="button-search-users">
                  <UserPlus className="h-4 w-4 mr-2" />
                  New Message
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>New Message</DialogTitle>
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
                            onClick={() => {
                              setSearchDialogOpen(false);
                              setSearchQuery("");
                              navigate(`/messages/${user.id}`);
                            }}
                            data-testid={`following-user-${user.id}`}
                          >
                            <CardContent className="p-3">
                              <div className="flex items-center gap-3">
                                <Avatar className="h-10 w-10">
                                  <AvatarImage src="" alt={user.displayName || user.username} />
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
          </div>

          {conversationsLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : conversations.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center">
                <p className="text-muted-foreground">No messages yet</p>
                <p className="text-sm text-muted-foreground mt-2">
                  Start a conversation by visiting someone's profile
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {conversations.map(({ otherUser, lastMessage, unreadCount }) => (
                <Card
                  key={otherUser.id}
                  className="hover-elevate cursor-pointer"
                  onClick={() => navigate(`/messages/${otherUser.id}`)}
                  data-testid={`conversation-${otherUser.id}`}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center gap-4">
                      <div className="relative">
                        <Avatar className="h-12 w-12">
                          <AvatarImage src="" alt={otherUser.displayName || otherUser.username} />
                          <AvatarFallback className="bg-primary/10 text-primary">
                            {(otherUser.displayName || otherUser.organizationName || otherUser.username).charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        {unreadCount > 0 && (
                          <Badge 
                            className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center p-0 text-xs bg-primary"
                            data-testid={`badge-unread-${otherUser.id}`}
                          >
                            {unreadCount}
                          </Badge>
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <h3 className={`font-semibold truncate ${unreadCount > 0 ? 'text-foreground' : 'text-foreground/90'}`}>
                            {otherUser.displayName || otherUser.organizationName || otherUser.username}
                          </h3>
                          <span className="text-xs text-muted-foreground">
                            {formatDistanceToNow(new Date(lastMessage.createdAt), { addSuffix: true })}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <p className={`text-sm truncate flex-1 ${unreadCount > 0 ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                            {lastMessage.senderId === currentUser?.id ? (
                              <>
                                <span className="inline-flex items-center gap-1">
                                  {lastMessage.isRead ? (
                                    <CheckCheck className="h-4 w-4 text-foreground/70" />
                                  ) : (
                                    <Check className="h-4 w-4 text-muted-foreground" />
                                  )}
                                  You:
                                </span>{" "}
                              </>
                            ) : ""}
                            {lastMessage.content}
                          </p>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </main>

        <BottomNavigation />
        
        <NewMessageModal
          open={newMessageModalOpen}
          onClose={handleCloseNewMessageModal}
          attachedEvent={attachedEvent}
          attachedVenue={attachedVenue}
        />
      </div>
    );
  }

  // Conversation View
  const otherUser = conversation.length > 0 
    ? conversation[0].sender.id === currentUser?.id 
      ? conversation[0].receiver 
      : conversation[0].sender
    : null;

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0 flex flex-col">
      <Navigation onSearch={() => {}} />

      <main className="flex-1 flex flex-col max-w-[1200px] mx-auto w-full px-4 sm:px-6 lg:px-8 py-8">
        {/* Conversation Header */}
        <Card className="mb-4">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => navigate('/messages')}
                data-testid="button-back"
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
              
              {otherUser && (
                <>
                  <Avatar className="h-10 w-10">
                    <AvatarImage src="" alt={otherUser.displayName || otherUser.username} />
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

        {/* Messages */}
        <Card className="flex-1 flex flex-col mb-4">
          <ScrollArea className="flex-1 p-6">
            {conversationLoading ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-16 w-2/3" />
                ))}
              </div>
            ) : conversation.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-muted-foreground">No messages yet</p>
                <p className="text-sm text-muted-foreground mt-2">Send a message to start the conversation</p>
              </div>
            ) : (
              <div className="space-y-4">
                {conversation.map((message) => {
                  const isOwnMessage = message.senderId === currentUser?.id;
                  const senderName = message.sender?.username || 'Unknown';
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
                              data-testid={`reply-preview-${message.id}`}
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
                          <p className={`text-xs font-medium mb-1 ${isOwnMessage ? 'text-primary-foreground' : 'text-foreground/70'}`}>
                            {senderName}
                          </p>
                          <p className="break-words">{message.content}</p>
                          
                          {(message as any).eventId && (
                            <MessageAttachedEvent eventId={(message as any).eventId} isOwnMessage={isOwnMessage} />
                          )}
                          
                          {(message as any).venueId && (
                            <MessageAttachedVenue venueId={(message as any).venueId} isOwnMessage={isOwnMessage} />
                          )}
                          
                          <div className={`flex items-center gap-1 mt-1 ${isOwnMessage ? 'justify-end' : 'justify-start'}`}>
                            <p className={`text-xs ${isOwnMessage ? 'text-primary-foreground/90' : 'text-muted-foreground'}`}>
                              {formatMessageTime(message.createdAt)}
                            </p>
                            {isOwnMessage && (
                              <span className="inline-flex">
                                {message.isRead ? (
                                  <CheckCheck className="h-4 w-4 text-primary-foreground" data-testid={`read-receipt-${message.id}`} />
                                ) : (
                                  <Check className="h-4 w-4 text-primary-foreground/80" data-testid={`sent-receipt-${message.id}`} />
                                )}
                              </span>
                            )}
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
                          aria-label={`Reply to message from ${senderName}`}
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

        {/* Message Input */}
        <Card>
          <CardContent className="p-4">
            {replyingTo && (
              <div className="mb-3 p-3 bg-muted rounded-lg border-l-2 border-primary" data-testid="reply-preview-input">
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
                    aria-label="Cancel reply"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
            <div className="flex gap-2">
              <Input
                ref={inputRef}
                type="text"
                placeholder={replyingTo ? "Type your reply..." : "Type a message..."}
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                onKeyPress={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendMessage();
                  }
                }}
                disabled={sendMessageMutation.isPending}
                data-testid="input-message"
              />
              <Button
                onClick={handleSendMessage}
                disabled={!messageText.trim() || sendMessageMutation.isPending}
                data-testid="button-send"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>

      <BottomNavigation />

      <NewMessageModal
        open={newMessageModalOpen}
        onClose={handleCloseNewMessageModal}
        attachedEvent={attachedEvent}
        attachedVenue={attachedVenue}
      />
    </div>
  );
}
