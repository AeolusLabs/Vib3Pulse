import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import type { Community, CommunityType } from "@shared/schema";
import { communityTypes } from "@shared/schema";
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
import { ObjectUploader } from "@/components/ObjectUploader";
import { communityTypeStyle } from "@/lib/communityTypes";
import { UsersIcon, PlusIcon, SearchIcon, ImageIcon, TrendingUpIcon, ClockIcon } from "@/components/ui/icons";

interface CommunityModalProps {
  open: boolean;
  onClose: () => void;
}

type CommunityWithDetails = Community & { memberCount: number; creator: { username: string; displayName?: string } };
type CommunityWithRole = Community & { memberCount: number; role: string };
type TrendingCommunity = Community & { memberCount: number; trendingScore: number };

export function CommunityTypeBadge({ type, className = "" }: { type: string; className?: string }) {
  return (
    <Badge variant="outline" className={`capitalize ${communityTypeStyle(type)} ${className}`}>
      {type}
    </Badge>
  );
}

export default function CommunityModal({ open, onClose }: CommunityModalProps) {
  const { toast } = useToast();
  const { data: currentUser } = useAuth();
  const [activeTab, setActiveTab] = useState("discover");
  const [discoverSort, setDiscoverSort] = useState<"newest" | "trending">("newest");
  const [searchQuery, setSearchQuery] = useState("");
  const [newCommunityName, setNewCommunityName] = useState("");
  const [newCommunityDescription, setNewCommunityDescription] = useState("");
  const [newCommunityType, setNewCommunityType] = useState<CommunityType>("general");
  const [newCommunityRules, setNewCommunityRules] = useState("");
  const [newCommunityCoverUrl, setNewCommunityCoverUrl] = useState("");

  const { data: allCommunities = [], isLoading: isLoadingAll } = useQuery<CommunityWithDetails[]>({
    queryKey: ['/api/communities'],
    enabled: open,
  });

  const { data: trendingCommunities = [], isLoading: isLoadingTrending } = useQuery<TrendingCommunity[]>({
    queryKey: ['/api/communities/trending'],
    enabled: open && discoverSort === "trending",
  });

  const { data: myCommunities = [], refetch: refetchMyCommunities } = useQuery<CommunityWithRole[]>({
    queryKey: ['/api/communities/my'],
    enabled: open && !!currentUser?.id,
    staleTime: 0,
  });

  const createCommunityMutation = useMutation({
    mutationFn: async (data: { name: string; description: string; type: string; rules: string; coverImageUrl: string }) => {
      return await apiRequest('POST', '/api/communities', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/communities'] });
      queryClient.invalidateQueries({ queryKey: ['/api/communities/my'] });
      setNewCommunityName("");
      setNewCommunityDescription("");
      setNewCommunityType("general");
      setNewCommunityRules("");
      setNewCommunityCoverUrl("");
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
      queryClient.invalidateQueries({ queryKey: ['/api/communities/my'] });
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
      queryClient.invalidateQueries({ queryKey: ['/api/communities/my'] });
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

  const filteredCommunities = (discoverSort === "trending" ? trendingCommunities : allCommunities).filter(c =>
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
      type: newCommunityType,
      rules: newCommunityRules.trim(),
      coverImageUrl: newCommunityCoverUrl,
    });
  };

  const CommunityCard = ({ community, isMember, onAction }: {
    community: CommunityWithDetails | CommunityWithRole | TrendingCommunity;
    isMember: boolean;
    onAction: () => void;
  }) => (
    <Card className="overflow-hidden hover-elevate" data-testid={`card-community-${community.id}`}>
      <div className="h-20 bg-gradient-to-br from-primary/20 to-primary/5 relative">
        {community.coverImageUrl ? (
          <img src={community.coverImageUrl} alt={community.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <UsersIcon className="h-6 w-6 text-primary/30" />
          </div>
        )}
      </div>
      <CardHeader className="p-3 pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm truncate">{community.name}</CardTitle>
            <CardDescription className="text-xs flex items-center gap-1">
              <UsersIcon className="h-3 w-3" />
              {community.memberCount.toLocaleString()} member{community.memberCount !== 1 ? 's' : ''}
            </CardDescription>
          </div>
          <CommunityTypeBadge type={community.type} className="text-[10px] px-1.5 py-0 flex-shrink-0" />
        </div>
      </CardHeader>
      <CardContent className="p-3 pt-0 space-y-2">
        {community.description && (
          <p className="text-xs text-muted-foreground line-clamp-2">{community.description}</p>
        )}
        {isMember ? (
          <Badge variant="secondary" className="w-full justify-center py-1">Joined</Badge>
        ) : (
          <Button size="sm" className="w-full" onClick={onAction} disabled={joinCommunityMutation.isPending} data-testid={`button-join-${community.id}`}>
            Join
          </Button>
        )}
      </CardContent>
    </Card>
  );

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UsersIcon className="h-5 w-5" />
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
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search communities..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                  data-testid="input-search-communities"
                />
              </div>
              <div className="flex rounded-lg border overflow-hidden flex-shrink-0">
                <button
                  type="button"
                  className={`px-3 h-9 text-xs font-medium flex items-center gap-1.5 ${discoverSort === "newest" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"}`}
                  onClick={() => setDiscoverSort("newest")}
                  data-testid="button-sort-newest"
                >
                  <ClockIcon className="h-3.5 w-3.5" />Newest
                </button>
                <button
                  type="button"
                  className={`px-3 h-9 text-xs font-medium flex items-center gap-1.5 ${discoverSort === "trending" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"}`}
                  onClick={() => setDiscoverSort("trending")}
                  data-testid="button-sort-trending"
                >
                  <TrendingUpIcon className="h-3.5 w-3.5" />Trending
                </button>
              </div>
            </div>

            {(discoverSort === "trending" ? isLoadingTrending : isLoadingAll) ? (
              <p className="text-center text-muted-foreground py-4">Loading communities...</p>
            ) : filteredCommunities.length === 0 ? (
              <p className="text-center text-muted-foreground py-4">No communities found. Create one!</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {filteredCommunities.map((community) => (
                  <CommunityCard
                    key={community.id}
                    community={community}
                    isMember={myCommunitiesIds.has(community.id)}
                    onAction={() => joinCommunityMutation.mutate(community.id)}
                  />
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
                          <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                            {community.name}
                            <CommunityTypeBadge type={community.type} className="text-[10px] px-1.5 py-0" />
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
                <Label>Cover Image (optional)</Label>
                <div className="flex items-center gap-3">
                  {newCommunityCoverUrl ? (
                    <img src={newCommunityCoverUrl} alt="" className="h-16 w-28 rounded-lg object-cover border" />
                  ) : (
                    <div className="h-16 w-28 rounded-lg border-2 border-dashed flex items-center justify-center bg-muted/50">
                      <ImageIcon className="h-5 w-5 text-muted-foreground" />
                    </div>
                  )}
                  <ObjectUploader
                    maxNumberOfFiles={1}
                    maxFileSizeMB={5}
                    onComplete={(urls) => urls[0] && setNewCommunityCoverUrl(urls[0])}
                    buttonVariant="outline"
                    buttonSize="sm"
                  >
                    Upload Image
                  </ObjectUploader>
                </div>
              </div>
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
                <Label htmlFor="community-type">Type</Label>
                <select
                  id="community-type"
                  className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm capitalize"
                  value={newCommunityType}
                  onChange={(e) => setNewCommunityType(e.target.value as CommunityType)}
                  data-testid="select-community-type"
                >
                  {communityTypes.map((t) => (
                    <option key={t} value={t} className="capitalize">{t}</option>
                  ))}
                </select>
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
              <div className="space-y-2">
                <Label htmlFor="community-rules">Rules (optional)</Label>
                <Textarea
                  id="community-rules"
                  placeholder="Set expectations for members — e.g. be respectful, no spam, stay on topic..."
                  value={newCommunityRules}
                  onChange={(e) => setNewCommunityRules(e.target.value)}
                  rows={3}
                  data-testid="input-community-rules"
                />
              </div>
              <Button
                onClick={handleCreateCommunity}
                disabled={createCommunityMutation.isPending || !newCommunityName.trim()}
                className="w-full"
                data-testid="button-create-community"
              >
                <PlusIcon className="h-4 w-4 mr-2" />
                {createCommunityMutation.isPending ? "Creating..." : "Create Community"}
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
