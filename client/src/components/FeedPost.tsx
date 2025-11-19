import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Heart, MessageCircle, Share2, Bookmark } from "lucide-react";
import { useState } from "react";

interface FeedPostProps {
  id: string;
  author: {
    name: string;
    username: string;
    avatar?: string;
    isOrganizer?: boolean;
  };
  content: string;
  image?: string;
  timestamp: string;
  likes: number;
  comments: number;
  isLiked?: boolean;
}

export default function FeedPost({
  id,
  author,
  content,
  image,
  timestamp,
  likes,
  comments,
  isLiked = false,
}: FeedPostProps) {
  const [liked, setLiked] = useState(isLiked);
  const [likeCount, setLikeCount] = useState(likes);

  const handleLike = () => {
    setLiked(!liked);
    setLikeCount(liked ? likeCount - 1 : likeCount + 1);
    console.log('Toggled like for post:', id);
  };

  return (
    <Card className="p-4 hover-elevate" data-testid={`post-${id}`}>
      <div className="flex gap-3">
        <Avatar className="h-10 w-10">
          <AvatarImage src={author.avatar} alt={author.name} />
          <AvatarFallback>
            {author.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
          </AvatarFallback>
        </Avatar>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold text-sm" data-testid={`text-author-${id}`}>
              {author.name}
            </p>
            <p className="text-xs text-muted-foreground">
              @{author.username}
            </p>
            {author.isOrganizer && (
              <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                Organizer
              </span>
            )}
            <span className="text-xs text-muted-foreground">· {timestamp}</span>
          </div>

          <p className="mt-2 text-sm whitespace-pre-wrap" data-testid={`text-content-${id}`}>
            {content}
          </p>

          {image && (
            <img
              src={image}
              alt="Post"
              className="mt-3 rounded-md w-full max-h-96 object-cover"
              data-testid={`img-post-${id}`}
            />
          )}

          <div className="flex items-center gap-1 mt-3">
            <Button
              variant="ghost"
              size="sm"
              className={`gap-1 ${liked ? 'text-primary' : ''}`}
              onClick={handleLike}
              data-testid={`button-like-${id}`}
            >
              <Heart className={`h-4 w-4 ${liked ? 'fill-current' : ''}`} />
              <span className="text-xs">{likeCount}</span>
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className="gap-1"
              onClick={() => console.log('Comment on post:', id)}
              data-testid={`button-comment-${id}`}
            >
              <MessageCircle className="h-4 w-4" />
              <span className="text-xs">{comments}</span>
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => console.log('Share post:', id)}
              data-testid={`button-share-${id}`}
            >
              <Share2 className="h-4 w-4" />
            </Button>

            <div className="flex-1" />

            <Button
              variant="ghost"
              size="sm"
              onClick={() => console.log('Bookmark post:', id)}
              data-testid={`button-bookmark-${id}`}
            >
              <Bookmark className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
