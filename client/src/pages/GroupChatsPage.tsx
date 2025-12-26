import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import CreateGroupModal from "@/components/CreateGroupModal";
import GroupChatView from "@/components/GroupChatView";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Users, Plus, MessageSquare, ArrowLeft } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useAuth } from "@/hooks/useAuth";
import type { User, Conversation, ConversationParticipant, ConversationMessage } from "@shared/schema";

type ConversationWithDetails = Conversation & {
  participants: Array<ConversationParticipant & { user: User }>;
  lastMessage: ConversationMessage | null;
  unreadCount: number;
};

function ConversationList({
  conversations,
  isLoading,
  currentUserId,
  onSelect,
  showGroups,
}: {
  conversations: ConversationWithDetails[] | undefined;
  isLoading: boolean;
  currentUserId: string;
  onSelect: (id: string) => void;
  showGroups: boolean;
}) {
  const filteredConversations = conversations?.filter((c) =>
    showGroups ? c.isGroup : !c.isGroup
  );

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center gap-3 p-3">
            <Skeleton className="h-12 w-12 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (!filteredConversations || filteredConversations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center px-4">
        {showGroups ? (
          <>
            <Users className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="font-medium">No group chats yet</h3>
            <p className="text-sm text-muted-foreground">
              Create a group to start planning with friends
            </p>
          </>
        ) : (
          <>
            <MessageSquare className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="font-medium">No direct messages</h3>
            <p className="text-sm text-muted-foreground">
              Start a conversation from someone's profile
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <ScrollArea className="h-[calc(100vh-220px)]">
      <div className="space-y-1 p-2">
        {filteredConversations.map((conversation) => {
          const otherParticipants = conversation.participants.filter(
            (p) => p.userId !== currentUserId
          );

          return (
            <button
              key={conversation.id}
              onClick={() => onSelect(conversation.id)}
              className="w-full flex items-center gap-3 p-3 rounded-lg hover-elevate text-left"
              data-testid={`conversation-${conversation.id}`}
            >
              {conversation.isGroup ? (
                <div className="relative flex -space-x-2">
                  {conversation.participants.slice(0, 3).map((p, i) => (
                    <Avatar
                      key={p.userId}
                      className="h-10 w-10 border-2 border-background"
                      style={{ zIndex: 3 - i }}
                    >
                      <AvatarImage src={p.user.avatarUrl || ""} />
                      <AvatarFallback className="text-xs">
                        {p.user.displayName?.[0] || p.user.username[0]}
                      </AvatarFallback>
                    </Avatar>
                  ))}
                </div>
              ) : otherParticipants[0] ? (
                <Avatar className="h-12 w-12">
                  <AvatarImage src={otherParticipants[0].user.avatarUrl || ""} />
                  <AvatarFallback>
                    {otherParticipants[0].user.displayName?.[0] ||
                      otherParticipants[0].user.username[0]}
                  </AvatarFallback>
                </Avatar>
              ) : null}

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <h4 className="font-medium truncate text-sm">
                    {conversation.isGroup
                      ? conversation.name
                      : otherParticipants[0]?.user.displayName ||
                        otherParticipants[0]?.user.username ||
                        "Unknown"}
                  </h4>
                  {conversation.lastMessage && (
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(conversation.lastMessage.createdAt), {
                        addSuffix: false,
                      })}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <p className="text-sm text-muted-foreground truncate flex-1">
                    {conversation.lastMessage?.content ||
                      (conversation.lastMessage?.messageType === "poll"
                        ? "Poll"
                        : "No messages yet")}
                  </p>
                  {conversation.unreadCount > 0 && (
                    <Badge className="h-5 min-w-[20px] px-1.5 text-xs">
                      {conversation.unreadCount}
                    </Badge>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </ScrollArea>
  );
}

export default function GroupChatsPage() {
  const { conversationId } = useParams<{ conversationId?: string }>();
  const [, navigate] = useLocation();
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [selectedConversation, setSelectedConversation] = useState<string | null>(
    conversationId || null
  );
  const [activeTab, setActiveTab] = useState<string>("groups");

  const { data: currentUser, isLoading: loadingUser } = useAuth();
  
  useEffect(() => {
    setSelectedConversation(conversationId || null);
  }, [conversationId]);

  const { data: conversations, isLoading: loadingConversations } = useQuery<
    ConversationWithDetails[]
  >({
    queryKey: ["/api/conversations"],
    enabled: !!currentUser,
  });

  const handleGroupCreated = (id: string) => {
    setSelectedConversation(id);
  };

  const handleBack = () => {
    setSelectedConversation(null);
  };

  if (loadingUser) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <Navigation />
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
        <Navigation />
        <main className="flex-1 container mx-auto px-4 py-6 pb-20 max-w-2xl flex items-center justify-center">
          <Card className="w-full max-w-md">
            <CardContent className="pt-6 text-center">
              <Users className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h2 className="text-xl font-semibold mb-2">Sign in to chat</h2>
              <p className="text-muted-foreground">
                Create groups and plan events with friends
              </p>
            </CardContent>
          </Card>
        </main>
        <BottomNavigation />
      </div>
    );
  }

  if (selectedConversation) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <div className="flex-1 h-[calc(100vh-64px)]">
          <GroupChatView
            conversationId={selectedConversation}
            currentUser={currentUser}
            onBack={handleBack}
          />
        </div>
        <BottomNavigation />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Navigation />
      <main className="flex-1 container mx-auto px-4 py-6 pb-20 max-w-2xl">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5" />
              Chats
            </CardTitle>
            <Button
              onClick={() => setCreateGroupOpen(true)}
              size="sm"
              data-testid="button-new-group"
            >
              <Plus className="h-4 w-4 mr-2" />
              New Group
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="w-full rounded-none border-b bg-transparent">
                <TabsTrigger
                  value="groups"
                  className="flex-1 rounded-none data-[state=active]:border-b-2 data-[state=active]:border-primary"
                  data-testid="tab-groups"
                >
                  <Users className="h-4 w-4 mr-2" />
                  Groups
                </TabsTrigger>
                <TabsTrigger
                  value="direct"
                  className="flex-1 rounded-none data-[state=active]:border-b-2 data-[state=active]:border-primary"
                  data-testid="tab-direct"
                >
                  <MessageSquare className="h-4 w-4 mr-2" />
                  Direct
                </TabsTrigger>
              </TabsList>
              <TabsContent value="groups" className="m-0">
                <ConversationList
                  conversations={conversations}
                  isLoading={loadingConversations}
                  currentUserId={currentUser.id}
                  onSelect={setSelectedConversation}
                  showGroups={true}
                />
              </TabsContent>
              <TabsContent value="direct" className="m-0">
                <ConversationList
                  conversations={conversations}
                  isLoading={loadingConversations}
                  currentUserId={currentUser.id}
                  onSelect={setSelectedConversation}
                  showGroups={false}
                />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </main>
      <BottomNavigation />

      <CreateGroupModal
        open={createGroupOpen}
        onOpenChange={setCreateGroupOpen}
        onGroupCreated={handleGroupCreated}
      />
    </div>
  );
}
