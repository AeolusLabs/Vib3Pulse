import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import type { Community } from "@shared/schema";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users, Plus, Search } from "lucide-react";

interface CommunityModalProps {
  open: boolean;
  onClose: () => void;
}

type CommunityWithDetails = Community & { memberCount: number; creator: { username: string; displayName?: string } };
type CommunityWithRole = Community & { memberCount: number; role: string };

export default function CommunityModal({ open, onClose }: CommunityModalProps) {
  const { toast } = useToast();
  const { data: currentUser } = useAuth();
  const [activeTab, setActiveTab] = useState("discover");
  const [searchQuery, setSearchQuery] = useState("");
  const [newCommunityName, setNewCommunityName] = useState("");
  const [newCommunityDescription, setNewCommunityDescription] = useState("");

  const { data: allCommunities = [], isLoading: isLoadingAll } = useQuery<CommunityWithDetails[]>({
    queryKey: ['/api/communities'],
    enabled: open,
  });

  const { data: myCommunities = [], refetch: refetchMyCommunities } = useQuery<CommunityWithRole[]>({
    queryKey: ['/api/communities/my', currentUser?.id],
    enabled: open && !!currentUser?.id,
    staleTime: 0,
  });

  const createCommunityMutation = useMutation({
    mutationFn: async (data: { name: string; description: string }) => {
      return await apiRequest('POST', '/api/communities', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/communities'] });
      queryClient.invalidateQueries({ queryKey: ['/api/communities/my', currentUser?.id] });
      setNewCommunityName("");
      setNewCommunityDescription("");
      setActiveTab("my-communities");
      toast({
        title: "Community created",
        description: "Your community has been created successfully.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to create community.",
        variant: "destructive",
      });
    },
  });

  const joinCommunityMutation = useMutation({
    mutationFn: async (communityId: string) => {
      return await apiRequest('POST', `/api/communities/${communityId}/join`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/communities'] });
      queryClient.invalidateQueries({ queryKey: ['/api/communities/my', currentUser?.id] });
      toast({
        title: "Joined community",
        description: "You are now a member of this community.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to join community.",
        variant: "destructive",
      });
    },
  });

  const leaveCommunityMutation = useMutation({
    mutationFn: async (communityId: string) => {
      return await apiRequest('DELETE', `/api/communities/${communityId}/leave`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/communities'] });
      queryClient.invalidateQueries({ queryKey: ['/api/communities/my', currentUser?.id] });
      toast({
        title: "Left community",
        description: "You have left this community.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to leave community.",
        variant: "destructive",
      });
    },
  });

  const filteredCommunities = allCommunities.filter(c =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const myCommunitiesIds = new Set(myCommunities.map(c => c.id));

  const handleCreateCommunity = () => {
    if (!newCommunityName.trim()) {
      toast({
        title: "Error",
        description: "Community name is required.",
        variant: "destructive",
      });
      return;
    }
    createCommunityMutation.mutate({
      name: newCommunityName.trim(),
      description: newCommunityDescription.trim(),
    });
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Communities
          </DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 overflow-hidden flex flex-col">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="discover" data-testid="tab-discover">Discover</TabsTrigger>
            <TabsTrigger value="my-communities" data-testid="tab-my-communities">My Communities</TabsTrigger>
            <TabsTrigger value="create" data-testid="tab-create">Create</TabsTrigger>
          </TabsList>

          <TabsContent value="discover" className="flex-1 overflow-auto space-y-4 mt-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search communities..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
                data-testid="input-search-communities"
              />
            </div>

            {isLoadingAll ? (
              <p className="text-center text-muted-foreground py-4">Loading communities...</p>
            ) : filteredCommunities.length === 0 ? (
              <p className="text-center text-muted-foreground py-4">No communities found. Create one!</p>
            ) : (
              <div className="space-y-3">
                {filteredCommunities.map((community) => (
                  <Card key={community.id} className="hover-elevate">
                    <CardHeader className="p-4 pb-2">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <CardTitle className="text-base">{community.name}</CardTitle>
                          <CardDescription className="text-xs">
                            {community.memberCount} member{community.memberCount !== 1 ? 's' : ''}
                          </CardDescription>
                        </div>
                        {myCommunitiesIds.has(community.id) ? (
                          <Badge variant="secondary">Joined</Badge>
                        ) : (
                          <Button
                            size="sm"
                            onClick={() => joinCommunityMutation.mutate(community.id)}
                            disabled={joinCommunityMutation.isPending}
                            data-testid={`button-join-${community.id}`}
                          >
                            Join
                          </Button>
                        )}
                      </div>
                    </CardHeader>
                    {community.description && (
                      <CardContent className="p-4 pt-0">
                        <p className="text-sm text-muted-foreground line-clamp-2">{community.description}</p>
                      </CardContent>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="my-communities" className="flex-1 overflow-auto space-y-4 mt-4">
            {myCommunities.length === 0 ? (
              <p className="text-center text-muted-foreground py-4">
                You haven't joined any communities yet.
              </p>
            ) : (
              <div className="space-y-3">
                {myCommunities.map((community) => (
                  <Card key={community.id} className="hover-elevate">
                    <CardHeader className="p-4 pb-2">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <CardTitle className="text-base flex items-center gap-2">
                            {community.name}
                            {community.role === 'owner' && (
                              <Badge variant="outline" className="text-xs">Owner</Badge>
                            )}
                          </CardTitle>
                          <CardDescription className="text-xs">
                            {community.memberCount} member{community.memberCount !== 1 ? 's' : ''}
                          </CardDescription>
                        </div>
                        {community.role !== 'owner' && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => leaveCommunityMutation.mutate(community.id)}
                            disabled={leaveCommunityMutation.isPending}
                            data-testid={`button-leave-${community.id}`}
                          >
                            Leave
                          </Button>
                        )}
                      </div>
                    </CardHeader>
                    {community.description && (
                      <CardContent className="p-4 pt-0">
                        <p className="text-sm text-muted-foreground line-clamp-2">{community.description}</p>
                      </CardContent>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="create" className="flex-1 overflow-auto space-y-4 mt-4">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="community-name">Community Name</Label>
                <Input
                  id="community-name"
                  placeholder="Enter community name..."
                  value={newCommunityName}
                  onChange={(e) => setNewCommunityName(e.target.value)}
                  data-testid="input-community-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="community-description">Description (optional)</Label>
                <Textarea
                  id="community-description"
                  placeholder="What is this community about?"
                  value={newCommunityDescription}
                  onChange={(e) => setNewCommunityDescription(e.target.value)}
                  rows={3}
                  data-testid="input-community-description"
                />
              </div>
              <Button
                onClick={handleCreateCommunity}
                disabled={createCommunityMutation.isPending || !newCommunityName.trim()}
                className="w-full"
                data-testid="button-create-community"
              >
                <Plus className="h-4 w-4 mr-2" />
                {createCommunityMutation.isPending ? "Creating..." : "Create Community"}
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
