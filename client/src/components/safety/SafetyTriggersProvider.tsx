import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { useNightMode } from "@/hooks/useNightMode";
import { useShakeOptIn, useShakeDetector } from "@/hooks/useShakeDetector";
import { usePowerButtonOptIn, usePowerButtonDetector } from "@/hooks/usePowerButtonDetector";
import { useSilentSOSTrigger, postOrQueueSOS } from "@/hooks/useTriggerSOS";
import { flushQueue, type QueuedSOSPayload } from "@/lib/sosQueue";
import { flushInviteQueue, type QueuedInvitePayload } from "@/lib/buddyInviteQueue";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";

interface Buddy { confirmationStatus: string }

// Mounted once, globally (see App.tsx) — wires up the silent SOS triggers
// (shake, power-button pattern) and flushes the offline queue when the app
// comes back online or the service worker reports a successful background
// flush. Renders nothing.
export function SafetyTriggersProvider() {
  const { data: user } = useAuth();
  const { toast } = useToast();
  const night = useNightMode();
  const shake = useShakeOptIn();
  const powerButton = usePowerButtonOptIn();
  const fireSilentSOS = useSilentSOSTrigger();

  const { data: buddiesData } = useQuery<{ buddies: Buddy[] }>({
    queryKey: ["/api/safety/buddies"],
    enabled: !!user && user.userType === "social",
  });
  const hasConfirmedBuddy = (buddiesData?.buddies ?? []).some((b) => b.confirmationStatus === "confirmed");

  const isSocialUser = user?.userType === "social";

  useShakeDetector({
    enabled: isSocialUser && shake.optedIn && hasConfirmedBuddy && night.isActive,
    onTrigger: fireSilentSOS,
  });

  usePowerButtonDetector({
    enabled: isSocialUser && powerButton.optedIn && hasConfirmedBuddy && night.isActive,
    onTrigger: fireSilentSOS,
  });

  const flushing = useRef(false);
  useEffect(() => {
    const flush = async () => {
      if (flushing.current) return;
      flushing.current = true;
      try {
        const count = await flushQueue(async (payload: QueuedSOSPayload) => {
          const result = await postOrQueueSOS(payload);
          return !result.queued;
        });
        if (count > 0) {
          toast({ title: "SOS sent", description: `${count} queued alert${count === 1 ? "" : "s"} just went through.` });
        }

        const inviteCount = await flushInviteQueue(async (payload: QueuedInvitePayload) => {
          try {
            await apiRequest("POST", "/api/safety/buddy-assignment", payload);
            return true;
          } catch {
            return false;
          }
        });
        if (inviteCount > 0) {
          queryClient.invalidateQueries({ queryKey: ["/api/safety/buddies"] });
          toast({ title: "Buddy invite sent", description: `${inviteCount} queued invite${inviteCount === 1 ? "" : "s"} just went out.` });
        }
      } finally {
        flushing.current = false;
      }
    };

    window.addEventListener("online", flush);
    // Catch up on mount too, in case we loaded already-online with a stale queue
    flush();

    const onSwMessage = (event: MessageEvent) => {
      if (event.data?.type === "sos-flushed") {
        window.dispatchEvent(new CustomEvent("sos-flushed", { detail: event.data }));
        toast({ title: "SOS sent", description: "A queued alert just went through." });
      }
    };
    navigator.serviceWorker?.addEventListener?.("message", onSwMessage);

    return () => {
      window.removeEventListener("online", flush);
      navigator.serviceWorker?.removeEventListener?.("message", onSwMessage);
    };
  }, [toast]);

  return null;
}
