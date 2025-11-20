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
import { Send, ArrowLeft } from "lucide-react";
import { format } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { User, Message } from "@shared/schema";

type Conversation = {
  otherUser: User;
  lastMessage: Message;
};

type MessageWithUsers = Message & {
  sender: User;
  receiver: User;
};

export default function MessagesPage() {
  const { userId } = useParams<{ userId?: string }>();
  const [, navigate] = useLocation();
  const [messageText, setMessageText] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
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
      toast({
        title: "Message sent",
      });
    },
  });

  const handleSendMessage = () => {
    if (messageText.trim() && userId) {
      sendMessageMutation.mutate(messageText);
    }
  };

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [conversation]);

  // Conversation List View
  if (!userId) {
    return (
      <div className="min-h-screen bg-background pb-20 md:pb-0">
        <Navigation onSearch={() => {}} />

        <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <h1 className="text-3xl font-bold font-serif text-foreground mb-6">Messages</h1>

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
              {conversations.map(({ otherUser, lastMessage }) => (
                <Card
                  key={otherUser.id}
                  className="hover-elevate cursor-pointer"
                  onClick={() => navigate(`/messages/${otherUser.id}`)}
                  data-testid={`conversation-${otherUser.id}`}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center gap-4">
                      <Avatar className="h-12 w-12">
                        <AvatarImage src="" alt={otherUser.displayName || otherUser.username} />
                        <AvatarFallback className="bg-primary/10 text-primary">
                          {(otherUser.displayName || otherUser.organizationName || otherUser.username).charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <h3 className="font-semibold text-foreground truncate">
                            {otherUser.displayName || otherUser.organizationName || otherUser.username}
                          </h3>
                          <span className="text-xs text-muted-foreground">
                            {format(new Date(lastMessage.createdAt), 'p')}
                          </span>
                        </div>
                        <p className="text-sm text-muted-foreground truncate">
                          {lastMessage.senderId === sessionUser?.user?.id ? "You: " : ""}
                          {lastMessage.content}
                        </p>
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
                        <p className="break-words">{message.content}</p>
                        <p className={`text-xs mt-1 ${isOwnMessage ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
                          {format(new Date(message.createdAt), 'p')}
                        </p>
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
