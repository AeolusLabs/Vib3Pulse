import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { Notification, User } from "@shared/schema";

export type NotificationWithUser = Notification & { relatedUser: User | null };

interface NotificationsResponse {
  notifications: NotificationWithUser[];
}

interface UnreadCountResponse {
  count: number;
}

export function useNotifications(limit: number = 50) {
  return useQuery<NotificationWithUser[]>({
    queryKey: ["/api/notifications", { limit }],
    queryFn: async () => {
      const response = await fetch(`/api/notifications?limit=${limit}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch notifications");
      const data: NotificationsResponse = await response.json();
      return data.notifications;
    },
    staleTime: 30000,
  });
}

export function useUnreadNotificationCount() {
  return useQuery<number>({
    queryKey: ["/api/notifications/unread-count"],
    queryFn: async () => {
      const response = await fetch("/api/notifications/unread-count", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch unread count");
      const data: UnreadCountResponse = await response.json();
      return data.count;
    },
    staleTime: 15000,
    refetchInterval: 60000,
  });
}

export function useMarkNotificationAsRead() {
  return useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("POST", `/api/notifications/${id}/read`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications/unread-count"] });
    },
  });
}

export function useMarkAllNotificationsAsRead() {
  return useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/notifications/read-all");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications/unread-count"] });
    },
  });
}

export function useDeleteNotification() {
  return useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/notifications/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications/unread-count"] });
    },
  });
}

