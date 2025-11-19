import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { UserPlus, UserCheck } from "lucide-react";
import { useState } from "react";

interface UserProfileCardProps {
  name: string;
  username: string;
  bio?: string;
  avatar?: string;
  coverImage?: string;
  followersCount: number;
  followingCount: number;
  isFollowing?: boolean;
  onFollowToggle?: (following: boolean) => void;
}

export default function UserProfileCard({
  name,
  username,
  bio,
  avatar,
  coverImage,
  followersCount,
  followingCount,
  isFollowing: initialFollowing = false,
  onFollowToggle,
}: UserProfileCardProps) {
  const [isFollowing, setIsFollowing] = useState(initialFollowing);

  const handleFollow = () => {
    const newState = !isFollowing;
    setIsFollowing(newState);
    onFollowToggle?.(newState);
    console.log(newState ? 'Followed' : 'Unfollowed', username);
  };

  return (
    <Card className="overflow-hidden">
      {coverImage && (
        <div className="h-32 sm:h-48 bg-muted overflow-hidden">
          <img
            src={coverImage}
            alt="Cover"
            className="w-full h-full object-cover"
          />
        </div>
      )}

      <CardContent className="p-6">
        <div className="flex flex-col sm:flex-row items-start gap-4">
          <Avatar className={`h-20 w-20 border-4 border-card ${coverImage ? '-mt-14' : ''}`}>
            <AvatarImage src={avatar} alt={name} />
            <AvatarFallback className="text-2xl">
              {name.split(' ').map(n => n[0]).join('')}
            </AvatarFallback>
          </Avatar>

          <div className="flex-1 min-w-0">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
              <div>
                <h2 className="font-serif text-2xl font-semibold" data-testid="text-user-name">
                  {name}
                </h2>
                <p className="text-muted-foreground" data-testid="text-username">
                  @{username}
                </p>
              </div>
              <Button
                variant={isFollowing ? "outline" : "default"}
                size="default"
                onClick={handleFollow}
                data-testid="button-follow"
              >
                {isFollowing ? (
                  <>
                    <UserCheck className="h-4 w-4 mr-2" />
                    Following
                  </>
                ) : (
                  <>
                    <UserPlus className="h-4 w-4 mr-2" />
                    Follow
                  </>
                )}
              </Button>
            </div>

            {bio && (
              <p className="text-sm text-foreground mb-4" data-testid="text-bio">
                {bio}
              </p>
            )}

            <div className="flex gap-6">
              <div>
                <span className="font-semibold" data-testid="text-followers-count">{followersCount}</span>
                <span className="text-muted-foreground text-sm ml-1">Followers</span>
              </div>
              <div>
                <span className="font-semibold" data-testid="text-following-count">{followingCount}</span>
                <span className="text-muted-foreground text-sm ml-1">Following</span>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
