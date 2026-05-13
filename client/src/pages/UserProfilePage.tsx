import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Skeleton } from "@/components/ui/skeleton";
import type { User } from "@shared/schema";

export default function UserProfilePage() {
  const { userId } = useParams<{ userId: string }>();
  const [, navigate] = useLocation();

  const { data: user, isLoading, error } = useQuery<{ user: User }>({
    queryKey: [`/api/users/${userId}/profile`],
    enabled: !!userId,
  });

  useEffect(() => {
    if (user?.user?.username) {
      navigate(`/profile/${user.user.username}`, { replace: true });
    }
  }, [user, navigate]);

  if (error) {
    return (
      <div className="min-h-screen bg-background pb-20 md:pb-0">
        <Navigation onSearch={() => {}} />
        <main className="max-w-[1200px] mx-auto px-4 py-8 text-center text-muted-foreground">
          User not found
        </main>
        <BottomNavigation />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation onSearch={() => {}} />
      <main className="max-w-[1200px] mx-auto px-4 py-8 space-y-4">
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </main>
      <BottomNavigation />
    </div>
  );
}
