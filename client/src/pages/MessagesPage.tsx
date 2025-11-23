import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
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
import { Send, ArrowLeft, Check, CheckCheck, Search, UserPlus } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { User, Message } from "@shared/schema";

type Conversation = {
  otherUser: User;
  lastMessage: Message;
  unreadCount: number;
};

type MessageWithUsers = Message & {
  sender: User;
  receiver: User;
};

export default function MessagesPage() {
  const { userId } = useParams<{ userId?: string }>();
  const [, navigate] = useLocation();
  const [messageText, setMessageText] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [searchDialogOpen, setSearchDialogOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const { toast } = useToast();

  const { data: sessionUser } = useQuery<{ user: User }>({
    queryKey: ['/api/auth/session'],
  });

  const { data: conversations = [], isLoading: conversationsLoading } = useQuery<Conversation[]>({
    queryKey: ['/api/messages'],
    enabled: !userId,
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

  const sendMessageMutation = useMutation({
    mutationFn: async (content: string) => {
      return await apiRequest('POST', '/api/messages', {
        receiverId: userId,
        content,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/messages/${userId}`] });
      queryClient.invalidateQueries({ queryKey: ['/api/messages'] });
      setMessageText("");
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
      sendMessageMutation.mutate(messageText);
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

  // Mark unread messages as read when viewing conversation
  useEffect(() => {
    if (userId && conversation.length > 0 && sessionUser?.user?.id) {
      const unreadMessages = conversation.filter(
        (msg) => !msg.isRead && msg.receiverId === sessionUser.user.id
      );
      
      if (unreadMessages.length > 0) {
        // Mark the last unread message as read (marks all previous as read too)
        const lastUnread = unreadMessages[unreadMessages.length - 1];
        setTimeout(() => {
          markAsReadMutation.mutate(lastUnread.id);
        }, 500);
      }
    }
  }, [userId, conversation, sessionUser?.user?.id]);

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
                    Search for people to start a conversation
                  </DialogDescription>
                </DialogHeader>
                
                <div className="space-y-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      type="text"
                      placeholder="Search by name or username..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-10"
                      data-testid="input-search-users"
                    />
                  </div>
                  
                  <ScrollArea className="h-[300px]">
                    {searchLoading ? (
                      <div className="space-y-3">
                        {[1, 2, 3].map((i) => (
                          <Skeleton key={i} className="h-16 w-full" />
                        ))}
                      </div>
                    ) : debouncedSearchQuery.length < 2 ? (
                      <div className="text-center py-8 text-muted-foreground">
                        <Search className="h-12 w-12 mx-auto mb-2 opacity-20" />
                        <p>Type at least 2 characters to search</p>
                      </div>
                    ) : searchResults.length === 0 ? (
                      <div className="text-center py-8 text-muted-foreground">
                        <p>No users found</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {searchResults
                          .filter(user => user.id !== sessionUser?.user?.id)
                          .map((user) => (
                            <Card
                              key={user.id}
                              className="hover-elevate cursor-pointer"
                              onClick={() => {
                                setSearchDialogOpen(false);
                                setSearchQuery("");
                                navigate(`/messages/${user.id}`);
                              }}
                              data-testid={`search-result-${user.id}`}
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
                            {lastMessage.senderId === sessionUser?.user?.id ? (
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
      </div>
    );
  }

  // Conversation View
  const otherUser = conversation.length > 0 
    ? conversation[0].sender.id === sessionUser?.user?.id 
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
                  const isOwnMessage = message.senderId === sessionUser?.user?.id;
                  const senderName = message.sender?.username || 'Unknown';
                  return (
                    <div
                      key={message.id}
                      className={`flex ${isOwnMessage ? 'justify-end' : 'justify-start'}`}
                      data-testid={`message-${message.id}`}
                    >
                      <div
                        className={`max-w-[70%] rounded-lg px-4 py-2 ${
                          isOwnMessage
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-foreground'
                        }`}
                      >
                        <p className={`text-xs font-medium mb-1 ${isOwnMessage ? 'text-primary-foreground' : 'text-foreground/70'}`}>
                          {senderName}
                        </p>
                        <p className="break-words">{message.content}</p>
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
            <div className="flex gap-2">
              <Input
                ref={inputRef}
                type="text"
                placeholder="Type a message..."
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
    </div>
  );
}
