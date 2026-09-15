import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import { HeartIcon, SendIcon, Trash2Icon, XIcon, Loader2Icon, ReplyIcon } from "@/components/ui/icons";

interface StoryComment {
  id: string;
  userId: string;
  storyId: string | null;
  parentCommentId: string | null;
  content: string;
  isDeleted: boolean;
  createdAt: string;
  likeCount: number;
  isLiked: boolean;
  user: {
    id: string;
    username: string;
    displayName?: string | null;
    avatarUrl?: string | null;
  };
}

interface StoryCommentsSheetProps {
  storyId: string;
  storyOwnerId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function StoryCommentsSheet({
  storyId,
  storyOwnerId,
  open,
  onOpenChange,
}: StoryCommentsSheetProps) {
  const { data: currentUser } = useAuth();
  const { toast } = useToast();
  const [commentText, setCommentText] = useState("");
  const [replyingTo, setReplyingTo] = useState<StoryComment | null>(null);
  const isOwner = currentUser?.id === storyOwnerId;

  // Short poll while the sheet is open, matching the "live" precedent used
  // elsewhere this session (ticket availability) rather than standing up a
  // bespoke websocket presence system for an ephemeral, small-scale surface.
  // Same query key StoryViewer uses for its comment-count badge, so both
  // share one cache entry and stay in sync automatically.
  const { data, isLoading } = useQuery<{ comments: StoryComment[]; count: number }>({
    queryKey: [`/api/stories/${storyId}/comments`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/stories/${storyId}/comments`);
      return res.json();
    },
    enabled: open,
    refetchInterval: open ? 5000 : false,
  });

  const comments = data?.comments ?? [];

  const addCommentMutation = useMutation({
    mutationFn: async ({ content, parentCommentId }: { content: string; parentCommentId?: string }) => {
      const res = await apiRequest("POST", `/api/stories/${storyId}/comments`, { content, parentCommentId });
      return res.json();
    },
    onSuccess: () => {
      setCommentText("");
      setReplyingTo(null);
      queryClient.invalidateQueries({ queryKey: [`/api/stories/${storyId}/comments`] });
    },
    onError: (error: any) => {
      toast({ title: "Couldn't post comment", description: error.message, variant: "destructive" });
    },
  });

  const deleteCommentMutation = useMutation({
    mutationFn: async (commentId: string) => {
      return await apiRequest("DELETE", `/api/comments/${commentId}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/stories/${storyId}/comments`] });
    },
  });

  const toggleLikeMutation = useMutation({
    mutationFn: async ({ commentId, liked }: { commentId: string; liked: boolean }) => {
      return await apiRequest(liked ? "DELETE" : "POST", `/api/comments/${commentId}/like`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/stories/${storyId}/comments`] });
    },
  });

  const handleSend = () => {
    const content = commentText.trim();
    if (!content) return;
    addCommentMutation.mutate({ content, parentCommentId: replyingTo?.id });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="bg-zinc-900 border-zinc-700 text-white rounded-t-2xl max-h-[75vh] flex flex-col p-0"
      >
        <SheetHeader className="px-4 pt-4 pb-3 border-b border-zinc-700">
          <SheetTitle className="text-white text-base font-semibold">
            Comments {data?.count ? `(${data.count})` : ""}
          </SheetTitle>
        </SheetHeader>

        <ScrollArea className="flex-1 px-4">
          {isLoading ? (
            <div className="flex justify-center py-10">
              <Loader2Icon className="h-5 w-5 animate-spin text-white/60" />
            </div>
          ) : comments.length === 0 ? (
            <div className="text-center py-10 text-sm text-white/50">
              No comments yet. Be the first to say something.
            </div>
          ) : (
            <div className="space-y-3 py-3">
              {comments.map((comment) => {
                const isCommentOwner = comment.userId === currentUser?.id;
                const isFromStoryOwner = comment.userId === storyOwnerId;
                return (
                  <div key={comment.id} className="flex gap-2.5" data-testid={`story-comment-${comment.id}`}>
                    <Avatar className="h-8 w-8 flex-shrink-0">
                      <AvatarImage src={comment.user.avatarUrl ?? undefined} />
                      <AvatarFallback className="bg-white/10 text-white text-xs">
                        {(comment.user.displayName || comment.user.username).charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-sm font-medium">{comment.user.displayName || comment.user.username}</span>
                        {isFromStoryOwner && (
                          <span className="text-[10px] bg-primary/30 text-primary-foreground px-1.5 py-0.5 rounded-full">Author</span>
                        )}
                        <span className="text-[11px] text-white/40">{formatDistanceToNow(new Date(comment.createdAt), { addSuffix: true })}</span>
                      </div>
                      {comment.isDeleted ? (
                        <p className="text-sm text-white/40 italic mt-0.5">[comment deleted]</p>
                      ) : (
                        <>
                          <p className="text-sm text-white/90 mt-0.5 break-words">{comment.content}</p>
                          <div className="flex items-center gap-3 mt-1">
                            <button
                              className={`flex items-center gap-1 text-[11px] ${comment.isLiked ? "text-red-500" : "text-white/50"}`}
                              onClick={() => toggleLikeMutation.mutate({ commentId: comment.id, liked: comment.isLiked })}
                              data-testid={`button-like-comment-${comment.id}`}
                            >
                              <HeartIcon className={`h-3.5 w-3.5 ${comment.isLiked ? "fill-red-500" : ""}`} />
                              {comment.likeCount > 0 && comment.likeCount}
                            </button>
                            {isOwner && !isFromStoryOwner && (
                              <button
                                className="flex items-center gap-1 text-[11px] text-white/50"
                                onClick={() => { setReplyingTo(comment); }}
                                data-testid={`button-reply-comment-${comment.id}`}
                              >
                                <ReplyIcon className="h-3.5 w-3.5" />
                                Reply
                              </button>
                            )}
                            {(isCommentOwner || isOwner) && (
                              <button
                                className="text-[11px] text-white/50"
                                onClick={() => deleteCommentMutation.mutate(comment.id)}
                                data-testid={`button-delete-comment-${comment.id}`}
                              >
                                <Trash2Icon className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>

        <div className="px-4 py-3 border-t border-zinc-700 flex-shrink-0">
          {replyingTo && (
            <div className="flex items-center justify-between mb-2 px-2.5 py-1.5 bg-white/5 rounded-lg">
              <span className="text-xs text-white/60">Replying to @{replyingTo.user.username}</span>
              <button onClick={() => setReplyingTo(null)}><XIcon className="h-3.5 w-3.5 text-white/60" /></button>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Input
              placeholder={isOwner ? "Reply as the story author…" : "Add a comment…"}
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              className="bg-white/10 border-white/20 text-white placeholder:text-white/40"
              data-testid="input-story-comment"
            />
            <Button
              size="icon"
              onClick={handleSend}
              disabled={!commentText.trim() || addCommentMutation.isPending}
              className="flex-shrink-0"
              data-testid="button-send-comment"
            >
              <SendIcon className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
