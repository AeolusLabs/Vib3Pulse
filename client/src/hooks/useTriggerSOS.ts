import { useCallback } from "react";
import { apiRequest } from "@/lib/queryClient";
import { queueSOS, type QueuedSOSPayload } from "@/lib/sosQueue";

export interface SosResponse {
  message: string;
  alertIds: string[];
  buddiesNotified: number;
}

// Shared by the hold-to-trigger button (EmergencyFAB) and the silent triggers
// (shake, power-button pattern). POSTs the SOS; on a genuine network-level
// failure (fetch couldn't even complete — `fetch` throws a TypeError in that
// case, distinct from the Error thrown for a non-2xx response) it queues the
// payload in IndexedDB instead of failing outright. A 4xx/5xx server
// response is NOT queued — that's a real rejection (e.g. no confirmed buddy),
// not a connectivity problem, and should surface as today.
export async function postOrQueueSOS(payload: QueuedSOSPayload): Promise<{ queued: boolean; data?: SosResponse }> {
  try {
    const res = await apiRequest("POST", "/api/safety/sos", payload);
    const data = (await res.json()) as SosResponse;
    return { queued: false, data };
  } catch (err) {
    if (err instanceof TypeError) {
      await queueSOS(payload);
      void navigator.serviceWorker?.ready
        .then((reg) => (reg as ServiceWorkerRegistration & { sync?: { register: (tag: string) => Promise<void> } }).sync?.register("sos-queue"))
        .catch(() => {});
      return { queued: true };
    }
    throw err;
  }
}

function getBestEffortLocation(): Promise<{ latitude: number; longitude: number; accuracy: number | null } | null> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 5_000, maximumAge: 30_000 }
    );
  });
}

// Used by silent triggers (shake, power-button) which have no dialog to
// request location from first — best-effort fix, sends without one if it
// can't get a fix quickly.
export function useSilentSOSTrigger() {
  return useCallback(async (): Promise<void> => {
    const location = await getBestEffortLocation();
    await postOrQueueSOS({
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
      locationText: null,
      accuracy: location?.accuracy ?? null,
    });
    if ("vibrate" in navigator) navigator.vibrate(200); // single confirm buzz, per PRD — no sound, no visual change
  }, []);
}
