import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
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

import { format, formatDistanceToNow } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import PollMessage from "./PollMessage";
import CreatePollModal from "./CreatePollModal";
import { ObjectUploader } from "./ObjectUploader";
import { MentionInput, renderMessageWithMentions } from "./MentionInput";
import type { User, Conversation, ConversationParticipant, ConversationMessage, Event, Venue } from "@shared/schema";
import type { AuthUser } from "@/hooks/useAuth";
import { SendIcon, ArrowLeftIcon, UsersIcon, SettingsIcon, ChartBarIcon, MoreVerticalIcon, UserPlusIcon, LogOutIcon, ShieldIcon, UserMinusIcon, Trash2Icon, Loader2Icon, Link2Icon, CopyIcon, CheckIcon, CameraIcon, CalendarIcon, Building2Icon, XIcon, MapPinIcon } from "@/components/ui/icons";

function GCVAttachedEvent({ eventId, isOwn }: { eventId: string; isOwn: boolean }) {
  const [, navigate] = useLocation();
  const { data: event } = useQuery<Event>({
    queryKey: ['/api/events', eventId],
    enabled: !!eventId,
  });
  if (!event) return null;
  return (
    <div
      className={`mt-2 p-2 rounded-lg cursor-pointer ${isOwn ? 'bg-primary-foreground/20 hover:bg-primary-foreground/30' : 'bg-background/50 hover:bg-background/70'}`}
      onClick={(e) => { e.stopPropagation(); navigate(`/event/${event.id}`); }}
    >
      <div className="flex gap-2">
        {event.imageUrl && (
          <img src={event.imageUrl} alt={event.title} className="w-12 h-12 rounded object-cover flex-shrink-0" />
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

function GCVAttachedVenue({ venueId, isOwn }: { venueId: string; isOwn: boolean }) {
  const [, navigate] = useLocation();
  const { data: venue } = useQuery<Venue>({
    queryKey: ['/api/venues', venueId],
    enabled: !!venueId,
  });
  if (!venue) return null;
  return (
    <div
      className={`mt-2 p-2 rounded-lg cursor-pointer ${isOwn ? 'bg-primary-foreground/20 hover:bg-primary-foreground/30' : 'bg-background/50 hover:bg-background/70'}`}
      onClick={(e) => { e.stopPropagation(); navigate(`/venue/${venue.id}`); }}
    >
      <div className="flex gap-2">
        {(venue.coverImageUrl || venue.imageUrl) && (
          <img src={venue.coverImageUrl || venue.imageUrl || ''} alt={venue.name} className="w-12 h-12 rounded object-cover flex-shrink-0" />
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

interface ConversationWithDetails extends Conversation {
  participants: Array<ConversationParticipant & { user: User }>;
}

interface MessageWithSender extends ConversationMessage {
  sender: User;
  replyTo?: ConversationMessage & { sender: User };
}

interface GroupChatViewProps {
  conversationId: string;
  currentUser: AuthUser;
  onBack: () => void;
  pendingShare?: { type: 'event' | 'venue'; id: string; title?: string; name?: string } | null;
  onShareSent?: () => void;
}

export default function GroupChatView({ conversationId, currentUser, onBack, pendingShare, onShareSent }: GroupChatViewProps) {
  const [, navigate] = useLocation();
  const [messageText, setMessageText] = useState("");
  const [pollModalOpen, setPollModalOpen] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [memberToRemove, setMemberToRemove] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const { data: conversation, isLoading: loadingConversation } = useQuery<ConversationWithDetails>({
    queryKey: ['/api/conversations', conversationId],
  });

  const { data: messages, isLoading: loadingMessages } = useQuery<MessageWithSender[]>({
    queryKey: ['/api/conversations', conversationId, 'messages'],
  });

  const sendMessageMutation = useMutation({
    mutationFn: async ({ content, eventId, venueId }: { content: string; eventId?: string; venueId?: string }) => {
      const response = await apiRequest("POST", `/api/conversations/${conversationId}/messages`, {
        content,
        messageType: eventId ? 'event' : venueId ? 'venue' : 'text',
        eventId,
        venueId,
      });
      return response.json();
    },
    onSuccess: () => {
      setMessageText("");
      queryClient.invalidateQueries({ queryKey: ['/api/conversations', conversationId, 'messages'] });
      onShareSent?.();
    },
    onError: () => {
      toast({ title: "Failed to send message", variant: "destructive" });
    },
  });

  const leaveGroupMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/conversations/${conversationId}/participants/${currentUser.id}`);
    },
    onSuccess: () => {
      toast({ title: "Left group" });
      queryClient.invalidateQueries({ queryKey: ['/api/conversations'] });
      onBack();
    },
    onError: (error: any) => {
      toast({ title: "Couldn't leave", description: error.message, variant: "destructive" });
    },
  });

  const removeParticipantMutation = useMutation({
    mutationFn: async (userId: string) => {
      await apiRequest("DELETE", `/api/conversations/${conversationId}/participants/${userId}`);
    },
    onSuccess: () => {
      toast({ title: "Member removed" });
      queryClient.invalidateQueries({ queryKey: ['/api/conversations', conversationId] });
      setMemberToRemove(null);
    },
    onError: () => {
      toast({ title: "Failed to remove member", variant: "destructive" });
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: string }) => {
      const response = await apiRequest("PATCH", `/api/conversations/${conversationId}/participants/${userId}`, { role });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/conversations', conversationId] });
      toast({ title: "Role updated" });
    },
    onError: () => {
      toast({ title: "Failed to update role", variant: "destructive" });
    },
  });

  const generateInviteMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/conversations/${conversationId}/invite`);
      if (!response.ok) {
        throw new Error("Failed to generate invite link");
      }
      const data = await response.json();
      if (!data || !data.inviteCode) {
        throw new Error("Invalid response from server");
      }
      return data;
    },
    onSuccess: async (data) => {
      const inviteLink = `${window.location.origin}/join/${data.inviteCode}`;
      try {
        await navigator.clipboard.writeText(inviteLink);
        setInviteCopied(true);
        setTimeout(() => setInviteCopied(false), 2000);
        toast({ title: "Invite link copied to clipboard" });
      } catch {
        toast({ title: "Invite code: " + data.inviteCode });
      }
    },
    onError: () => {
      toast({ title: "Failed to generate invite", variant: "destructive" });
    },
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = () => {
    if (!messageText.trim() && !pendingShare) return;
    sendMessageMutation.mutate({
      content: messageText.trim() || (pendingShare?.type === 'event'
        ? `Check out this event: ${pendingShare.title}`
        : `Check out this venue: ${pendingShare?.name}`),
      eventId: pendingShare?.type === 'event' ? pendingShare.id : undefined,
      venueId: pendingShare?.type === 'venue' ? pendingShare.id : undefined,
    });
  };

  if (loadingConversation) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-3 p-4 border-b">
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeftIcon className="h-5 w-5" />
          </Button>
          <Skeleton className="h-10 w-10 rounded-full" />
          <Skeleton className="h-5 w-32" />
        </div>
        <div className="flex-1 p-4 space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex gap-2">
              <Skeleton className="h-8 w-8 rounded-full" />
              <Skeleton className="h-16 w-48 rounded-lg" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!conversation) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <p className="text-muted-foreground">Conversation not found</p>
        <Button variant="ghost" onClick={onBack}>Go back</Button>
      </div>
    );
  }

  const currentParticipant = conversation.participants.find((p) => p.userId === currentUser.id);
  const isAdmin = currentParticipant?.role === 'admin';
  const otherParticipants = conversation.participants.filter((p) => p.userId !== currentUser.id);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 p-4 border-b">
        <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back">
          <ArrowLeftIcon className="h-5 w-5" />
        </Button>

        <Avatar className="h-10 w-10">
          <AvatarImage src={conversation.avatarUrl || ""} alt={conversation.name || "Group"} />
          <AvatarFallback className="bg-primary/10 text-primary">
            <UsersIcon className="h-5 w-5" />
          </AvatarFallback>
        </Avatar>

        <div className="flex-1 min-w-0">
          <h3 className="font-semibold truncate" data-testid="text-group-name">{conversation.name}</h3>
          <p className="text-xs text-muted-foreground">
            {conversation.participants.length} members
          </p>
        </div>

        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" data-testid="button-group-members">
              <UsersIcon className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Group Settings</SheetTitle>
              <SheetDescription>
                {conversation.participants.length} members
              </SheetDescription>
            </SheetHeader>
            
            {isAdmin && (
              <div className="py-4 border-b">
                <p className="text-sm font-medium mb-3">Group Avatar</p>
                <div className="flex items-center gap-4">
                  <Avatar className="h-16 w-16">
                    <AvatarImage src={conversation.avatarUrl || ""} alt={conversation.name || "Group"} />
                    <AvatarFallback className="bg-primary/10 text-primary">
                      <UsersIcon className="h-6 w-6" />
                    </AvatarFallback>
                  </Avatar>
                  <ObjectUploader
                    onComplete={async (urls: string[]) => {
                      if (urls[0]) {
                        const patchResponse = await apiRequest("PATCH", `/api/conversations/${conversationId}/avatar`, { avatarPath: urls[0] });
                        if (patchResponse.ok) {
                          queryClient.invalidateQueries({ queryKey: ['/api/conversations', conversationId] });
                          queryClient.invalidateQueries({ queryKey: ['/api/conversations'] });
                          toast({ title: "Group avatar updated" });
                        } else {
                          toast({ title: "Failed to update avatar", variant: "destructive" });
                        }
                      }
                    }}
                    buttonVariant="outline"
                    buttonSize="sm"
                  >
                    <CameraIcon className="h-4 w-4 mr-2" />
                    Change Avatar
                  </ObjectUploader>
                </div>
              </div>
            )}
            
            <div className="py-4">
              <p className="text-sm font-medium mb-3">Members</p>
            </div>
            <ScrollArea className="h-[calc(100vh-280px)]">
              <div className="space-y-2">
                {conversation.participants.map((p) => (
                  <div key={p.userId} className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50">
                    <Avatar
                      className="h-10 w-10 cursor-pointer"
                      onClick={() => navigate(`/profile/${p.user.username}`)}
                    >
                      <AvatarImage src={p.user.avatarUrl || ""} />
                      <AvatarFallback>
                        {p.user.displayName?.[0] || p.user.username[0]}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">
                        {p.user.displayName || p.user.username}
                        {p.userId === currentUser.id && " (You)"}
                      </p>
                      <p className="text-xs text-muted-foreground">@{p.user.username}</p>
                    </div>
                    {p.role === 'admin' && (
                      <Badge variant="secondary" className="text-xs">
                        <ShieldIcon className="h-3 w-3 mr-1" />
                        Admin
                      </Badge>
                    )}
                    {isAdmin && p.userId !== currentUser.id && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreVerticalIcon className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {p.role === 'member' ? (
                            <DropdownMenuItem
                              onClick={() => updateRoleMutation.mutate({ userId: p.userId, role: 'admin' })}
                            >
                              <ShieldIcon className="h-4 w-4 mr-2" />
                              Make Admin
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              onClick={() => updateRoleMutation.mutate({ userId: p.userId, role: 'member' })}
                            >
                              <UserMinusIcon className="h-4 w-4 mr-2" />
                              Remove Admin
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => setMemberToRemove(p.userId)}
                          >
                            <Trash2Icon className="h-4 w-4 mr-2" />
                            Remove from Group
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </SheetContent>
        </Sheet>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" data-testid="button-group-menu">
              <MoreVerticalIcon className="h-5 w-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setPollModalOpen(true)}>
              <ChartBarIcon className="h-4 w-4 mr-2" />
              Create Poll
            </DropdownMenuItem>
            {isAdmin && (
              <DropdownMenuItem 
                onClick={() => generateInviteMutation.mutate()}
                disabled={generateInviteMutation.isPending}
              >
                {inviteCopied ? (
                  <CheckIcon className="h-4 w-4 mr-2" />
                ) : (
                  <Link2Icon className="h-4 w-4 mr-2" />
                )}
                {generateInviteMutation.isPending ? "Generating..." : inviteCopied ? "Copied!" : "Copy Invite Link"}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive"
              onClick={() => setConfirmLeave(true)}
            >
              <LogOutIcon className="h-4 w-4 mr-2" />
              Leave Group
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ScrollArea className="flex-1 p-4">
        <div className="space-y-4">
          {loadingMessages ? (
            Array(5).fill(0).map((_, i) => (
              <div key={i} className={`flex gap-2 ${i % 2 === 0 ? '' : 'justify-end'}`}>
                {i % 2 === 0 && <Skeleton className="h-8 w-8 rounded-full flex-shrink-0" />}
                <Skeleton className="h-12 w-48 rounded-lg" />
              </div>
            ))
          ) : messages && messages.length > 0 ? (
            messages.map((message, index) => {
              const isOwn = message.senderId === currentUser.id;
              const showAvatar = index === 0 || messages[index - 1]?.senderId !== message.senderId;
              const showTime = index === messages.length - 1 || messages[index + 1]?.senderId !== message.senderId;

              return (
                <div
                  key={message.id}
                  className={`flex gap-2 ${isOwn ? 'justify-end' : ''}`}
                  data-testid={`message-${message.id}`}
                >
                  {!isOwn && (
                    <Avatar
                      className={`h-8 w-8 flex-shrink-0 ${showAvatar ? '' : 'invisible'}`}
                      onClick={() => navigate(`/profile/${message.sender.username}`)}
                    >
                      <AvatarImage src={message.sender.avatarUrl || ""} />
                      <AvatarFallback className="text-xs">
                        {message.sender.displayName?.[0] || message.sender.username[0]}
                      </AvatarFallback>
                    </Avatar>
                  )}
                  <div className={`max-w-[70%] ${isOwn ? 'items-end' : 'items-start'} flex flex-col`}>
                    {!isOwn && showAvatar && (
                      <span className="text-xs text-muted-foreground mb-1">
                        {message.sender.displayName || message.sender.username}
                      </span>
                    )}
                    {message.messageType === 'poll' && message.pollId ? (
                      <PollMessage
                        pollId={message.pollId}
                        currentUserId={currentUser.id}
                        isOwnMessage={isOwn}
                      />
                    ) : (
                      <div
                        className={`rounded-2xl px-4 py-2 ${
                          isOwn
                            ? 'bg-primary text-primary-foreground rounded-br-md'
                            : 'bg-muted rounded-bl-md'
                        }`}
                      >
                        <p className="text-sm whitespace-pre-wrap break-words">
                          {renderMessageWithMentions(
                            message.content || '',
                            currentUser.username,
                            (username) => navigate(`/profile/${username}`)
                          )}
                        </p>
                        {message.eventId && (
                          <GCVAttachedEvent eventId={message.eventId} isOwn={isOwn} />
                        )}
                        {message.venueId && (
                          <GCVAttachedVenue venueId={message.venueId} isOwn={isOwn} />
                        )}
                      </div>
                    )}
                    {showTime && (
                      <span className="text-[10px] text-muted-foreground mt-1">
                        {formatDistanceToNow(new Date(message.createdAt), { addSuffix: true })}
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <UsersIcon className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="font-medium">No messages yet</h3>
              <p className="text-sm text-muted-foreground">
                Start the conversation!
              </p>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>

      <div className="p-4 border-t">
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
              type="button"
              className="text-muted-foreground hover:text-foreground p-1.5 rounded-full hover:bg-muted transition-colors duration-150 flex-shrink-0"
              onClick={() => onShareSent?.()}
              aria-label="Remove attachment"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="flex gap-2"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setPollModalOpen(true)}
            data-testid="button-create-poll"
          >
            <ChartBarIcon className="h-5 w-5" />
          </Button>
          <MentionInput
            placeholder={pendingShare ? "Add a message (optional)…" : "Type @ to mention someone..."}
            value={messageText}
            onChange={setMessageText}
            participants={conversation?.participants || []}
            onSubmit={handleSend}
            data-testid="input-message"
          />
          <Button
            type="submit"
            size="icon"
            disabled={(!messageText.trim() && !pendingShare) || sendMessageMutation.isPending}
            data-testid="button-send"
          >
            {sendMessageMutation.isPending ? (
              <Loader2Icon className="h-5 w-5 animate-spin" />
            ) : (
              <SendIcon className="h-5 w-5" />
            )}
          </Button>
        </form>
      </div>

      <CreatePollModal
        open={pollModalOpen}
        onOpenChange={setPollModalOpen}
        conversationId={conversationId}
      />

      <AlertDialog open={confirmLeave} onOpenChange={setConfirmLeave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave group?</AlertDialogTitle>
            <AlertDialogDescription>
              You'll no longer receive messages from this group.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => leaveGroupMutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {leaveGroupMutation.isPending ? (
                <Loader2Icon className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!memberToRemove} onOpenChange={() => setMemberToRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove member?</AlertDialogTitle>
            <AlertDialogDescription>
              They'll no longer be able to see or send messages in this group.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => memberToRemove && removeParticipantMutation.mutate(memberToRemove)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removeParticipantMutation.isPending ? (
                <Loader2Icon className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
