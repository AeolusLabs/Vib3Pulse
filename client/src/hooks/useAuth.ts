import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";

export type AuthUser = {
  id: string;
  username: string;
  email: string;
  userType: string;
  displayName?: string | null;
  organizationName?: string | null;
  gender?: string | null;
  genderEditedAt?: Date | null;
  canManageVenues?: boolean | null;
  isVerified?: boolean | null;
  isOfficial?: boolean | null;
  avatarUrl?: string | null;
};

type AuthResponse = {
  user: AuthUser;
};

export function useAuth(): UseQueryResult<AuthUser | null, Error> {
  return useQuery<AuthUser | null, Error>({
    queryKey: ["/api/auth/session"],
    queryFn: async () => {
      const response = await fetch("/api/auth/session", {
        credentials: "include",
      });

      if (response.status === 403) {
        const body = await response.json().catch(() => ({}));
        if (body.suspended) {
          throw new Error("ACCOUNT_SUSPENDED");
        }
      }

      if (!response.ok) {
        return null;
      }

      const data: AuthResponse = await response.json();
      return data.user;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

export async function logout() {
  await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "include",
  });
  
  // Clear all user-specific cached data to prevent cross-user data leakage
  queryClient.clear();
  queryClient.setQueryData(["/api/auth/session"], null);
}
