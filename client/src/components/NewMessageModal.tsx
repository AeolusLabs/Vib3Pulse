import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Event, Venue, User } from "@shared/schema";
import { SearchIcon, SendIcon, CalendarIcon, MapPinIcon, Building2Icon, XIcon } from "@/components/ui/icons";

interface NewMessageModalProps {
  open: boolean;
  onClose: () => void;
  attachedEvent?: Event | null;
  attachedVenue?: Venue | null;
}

export default function NewMessageModal({ 
  open, 
  onClose, 
  attachedEvent,
  attachedVenue 
}: NewMessageModalProps) {
  const [, navigate] = useLocation();
  const { data: currentUser } = useAuth();
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [message, setMessage] = useState("");

  const { data: followingList = [], isLoading: followingLoading } = useQuery<User[]>({
    queryKey: ['/api/follows/me/following'],
    enabled: open && !!currentUser?.id,
  });

  const filteredFollowing = followingList.filter(user => {
    if (!searchQuery) return true;
    const searchLower = searchQuery.toLowerCase();
    return (
      user.username.toLowerCase().includes(searchLower) ||
      (user.displayName?.toLowerCase().includes(searchLower)) ||
      (user.organizationName?.toLowerCase().includes(searchLower))
    );
  });

  useEffect(() => {
    if (open && (attachedEvent || attachedVenue)) {
      const itemName = attachedEvent?.title || attachedVenue?.name || "";
      const itemType = attachedEvent ? "event" : "venue";
      setMessage(`Check out this ${itemType}: ${itemName}`);
    }
  }, [open, attachedEvent, attachedVenue]);

  const sendMessageMutation = useMutation({
    mutationFn: async ({ content, receiverId, eventId, venueId }: {
      content: string;
      receiverId: string;
      eventId?: string;
      venueId?: string;
    }) => {
      const convRes = await apiRequest('POST', '/api/conversations/direct', { userId: receiverId });
      const conversation = await convRes.json();
      await apiRequest('POST', `/api/conversations/${conversation.id}/messages`, {
        content,
        messageType: eventId ? 'event' : venueId ? 'venue' : 'text',
        eventId,
        venueId,
      });
      return conversation;
    },
    onSuccess: (conversation) => {
      queryClient.invalidateQueries({ queryKey: ['/api/conversations'] });
      toast({
        title: "Message sent",
        description: `Message sent to ${selectedUser?.displayName || selectedUser?.organizationName || selectedUser?.username}`,
      });
      handleClose();
      navigate(`/messages/${conversation.id}`);
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to send message. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleSend = () => {
    if (!selectedUser || !message.trim()) return;
    
    sendMessageMutation.mutate({
      content: message,
      receiverId: selectedUser.id,
      eventId: attachedEvent?.id,
      venueId: attachedVenue?.id,
    });
  };

  const handleClose = () => {
    setSearchQuery("");
    setSelectedUser(null);
    setMessage("");
    onClose();
  };

  const getUserDisplayName = (user: User) => {
    return user.displayName || user.organizationName || user.username;
  };

  const getUserInitial = (user: User) => {
    const name = getUserDisplayName(user);
    return name.charAt(0).toUpperCase();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-serif">
            {attachedEvent 
              ? "Share Event" 
              : attachedVenue 
                ? "Share Venue" 
                : "New Message"
            }
          </DialogTitle>
          <DialogDescription>
            {selectedUser 
              ? `Sending to ${getUserDisplayName(selectedUser)}`
              : "Select a follower to send to"
            }
          </DialogDescription>
        </DialogHeader>

        {!selectedUser ? (
          <div className="flex-1 flex flex-col min-h-0">
            {(attachedEvent || attachedVenue) && (
              <div className="mb-4">
                <p className="text-sm text-muted-foreground mb-2">You're sharing:</p>
                {attachedEvent && (
                  <Card className="border-2 border-primary/30 bg-primary/5">
                    <CardContent className="p-3">
                      <div className="flex gap-3">
                        {attachedEvent.imageUrl && (
                          <img 
                            src={attachedEvent.imageUrl} 
                            alt={attachedEvent.title}
                            className="w-14 h-14 rounded-lg object-cover flex-shrink-0"
                          />
                        )}
                        <div className="flex-1 min-w-0">
                          <Badge variant="secondary" className="mb-1 text-xs">
                            <CalendarIcon className="h-3 w-3 mr-1" />
                            Event
                          </Badge>
                          <h4 className="font-semibold text-sm line-clamp-1">{attachedEvent.title}</h4>
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <MapPinIcon className="h-3 w-3" />
                            <span className="line-clamp-1">{attachedEvent.location}</span>
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}
                {attachedVenue && (
                  <Card className="border-2 border-primary/30 bg-primary/5">
                    <CardContent className="p-3">
                      <div className="flex gap-3">
                        {(attachedVenue.coverImageUrl || attachedVenue.imageUrl) && (
                          <img 
                            src={attachedVenue.coverImageUrl || attachedVenue.imageUrl || ""} 
                            alt={attachedVenue.name}
                            className="w-14 h-14 rounded-lg object-cover flex-shrink-0"
                          />
                        )}
                        <div className="flex-1 min-w-0">
                          <Badge variant="secondary" className="mb-1 text-xs">
                            <Building2Icon className="h-3 w-3 mr-1" />
                            Venue
                          </Badge>
                          <h4 className="font-semibold text-sm line-clamp-1">{attachedVenue.name}</h4>
                          {attachedVenue.city && (
                            <p className="text-xs text-muted-foreground flex items-center gap-1">
                              <MapPinIcon className="h-3 w-3" />
                              <span className="line-clamp-1">{attachedVenue.city}</span>
                            </p>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}
            
            <p className="text-sm font-medium mb-2">Select a follower to send to:</p>
            <div className="relative mb-3">
              <SearchIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search followers..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
                data-testid="input-search-followers"
              />
            </div>

            <ScrollArea className="flex-1 max-h-[250px]">
              {followingLoading ? (
                <div className="text-center py-8">
                  <p className="text-muted-foreground text-sm">Loading followers...</p>
                </div>
              ) : filteredFollowing.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-muted-foreground text-sm">
                    {searchQuery ? "No followers found" : "You're not following anyone yet"}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredFollowing.map((user) => (
                    <Card 
                      key={user.id}
                      className="hover-elevate cursor-pointer"
                      onClick={() => setSelectedUser(user)}
                      data-testid={`follower-card-${user.id}`}
                    >
                      <CardContent className="p-3 flex items-center gap-3">
                        <Avatar className="h-10 w-10">
                          <AvatarImage src={user.avatarUrl || ""} alt={getUserDisplayName(user)} />
                          <AvatarFallback className="bg-primary/10 text-primary">
                            {getUserInitial(user)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{getUserDisplayName(user)}</p>
                          <p className="text-sm text-muted-foreground truncate">@{user.username}</p>
                        </div>
                        {user.userType === 'organizer' && (
                          <Badge variant="secondary" className="text-xs">Organizer</Badge>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0 space-y-4">
            <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
              <Avatar className="h-10 w-10">
                <AvatarImage src={selectedUser.avatarUrl || ""} alt={getUserDisplayName(selectedUser)} />
                <AvatarFallback className="bg-primary/10 text-primary">
                  {getUserInitial(selectedUser)}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{getUserDisplayName(selectedUser)}</p>
                <p className="text-sm text-muted-foreground truncate">@{selectedUser.username}</p>
              </div>
              <Button 
                variant="ghost" 
                size="icon"
                onClick={() => setSelectedUser(null)}
                data-testid="button-change-recipient"
              >
                <XIcon className="h-4 w-4" />
              </Button>
            </div>

            {attachedEvent && (
              <Card className="border-2 border-primary/30 bg-primary/5">
                <CardContent className="p-3">
                  <div className="flex gap-3">
                    {attachedEvent.imageUrl && (
                      <img 
                        src={attachedEvent.imageUrl} 
                        alt={attachedEvent.title}
                        className="w-16 h-16 rounded-lg object-cover flex-shrink-0"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <Badge variant="secondary" className="mb-1 text-xs">
                        <CalendarIcon className="h-3 w-3 mr-1" />
                        Event
                      </Badge>
                      <h4 className="font-semibold text-sm line-clamp-1">{attachedEvent.title}</h4>
                      <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                        <MapPinIcon className="h-3 w-3" />
                        <span className="line-clamp-1">{attachedEvent.location}</span>
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {attachedVenue && (
              <Card className="border-2 border-primary/30 bg-primary/5">
                <CardContent className="p-3">
                  <div className="flex gap-3">
                    {(attachedVenue.coverImageUrl || attachedVenue.imageUrl) && (
                      <img 
                        src={attachedVenue.coverImageUrl || attachedVenue.imageUrl || ""} 
                        alt={attachedVenue.name}
                        className="w-16 h-16 rounded-lg object-cover flex-shrink-0"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <Badge variant="secondary" className="mb-1 text-xs">
                        <Building2Icon className="h-3 w-3 mr-1" />
                        Venue
                      </Badge>
                      <h4 className="font-semibold text-sm line-clamp-1">{attachedVenue.name}</h4>
                      {attachedVenue.city && (
                        <p className="text-xs text-muted-foreground flex items-center gap-1">
                          <MapPinIcon className="h-3 w-3" />
                          <span className="line-clamp-1">{attachedVenue.city}</span>
                        </p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            <Textarea
              placeholder="Write a message..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="resize-none min-h-[100px]"
              data-testid="textarea-message"
            />

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button 
                onClick={handleSend}
                disabled={!message.trim() || sendMessageMutation.isPending}
                data-testid="button-send-message"
              >
                <SendIcon className="h-4 w-4 mr-2" />
                Send
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
