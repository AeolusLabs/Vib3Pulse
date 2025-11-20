import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, UserPlus, MessageCircle } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { User } from "@shared/schema";

export default function SearchPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { data: sessionUser } = useQuery<{ user: User }>({
    queryKey: ['/api/auth/session'],
  });

  const { data: searchResults = [], isLoading } = useQuery<User[]>({
    queryKey: [`/api/users/search`, searchQuery],
    queryFn: async () => {
      if (!searchQuery.trim()) return [];
      const response = await fetch(`/api/users/search?q=${encodeURIComponent(searchQuery)}`);
      if (!response.ok) throw new Error('Search failed');
      return response.json();
    },
    enabled: searchQuery.trim().length > 0,
  });

  const followMutation = useMutation({
    mutationFn: async (userId: string) => {
      return await apiRequest('POST', `/api/follows/${userId}`, {});
    },
    onSuccess: () => {
      toast({
        title: "Success",
        description: "You are now following this user",
      });
    },
  });

  const handleViewProfile = (userId: string) => {
    navigate(`/user/${userId}`);
  };

  const handleMessage = (userId: string) => {
    navigate(`/messages/${userId}`);
  };

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation onSearch={() => {}} />

      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold font-serif text-foreground mb-6">Search Users</h1>
          
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search by username, name, or organization..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 h-12 text-base"
              data-testid="input-search"
            />
          </div>
        </div>

        {isLoading && searchQuery.trim().length > 0 && (
          <div className="text-center py-8">
            <p className="text-muted-foreground">Searching...</p>
          </div>
        )}

        {!isLoading && searchQuery.trim().length > 0 && searchResults.length === 0 && (
          <div className="text-center py-8">
            <p className="text-muted-foreground">No users found</p>
          </div>
        )}

        {searchResults.length > 0 && (
          <div className="space-y-4">
            {searchResults.map((user) => {
              const isSocialUser = user.userType === "social";
              const isOwnProfile = sessionUser?.user?.id === user.id;

              return (
                <Card 
                  key={user.id} 
                  className="hover-elevate cursor-pointer"
                  onClick={() => handleViewProfile(user.id)}
                  data-testid={`user-card-${user.id}`}
                >
                  <CardContent className="p-6">
                    <div className="flex items-start gap-4">
                      <Avatar className="h-16 w-16 border-2 border-primary/20" data-testid={`avatar-user-${user.id}`}>
                        <AvatarImage src="" alt={isSocialUser ? (user.displayName || user.username) : (user.organizationName || user.username)} />
                        <AvatarFallback className="text-lg bg-primary/10 text-primary">
                          {isSocialUser 
                            ? user.displayName?.charAt(0) || user.username.charAt(0).toUpperCase()
                            : user.organizationName?.charAt(0) || user.username.charAt(0).toUpperCase()
                          }
                        </AvatarFallback>
                      </Avatar>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="text-lg font-semibold text-foreground truncate" data-testid={`text-name-${user.id}`}>
                            {isSocialUser 
                              ? (user.displayName || user.username)
                              : (user.organizationName || user.username)
                            }
                          </h3>
                          {!isSocialUser && (
                            <Badge variant="default" className="bg-primary" data-testid={`badge-organizer-${user.id}`}>
                              Organizer
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground mb-2" data-testid={`text-username-${user.id}`}>
                          @{user.username}
                        </p>
                        {user.bio && (
                          <p className="text-sm text-foreground line-clamp-2" data-testid={`text-bio-${user.id}`}>
                            {user.bio}
                          </p>
                        )}
                        {isSocialUser && user.interests && user.interests.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {user.interests.slice(0, 3).map((interest, index) => (
                              <Badge 
                                key={index} 
                                variant="secondary" 
                                className="text-xs bg-primary/10 text-primary"
                                data-testid={`badge-interest-${user.id}-${index}`}
                              >
                                {interest}
                              </Badge>
                            ))}
                            {user.interests.length > 3 && (
                              <Badge variant="secondary" className="text-xs">
                                +{user.interests.length - 3} more
                              </Badge>
                            )}
                          </div>
                        )}
                      </div>

                      {!isOwnProfile && sessionUser && (
                        <div className="flex flex-col gap-2 ml-4">
                          <Button
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              followMutation.mutate(user.id);
                            }}
                            disabled={followMutation.isPending}
                            data-testid={`button-follow-${user.id}`}
                          >
                            <UserPlus className="h-4 w-4 mr-2" />
                            Follow
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMessage(user.id);
                            }}
                            data-testid={`button-message-${user.id}`}
                          >
                            <MessageCircle className="h-4 w-4 mr-2" />
                            Message
                          </Button>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {searchQuery.trim().length === 0 && (
          <div className="text-center py-12">
            <Search className="h-16 w-16 mx-auto text-muted-foreground/50 mb-4" />
            <p className="text-muted-foreground">Start typing to search for users</p>
          </div>
        )}
      </main>

      <BottomNavigation />
    </div>
  );
}
