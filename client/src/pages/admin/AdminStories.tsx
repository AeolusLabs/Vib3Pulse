import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, Trash2, Eye, Image as ImageIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import AdminLayout from "./AdminLayout";
import { format } from "date-fns";

interface Story {
  id: string;
  mediaUrl: string;
  mediaType: string;
  caption: string | null;
  privacy: string;
  createdAt: string;
  expiresAt: string;
  user: {
    id: string;
    username: string;
    displayName: string | null;
  };
}

export default function AdminStories() {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");

  const { data: stories, isLoading } = useQuery<Story[]>({
    queryKey: ["/api/admin/stories"],
  });

  const deleteMutation = useMutation({
    mutationFn: async (storyId: string) => {
      await apiRequest("DELETE", `/api/admin/stories/${storyId}`);
    },
    onSuccess: () => {
      toast({
        title: "Story deleted",
        description: "The story has been deleted successfully",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/stories"] });
    },
    onError: (error: any) => {
      toast({
        title: "Delete failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const filteredStories = stories?.filter(story =>
    story.user.username.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (story.caption?.toLowerCase().includes(searchQuery.toLowerCase()))
  ) || [];

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Story Moderation</h1>
          <p className="text-slate-400 mt-1">
            Review and moderate user stories
          </p>
        </div>

        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader>
            <div className="flex items-center gap-4">
              <div className="relative flex-1 max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <Input
                  placeholder="Search stories..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10 bg-slate-700/50 border-slate-600 text-white"
                  data-testid="input-search-stories"
                />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-8 text-slate-400">Loading stories...</div>
            ) : filteredStories.length === 0 ? (
              <div className="text-center py-8 text-slate-400">No stories found</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {filteredStories.map((story) => (
                  <Card key={story.id} className="bg-slate-700/50 border-slate-600 overflow-hidden">
                    <div className="aspect-[9/16] relative bg-slate-800">
                      {story.mediaType === "image" ? (
                        <img
                          src={story.mediaUrl}
                          alt="Story"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <video
                          src={story.mediaUrl}
                          className="w-full h-full object-cover"
                          muted
                        />
                      )}
                      <div className="absolute top-2 right-2">
                        <Badge variant="outline" className="bg-slate-800/80 border-slate-600 text-slate-300">
                          {story.mediaType}
                        </Badge>
                      </div>
                    </div>
                    <CardContent className="p-3">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-sm font-medium text-white">
                          @{story.user.username}
                        </p>
                        <Badge variant="outline" className="border-slate-500 text-slate-400 text-xs">
                          {story.privacy}
                        </Badge>
                      </div>
                      {story.caption && (
                        <p className="text-sm text-slate-400 truncate mb-2">
                          {story.caption}
                        </p>
                      )}
                      <p className="text-xs text-slate-500 mb-3">
                        {format(new Date(story.createdAt), 'MMM d, h:mm a')}
                      </p>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="flex-1 text-slate-400 hover:text-white"
                          data-testid={`button-view-story-${story.id}`}
                        >
                          <Eye className="w-4 h-4 mr-1" /> View
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="flex-1 text-red-400 hover:text-red-300"
                          onClick={() => {
                            if (confirm("Are you sure you want to delete this story?")) {
                              deleteMutation.mutate(story.id);
                            }
                          }}
                          data-testid={`button-delete-story-${story.id}`}
                        >
                          <Trash2 className="w-4 h-4 mr-1" /> Delete
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
