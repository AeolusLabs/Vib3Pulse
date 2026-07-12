import { useRoute, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import PostDetailDialog from "@/components/PostDetailDialog";

export default function PostDetailPage() {
  const [, params] = useRoute("/posts/:id");
  const [, navigate] = useLocation();
  const postId = params?.id;

  const { data: post, isLoading } = useQuery<any>({
    queryKey: ["/api/posts", postId],
    queryFn: async () => {
      const res = await fetch(`/api/posts/${postId}`);
      if (!res.ok) throw new Error("Post not found");
      return res.json();
    },
    enabled: !!postId,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (!post) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Post not found</p>
      </div>
    );
  }

  return (
    <PostDetailDialog
      open={true}
      onClose={() => navigate("/feed")}
      postId={post.id}
      author={{
        name: post.user?.displayName || post.user?.username || "Unknown",
        username: post.user?.username || "",
        avatar: post.user?.avatarUrl ?? undefined,
        userId: post.user?.id,
      }}
      content={post.content || ""}
      image={post.imageUrl ?? undefined}
      imageUrls={post.imageUrls ?? undefined}
      videoUrl={post.videoUrl ?? undefined}
      createdAt={post.createdAt}
    />
  );
}
