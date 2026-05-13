import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Send } from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import CommentItem from "./CommentItem";
import MentionTextarea from "./MentionTextarea";

interface PostSummary {
  authorName: string;
  authorUsername: string;
  authorAvatar?: string;
  content: string;
}

interface CommentDialogProps {
  open: boolean;
  onClose: () => void;
  postId: string;
  postSummary?: PostSummary;
}

type Comment = {
  id: string;
  userId: string;
  postId: string;
  content: string;
  createdAt: string;
  user: {
    id: string;
    username: string;
    displayName?: string;
    organizationName?: string;
    avatarUrl?: string;
  };
};

export default function CommentDialog({ open, onClose, postId, postSummary }: CommentDialogProps) {
  const [commentText, setCommentText] = useState("");
  const { toast } = useToast();
  const { data: currentUser } = useAuth();
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: commentsData, isLoading } = useQuery<{ comments: Comment[]; count: number }>({
    queryKey: ["/api/posts", postId, "comments"],
    enabled: open,
  });

  const comments = commentsData?.comments || [];

  const addCommentMutation = useMutation({
    mutationFn: async (content: string) => {
      return await apiRequest("POST", `/api/posts/${postId}/comments`, { content });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/posts", postId, "comments"] });
      setCommentText("");
      toast({ title: "Comment added!" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to add comment", variant: "destructive" });
    },
  });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [comments]);

  const handleAddComment = () => {
    if (commentText.trim()) addCommentMutation.mutate(commentText);
  };

  // Current user initials for C3 avatar
  const currentUserInitial = (
    currentUser?.userType === "social"
      ? currentUser?.displayName?.charAt(0) || currentUser?.username.charAt(0)
      : currentUser?.organizationName?.charAt(0) || currentUser?.username.charAt(0)
  )?.toUpperCase() || "?";

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        {/* Backdrop */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />

        {/* C1: bottom sheet on mobile, centered dialog on sm+ */}
        <DialogPrimitive.Content
          className={cn(
            // Mobile: anchored to bottom, slides up
            "fixed inset-x-0 bottom-0 z-50 flex flex-col bg-background outline-none",
            "rounded-t-2xl max-h-[85vh]",
            // Desktop: centered card
            "sm:inset-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2",
            "sm:w-full sm:max-w-[550px] sm:rounded-2xl sm:max-h-[80vh]",
            // Animations — slide up on mobile, zoom on desktop
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
            "sm:data-[state=closed]:slide-out-to-bottom-0 sm:data-[state=open]:slide-in-from-bottom-0",
            "sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:zoom-in-95"
          )}
        >
          <DialogPrimitive.Title className="sr-only">Comments</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Read and add comments on this post.
          </DialogPrimitive.Description>

          {/* Drag handle (mobile only) */}
          <div className="flex justify-center pt-3 pb-1 sm:hidden flex-shrink-0">
            <div className="w-10 h-1 rounded-full bg-border" />
          </div>

          {/* ── Header ── */}
          <div className="px-4 py-3 border-b border-border flex-shrink-0">
            <p className="font-semibold text-sm text-center sm:text-left">Comments</p>
          </div>

          {/* C2: Original post summary pinned below header */}
          {postSummary && (
            <div className="px-4 py-3 border-b border-border/60 bg-muted/30 flex-shrink-0">
              <div className="flex items-start gap-2.5">
                <Avatar className="h-8 w-8 flex-shrink-0 mt-0.5">
                  <AvatarImage src={postSummary.authorAvatar || ""} alt={postSummary.authorName} />
                  <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
                    {postSummary.authorName.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold leading-none mb-1">
                    {postSummary.authorName}
                    <span className="font-normal text-muted-foreground ml-1">
                      @{postSummary.authorUsername}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground leading-snug line-clamp-2">
                    {postSummary.content}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ── Comments list ── */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
            {isLoading ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex gap-3">
                    <Skeleton className="h-10 w-10 rounded-full flex-shrink-0" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-24" />
                      <Skeleton className="h-12 w-full" />
                    </div>
                  </div>
                ))}
              </div>
            ) : comments.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground">
                <p className="font-medium">No comments yet</p>
                <p className="text-sm mt-1">Be the first to comment!</p>
              </div>
            ) : (
              <div className="space-y-4">
                {comments.map((comment) => (
                  <CommentItem key={comment.id} comment={comment} postId={postId} />
                ))}
              </div>
            )}
          </div>

          {/* ── C3: Comment input with current user avatar ── */}
          <div className="px-4 py-3 border-t border-border bg-background flex-shrink-0">
            <div className="flex items-end gap-2.5">
              {/* C3: current user avatar */}
              <Avatar className="h-8 w-8 flex-shrink-0 mb-0.5">
                <AvatarImage src="" alt={currentUser?.username || "You"} />
                <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
                  {currentUserInitial}
                </AvatarFallback>
              </Avatar>

              <div className="flex-1 min-w-0">
                <MentionTextarea
                  value={commentText}
                  onChange={setCommentText}
                  placeholder="Add a comment…"
                  disabled={addCommentMutation.isPending}
                  rows={2}
                  className="text-sm resize-none border-0 bg-muted/40 rounded-xl px-3 py-2 focus-visible:ring-1 focus-visible:ring-primary/50"
                  data-testid="input-comment"
                />
              </div>

              <button
                onClick={handleAddComment}
                disabled={!commentText.trim() || addCommentMutation.isPending}
                className="mb-0.5 h-8 w-8 flex items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40 hover:bg-primary/90 transition-colors flex-shrink-0"
                data-testid="button-send-comment"
                aria-label="Send comment"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
