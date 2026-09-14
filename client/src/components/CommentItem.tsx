import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import ReportDialog from "@/components/ReportDialog";

import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { formatDistanceToNowStrict } from "date-fns";
import { useLocation } from "wouter";
import MentionTextarea from "./MentionTextarea";
import {
  SendIcon, HeartIcon, MessageCircleIcon, Share2Icon, ChevronDownIcon, ChevronUpIcon,
  MoreHorizontalIcon, Trash2Icon, FlagIcon,
} from "@/components/ui/icons";

// Reddit/X convention: indent visually caps around this depth so a very deep
// thread doesn't push content off-screen; the data model has no depth limit.
const MAX_VISUAL_DEPTH = 5;

type CommentUser = {
  id: string;
  username: string;
  displayName?: string;
  organizationName?: string;
  avatarUrl?: string;
};

type Comment = {
  id: string;
  userId: string;
  postId: string;
  content: string;
  createdAt: string;
  isDeleted?: boolean;
  user: CommentUser;
};

// Flat row shape returned by GET /api/comments/:id/thread — a whole subtree
// in one payload, hydrated recursively into a tree client-side.
type ThreadNode = {
  id: string;
  userId: string;
  postId: string;
  parentCommentId: string | null;
  content: string;
  createdAt: string;
  isDeleted?: boolean;
  user: CommentUser;
  likeCount: number;
  isLiked: boolean;
};

interface CommentItemProps {
  comment: Comment;
  postId: string;
  onNavigate?: (path: string) => void;
  renderContent?: (content: string) => React.ReactNode;
}

function relativeTime(dateStr: string) {
  try {
    return formatDistanceToNowStrict(new Date(dateStr), { addSuffix: true });
  } catch {
    return "";
  }
}

function renderWithMentions(text: string, navigate: (path: string) => void): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(@\w+|#\w+)/g;
  let lastIndex = 0;
  let match;
  let i = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("@")) {
      const username = token.slice(1);
      parts.push(
        <button
          key={i++}
          onClick={(e) => { e.stopPropagation(); navigate(`/profile/${username}`); }}
          className="text-primary hover:underline font-medium"
        >
          {token}
        </button>
      );
    } else {
      parts.push(
        <button
          key={i++}
          onClick={(e) => { e.stopPropagation(); navigate(`/search?tag=${token.slice(1)}`); }}
          className="text-primary hover:underline font-medium"
        >
          {token}
        </button>
      );
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return <>{parts}</>;
}

export default function CommentItem({
  comment,
  postId,
  onNavigate,
  renderContent,
}: CommentItemProps) {
  const { toast } = useToast();
  const { data: currentUser } = useAuth();
  const [, navigate] = useLocation();
  const [showReplies, setShowReplies] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [showReplyInput, setShowReplyInput] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [reportDialogOpen, setReportDialogOpen] = useState(false);

  const goTo = (path: string) => {
    if (onNavigate) onNavigate(path);
    else navigate(path);
  };

  const isOwn = currentUser?.id === comment.userId;
  const isDeleted = !!comment.isDeleted;

  const handleProfileClick = () => {
    goTo(comment.user.id ? `/user/${comment.user.id}` : `/profile/${comment.user.username}`);
  };

  const { data: likeData } = useQuery<{ count: number; isLiked: boolean }>({
    queryKey: ["/api/comments", comment.id, "likes"],
  });

  // Eager, lightweight — direct-child count only, so the "View replies"
  // toggle shows up immediately instead of waiting on the (lazy) full subtree.
  const { data: repliesMeta } = useQuery<{ replies: unknown[]; count: number }>({
    queryKey: ["/api/comments", comment.id, "replies"],
  });

  // Lazy — the whole recursive subtree in one query, fetched only once this
  // top-level comment's replies are actually expanded.
  const { data: threadData, isLoading: threadLoading } = useQuery<{ thread: ThreadNode[]; count: number }>({
    queryKey: ["/api/comments", comment.id, "thread"],
    enabled: showReplies,
  });

  const likeMutation = useMutation({
    mutationFn: async () => {
      if (likeData?.isLiked) {
        return await apiRequest("DELETE", `/api/comments/${comment.id}/like`, {});
      }
      return await apiRequest("POST", `/api/comments/${comment.id}/like`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/comments", comment.id, "likes"] });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to update like", variant: "destructive" });
    },
  });

  const replyMutation = useMutation({
    mutationFn: async (content: string) => {
      return await apiRequest("POST", `/api/comments/${comment.id}/replies`, { content });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/comments", comment.id, "replies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/comments", comment.id, "thread"] });
      setReplyText("");
      setShowReplyInput(false);
      setShowReplies(true);
      toast({ title: "Reply posted!" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to post reply", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => await apiRequest("DELETE", `/api/comments/${comment.id}`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/posts", postId, "comments"] });
      toast({ title: "Comment deleted" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete comment", variant: "destructive" });
    },
  });

  const handleOpenReply = () => {
    const prefix = `@${comment.user.username} `;
    setReplyText(replyText.startsWith(prefix) ? replyText : prefix);
    setShowReplyInput(true);
  };

  const handleShare = async () => {
    const url = `${window.location.origin}/feed?comment=${comment.id}`;
    try {
      if (navigator.share) {
        await navigator.share({ text: comment.content, url });
      } else {
        window.open(`https://wa.me/?text=${encodeURIComponent(`${comment.content}\n${url}`)}`, "_blank", "noopener,noreferrer");
      }
    } catch {
      // User cancelled the native share sheet — no action needed
    }
  };

  // Flat thread rows -> parentId -> children[] map, so each node renders its
  // own direct children recursively without re-fetching anything.
  const childrenByParent = useMemo(() => {
    const map = new Map<string, ThreadNode[]>();
    for (const node of threadData?.thread ?? []) {
      const key = node.parentCommentId ?? "";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(node);
    }
    return map;
  }, [threadData]);

  const likeCount = likeData?.count ?? 0;
  const isLiked = likeData?.isLiked ?? false;
  const replyCount = repliesMeta?.count ?? 0;
  const displayName = comment.user.displayName || comment.user.organizationName || comment.user.username;

  return (
    <div className="flex gap-3" data-testid={`comment-${comment.id}`}>
      {/* Avatar + thread line */}
      <div className="flex flex-col items-center flex-shrink-0">
        <Avatar
          className="h-9 w-9 cursor-pointer hover:opacity-80 transition-opacity"
          onClick={handleProfileClick}
        >
          <AvatarImage src={comment.user.avatarUrl || ""} alt={displayName} />
          <AvatarFallback className="bg-primary/10 text-primary text-sm">
            {displayName.charAt(0).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        {showReplies && (threadData?.thread.length ?? 0) > 0 && (
          <div className="w-0.5 flex-1 bg-border mt-1 min-h-4" />
        )}
      </div>

      <div className="flex-1 min-w-0 pb-2">
        {isDeleted ? (
          <p className="text-sm text-muted-foreground italic py-1" data-testid={`comment-text-${comment.id}`}>
            [comment deleted]
          </p>
        ) : (
          <>
            {/* Author + time */}
            <div className="flex items-baseline gap-1.5 flex-wrap mb-0.5">
              <button className="font-semibold text-sm hover:underline" onClick={handleProfileClick}>
                {displayName}
              </button>
              <span className="text-xs text-muted-foreground">@{comment.user.username}</span>
              <span className="text-xs text-muted-foreground">·</span>
              <span className="text-xs text-muted-foreground">{relativeTime(comment.createdAt)}</span>

              <div className="ml-auto">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className="p-1 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                      data-testid={`button-more-comment-${comment.id}`}
                    >
                      <MoreHorizontalIcon className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {isOwn ? (
                      <DropdownMenuItem
                        onClick={() => setDeleteDialogOpen(true)}
                        className="text-destructive focus:text-destructive"
                        data-testid={`menu-delete-comment-${comment.id}`}
                      >
                        <Trash2Icon className="h-4 w-4 mr-2" />
                        Delete comment
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        onClick={() => setReportDialogOpen(true)}
                        data-testid={`menu-report-comment-${comment.id}`}
                      >
                        <FlagIcon className="h-4 w-4 mr-2" />
                        Report comment
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            {/* Content */}
            <p className="text-sm break-words leading-relaxed" data-testid={`comment-text-${comment.id}`}>
              {renderContent ? renderContent(comment.content) : renderWithMentions(comment.content, goTo)}
            </p>
          </>
        )}

        {/* Action bar */}
        <div className="flex items-center gap-0 mt-1.5 -ml-1.5">
          <Button
            variant="ghost"
            size="sm"
            className={`h-7 px-1.5 text-xs gap-1 ${isLiked ? "text-red-500" : "text-muted-foreground"} hover:text-red-500`}
            onClick={() => likeMutation.mutate()}
            disabled={likeMutation.isPending || isDeleted}
            data-testid={`button-like-comment-${comment.id}`}
          >
            <HeartIcon className={`h-3.5 w-3.5 ${isLiked ? "fill-current" : ""}`} />
            {likeCount > 0 && <span>{likeCount}</span>}
          </Button>

          {!isDeleted && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-1.5 text-xs gap-1 text-muted-foreground hover:text-primary"
              onClick={handleOpenReply}
              data-testid={`button-reply-comment-${comment.id}`}
            >
              <MessageCircleIcon className="h-3.5 w-3.5" />
              {replyCount > 0 && <span>{replyCount}</span>}
            </Button>
          )}

          {!isDeleted && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-1.5 text-xs text-muted-foreground hover:text-primary"
              onClick={handleShare}
              data-testid={`button-share-comment-${comment.id}`}
            >
              <Share2Icon className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        {/* Reply input */}
        {showReplyInput && (
          <div className="mt-2 flex gap-2 items-start">
            <div className="flex-1">
              <MentionTextarea
                value={replyText}
                onChange={setReplyText}
                placeholder={`Reply to @${comment.user.username}...`}
                rows={2}
                className="text-sm resize-none"
                data-testid={`input-reply-${comment.id}`}
              />
            </div>
            <div className="flex flex-col gap-1 pt-1">
              <Button
                size="icon"
                className="h-8 w-8"
                onClick={() => { if (replyText.trim()) replyMutation.mutate(replyText); }}
                disabled={!replyText.trim() || replyMutation.isPending}
                data-testid={`button-send-reply-${comment.id}`}
              >
                <SendIcon className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 text-muted-foreground"
                onClick={() => setShowReplyInput(false)}
              >
                ✕
              </Button>
            </div>
          </div>
        )}

        {/* Show/hide replies toggle */}
        {replyCount > 0 && (
          <button
            className="flex items-center gap-1.5 text-xs text-primary mt-2 hover:underline font-medium"
            onClick={() => setShowReplies(!showReplies)}
            data-testid={`button-toggle-replies-${comment.id}`}
          >
            {showReplies ? (
              <><ChevronUpIcon className="h-3.5 w-3.5" /> Hide replies</>
            ) : (
              <><ChevronDownIcon className="h-3.5 w-3.5" /> View {replyCount} {replyCount === 1 ? "reply" : "replies"}</>
            )}
          </button>
        )}

        {/* Recursive replies tree */}
        {showReplies && (
          <div className="mt-3 space-y-3">
            {threadLoading ? (
              <p className="text-xs text-muted-foreground">Loading replies…</p>
            ) : (
              (childrenByParent.get(comment.id) ?? []).map((node) => (
                <ThreadedReply
                  key={node.id}
                  node={node}
                  postId={postId}
                  depth={1}
                  childrenByParent={childrenByParent}
                  navigate={goTo}
                />
              ))
            )}
          </div>
        )}
      </div>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete comment?</AlertDialogTitle>
            <AlertDialogDescription>
              Replies underneath will stay visible. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid={`button-cancel-delete-comment-${comment.id}`}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid={`button-confirm-delete-comment-${comment.id}`}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ReportDialog
        open={reportDialogOpen}
        onClose={() => setReportDialogOpen(false)}
        endpoint={`/api/comments/${comment.id}/report`}
        itemLabel="comment"
      />
    </div>
  );
}

interface ThreadedReplyProps {
  node: ThreadNode;
  postId: string;
  depth: number;
  childrenByParent: Map<string, ThreadNode[]>;
  navigate: (path: string) => void;
}

// Recursive — each node fetches nothing of its own (the whole subtree was
// already loaded by the top-level CommentItem's one lazy /thread call) and
// renders its own children the same way, at any depth.
function ThreadedReply({ node, postId, depth, childrenByParent, navigate }: ThreadedReplyProps) {
  const { toast } = useToast();
  const { data: currentUser } = useAuth();
  const [showReplyInput, setShowReplyInput] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [childrenVisible, setChildrenVisible] = useState(true);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [reportDialogOpen, setReportDialogOpen] = useState(false);
  const [optimisticLike, setOptimisticLike] = useState<{ isLiked: boolean; count: number } | null>(null);

  const isOwn = currentUser?.id === node.userId;
  const isDeleted = !!node.isDeleted;
  const isLiked = optimisticLike?.isLiked ?? node.isLiked;
  const likeCount = optimisticLike?.count ?? node.likeCount;
  const displayName = node.user.displayName || node.user.organizationName || node.user.username;
  const children = childrenByParent.get(node.id) ?? [];
  const visualDepth = Math.min(depth, MAX_VISUAL_DEPTH);

  const likeMutation = useMutation({
    mutationFn: async () => {
      if (isLiked) {
        return await apiRequest("DELETE", `/api/comments/${node.id}/like`, {});
      }
      return await apiRequest("POST", `/api/comments/${node.id}/like`, {});
    },
    onMutate: () => {
      setOptimisticLike({ isLiked: !isLiked, count: isLiked ? likeCount - 1 : likeCount + 1 });
    },
    onError: () => {
      setOptimisticLike(null);
      toast({ title: "Error", description: "Failed to update like", variant: "destructive" });
    },
  });

  const replyMutation = useMutation({
    mutationFn: async (content: string) => {
      return await apiRequest("POST", `/api/comments/${node.id}/replies`, { content });
    },
    onSuccess: () => {
      // Invalidate the top-level thread this node belongs to so the new
      // reply appears — every node shares the same underlying query.
      queryClient.invalidateQueries({
        queryKey: ["/api/comments"],
        predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[2] === "thread",
      });
      setReplyText("");
      setShowReplyInput(false);
      setChildrenVisible(true);
      toast({ title: "Reply posted!" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to post reply", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => await apiRequest("DELETE", `/api/comments/${node.id}`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/posts", postId, "comments"] });
      queryClient.invalidateQueries({
        queryKey: ["/api/comments"],
        predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[2] === "thread",
      });
      toast({ title: "Comment deleted" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete comment", variant: "destructive" });
    },
  });

  const goToProfile = () => navigate(node.user.id ? `/user/${node.user.id}` : `/profile/${node.user.username}`);

  const handleOpenReply = () => {
    const prefix = `@${node.user.username} `;
    setReplyText(replyText.startsWith(prefix) ? replyText : prefix);
    setShowReplyInput(true);
  };

  const handleShare = async () => {
    const url = `${window.location.origin}/feed?comment=${node.id}`;
    try {
      if (navigator.share) {
        await navigator.share({ text: node.content, url });
      } else {
        window.open(`https://wa.me/?text=${encodeURIComponent(`${node.content}\n${url}`)}`, "_blank", "noopener,noreferrer");
      }
    } catch {
      // User cancelled the native share sheet — no action needed
    }
  };

  return (
    <div
      className="flex gap-2.5"
      style={{ marginLeft: `${(visualDepth - 1) * 20}px` }}
      data-testid={`reply-${node.id}`}
    >
      <Avatar
        className="h-7 w-7 flex-shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
        onClick={goToProfile}
      >
        <AvatarImage src={node.user.avatarUrl || ""} alt={displayName} />
        <AvatarFallback className="bg-primary/10 text-primary text-xs">
          {displayName.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>

      <div className="flex-1 min-w-0">
        {isDeleted ? (
          <p className="text-xs text-muted-foreground italic py-0.5">[comment deleted]</p>
        ) : (
          <>
            <div className="flex items-baseline gap-1.5 flex-wrap mb-0.5">
              <button className="font-semibold text-xs hover:underline" onClick={goToProfile}>
                {displayName}
              </button>
              <span className="text-[11px] text-muted-foreground">@{node.user.username}</span>
              <span className="text-[11px] text-muted-foreground">·</span>
              <span className="text-[11px] text-muted-foreground">{relativeTime(node.createdAt)}</span>

              <div className="ml-auto">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="p-1 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors">
                      <MoreHorizontalIcon className="h-3 w-3" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {isOwn ? (
                      <DropdownMenuItem
                        onClick={() => setDeleteDialogOpen(true)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2Icon className="h-4 w-4 mr-2" />
                        Delete comment
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onClick={() => setReportDialogOpen(true)}>
                        <FlagIcon className="h-4 w-4 mr-2" />
                        Report comment
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            <p className="text-sm break-words leading-relaxed">
              {renderWithMentions(node.content, navigate)}
            </p>
          </>
        )}

        <div className="flex items-center gap-0 mt-1 -ml-1.5">
          <Button
            variant="ghost"
            size="sm"
            className={`h-6 px-1.5 text-[11px] gap-1 ${isLiked ? "text-red-500" : "text-muted-foreground"} hover:text-red-500`}
            onClick={() => likeMutation.mutate()}
            disabled={likeMutation.isPending || isDeleted}
          >
            <HeartIcon className={`h-3 w-3 ${isLiked ? "fill-current" : ""}`} />
            {likeCount > 0 && <span>{likeCount}</span>}
          </Button>

          {!isDeleted && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-primary"
              onClick={handleOpenReply}
            >
              <MessageCircleIcon className="h-3 w-3" />
            </Button>
          )}

          {!isDeleted && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-primary"
              onClick={handleShare}
            >
              <Share2Icon className="h-3 w-3" />
            </Button>
          )}

          {children.length > 0 && (
            <button
              className="h-6 px-1.5 text-[11px] text-primary hover:underline font-medium"
              onClick={() => setChildrenVisible(!childrenVisible)}
            >
              {childrenVisible ? "Hide" : `View ${children.length}`} {children.length === 1 ? "reply" : "replies"}
            </button>
          )}
        </div>

        {showReplyInput && (
          <div className="mt-2 flex gap-2 items-start">
            <div className="flex-1">
              <MentionTextarea
                value={replyText}
                onChange={setReplyText}
                placeholder={`Reply to @${node.user.username}...`}
                rows={2}
                className="text-sm resize-none"
              />
            </div>
            <div className="flex flex-col gap-1 pt-1">
              <Button
                size="icon"
                className="h-8 w-8"
                onClick={() => { if (replyText.trim()) replyMutation.mutate(replyText); }}
                disabled={!replyText.trim() || replyMutation.isPending}
              >
                <SendIcon className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 text-muted-foreground"
                onClick={() => setShowReplyInput(false)}
              >
                ✕
              </Button>
            </div>
          </div>
        )}

        {childrenVisible && children.length > 0 && (
          <div className="mt-3 space-y-3">
            {children.map((child) => (
              <ThreadedReply
                key={child.id}
                node={child}
                postId={postId}
                depth={depth + 1}
                childrenByParent={childrenByParent}
                navigate={navigate}
              />
            ))}
          </div>
        )}
      </div>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete comment?</AlertDialogTitle>
            <AlertDialogDescription>
              Replies underneath will stay visible. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ReportDialog
        open={reportDialogOpen}
        onClose={() => setReportDialogOpen(false)}
        endpoint={`/api/comments/${node.id}/report`}
        itemLabel="comment"
      />
    </div>
  );
}
