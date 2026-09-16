import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type AlertStatus = "active" | "safe" | "false_alarm";

const ALERTS_KEY = ["/api/safety/alerts"];
const WATCHING_KEY = ["/api/safety/watching-over"];

// Both DistressAlertsPage (a flat { alerts: [] } list) and BuddyDashboardPage
// (alerts nested under { watching: [{ recentAlerts: [] }] }) show the same
// underlying safety_alerts rows and need the same optimistic patch on
// resolve/false-alarm — this is the one place that knows both shapes.
function patchAlertStatus(alertId: string, status: AlertStatus) {
  const resolvedAt = new Date().toISOString();

  queryClient.setQueryData<{ alerts: any[] } | undefined>(ALERTS_KEY, (old) => {
    if (!old) return old;
    return {
      ...old,
      alerts: old.alerts.map((a) => (a.id === alertId ? { ...a, status, resolvedAt } : a)),
    };
  });

  queryClient.setQueryData<{ watching: any[] } | undefined>(WATCHING_KEY, (old) => {
    if (!old) return old;
    return {
      ...old,
      watching: old.watching.map((w) => ({
        ...w,
        recentAlerts: w.recentAlerts.map((a: any) =>
          a.id === alertId ? { ...a, status, resolvedAt } : a
        ),
      })),
    };
  });
}

// Resolving an alert used to only update the button's disabled state while
// the request was in flight — the card itself (Active badge, action buttons)
// stayed on screen until the post-mutation invalidateQueries refetch came
// back, which reads as "nothing happened" for however long that round trip
// takes. This patches both queries' cache immediately on click and rolls
// back only if the request actually fails, so the UI reflects the choice the
// instant it's made instead of waiting on the network.
export function useSafetyAlertActions() {
  const { toast } = useToast();

  const resolveMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/safety/alerts/${id}/resolve`),
    onMutate: async (id: string) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ALERTS_KEY }),
        queryClient.cancelQueries({ queryKey: WATCHING_KEY }),
      ]);
      const previousAlerts = queryClient.getQueryData(ALERTS_KEY);
      const previousWatching = queryClient.getQueryData(WATCHING_KEY);
      patchAlertStatus(id, "safe");
      return { previousAlerts, previousWatching };
    },
    onSuccess: () => {
      toast({ title: "Marked as safe" });
    },
    onError: (e: any, _id, context) => {
      if (context) {
        queryClient.setQueryData(ALERTS_KEY, context.previousAlerts);
        queryClient.setQueryData(WATCHING_KEY, context.previousWatching);
      }
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ALERTS_KEY });
      queryClient.invalidateQueries({ queryKey: WATCHING_KEY });
    },
  });

  const falseAlarmMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/safety/alerts/${id}/false-alarm`),
    onMutate: async (id: string) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ALERTS_KEY }),
        queryClient.cancelQueries({ queryKey: WATCHING_KEY }),
      ]);
      const previousAlerts = queryClient.getQueryData(ALERTS_KEY);
      const previousWatching = queryClient.getQueryData(WATCHING_KEY);
      patchAlertStatus(id, "false_alarm");
      return { previousAlerts, previousWatching };
    },
    onSuccess: () => {
      toast({ title: "Marked as false alarm" });
    },
    onError: (e: any, _id, context) => {
      if (context) {
        queryClient.setQueryData(ALERTS_KEY, context.previousAlerts);
        queryClient.setQueryData(WATCHING_KEY, context.previousWatching);
      }
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ALERTS_KEY });
      queryClient.invalidateQueries({ queryKey: WATCHING_KEY });
    },
  });

  return { resolveMutation, falseAlarmMutation };
}
