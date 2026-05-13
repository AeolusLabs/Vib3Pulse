import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Send } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import CommentItem from "./CommentItem";
import MentionTextarea from "./MentionTextarea";

interface CommentDialogProps {
  open: boolean;
  onClose: () => void;
  postId: string;
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

export default function CommentDialog({ open, onClose, postId }: CommentDialogProps) {
  const [commentText, setCommentText] = useState("");
  const { toast } = useToast();
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: commentsData, isLoading } = useQuery<{ comments: Comment[]; count: number }>({
    queryKey: ['/api/posts', postId, 'comments'],
    enabled: open,
  });
  
  const comments = commentsData?.comments || [];

  const addCommentMutation = useMutation({
    mutationFn: async (content: string) => {
      return await apiRequest('POST', `/api/posts/${postId}/comments`, { content });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/posts', postId, 'comments'] });
      setCommentText("");
      toast({
        title: "Comment added!",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to add comment",
        variant: "destructive",
      });
    },
  });

  const handleAddComment = () => {
    if (commentText.trim()) {
      addCommentMutation.mutate(commentText);
    }
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [comments]);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="sm:max-w-[550px] max-h-[80vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle>Comments</DialogTitle>
        </DialogHeader>

        <ScrollArea className="flex-1 px-6 py-4" ref={scrollRef}>
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex gap-3">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-12 w-full" />
                  </div>
                </div>
              ))}
            </div>
          ) : comments.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <p>No comments yet</p>
              <p className="text-sm mt-1">Be the first to comment!</p>
            </div>
          ) : (
            <div className="space-y-4">
              {comments.map((comment) => (
                <CommentItem 
                  key={comment.id} 
                  comment={comment} 
                  postId={postId}
                />
              ))}
            </div>
          )}
        </ScrollArea>

        <div className="px-6 py-3 border-t bg-background">
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <MentionTextarea
                value={commentText}
                onChange={setCommentText}
                placeholder="Write a comment..."
                disabled={addCommentMutation.isPending}
                rows={2}
                className="text-sm resize-none"
                data-testid="input-comment"
              />
            </div>
            <Button
              size="icon"
              onClick={handleAddComment}
              disabled={!commentText.trim() || addCommentMutation.isPending}
              className="mb-0.5 flex-shrink-0"
              data-testid="button-send-comment"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
