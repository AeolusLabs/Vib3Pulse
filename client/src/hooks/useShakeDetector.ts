import { useCallback, useEffect, useRef, useState } from "react";

export type MotionPermission = "unknown" | "granted" | "denied";

const OPT_IN_KEY = "vibepulse_shake_sos_enabled";

function readOptIn(): boolean {
  try {
    return localStorage.getItem(OPT_IN_KEY) === "true";
  } catch {
    return false;
  }
}

function writeOptIn(value: boolean) {
  try {
    if (value) localStorage.setItem(OPT_IN_KEY, "true");
    else localStorage.removeItem(OPT_IN_KEY);
  } catch {
    // ignore
  }
}

// Manages the user's shake-to-SOS opt-in + the iOS-required permission gesture.
// Separate from the detection hook below so the settings UI doesn't need to
// also run the devicemotion listener.
export function useShakeOptIn() {
  const isSupported = typeof window !== "undefined" && "DeviceMotionEvent" in window;
  const [optedIn, setOptedInState] = useState(readOptIn);
  const [permission, setPermission] = useState<MotionPermission>("unknown");

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!isSupported) return false;
    const DME = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<"granted" | "denied"> };
    if (typeof DME.requestPermission === "function") {
      try {
        const result = await DME.requestPermission();
        setPermission(result);
        if (result === "granted") {
          writeOptIn(true);
          setOptedInState(true);
          return true;
        }
        return false;
      } catch {
        setPermission("denied");
        return false;
      }
    }
    // Android / browsers without the permission gate — no prompt needed
    setPermission("granted");
    writeOptIn(true);
    setOptedInState(true);
    return true;
  }, [isSupported]);

  const disable = useCallback(() => {
    writeOptIn(false);
    setOptedInState(false);
  }, []);

  return { isSupported, optedIn, permission, requestPermission, disable };
}

// Pure gesture detector — physical "was this shaken hard enough" primitive
// only. Gating (opted-in? confirmed buddy? night mode active?) is the
// caller's responsibility, passed in as `enabled`.
export function useShakeDetector({ enabled, onTrigger }: { enabled: boolean; onTrigger: () => void }) {
  const spikeTimestamps = useRef<number[]>([]);
  const cooldownUntil = useRef(0);

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || !("DeviceMotionEvent" in window)) return;

    const THRESHOLD = 25; // m/s^2, per PRD
    const WINDOW_MS = 1500;
    const REQUIRED_SPIKES = 3;
    const COOLDOWN_MS = 5000;

    const handler = (event: DeviceMotionEvent) => {
      const now = Date.now();
      if (now < cooldownUntil.current) return;

      const acc = event.acceleration;
      if (!acc) return;
      const magnitudeExceeded =
        Math.abs(acc.x ?? 0) > THRESHOLD ||
        Math.abs(acc.y ?? 0) > THRESHOLD ||
        Math.abs(acc.z ?? 0) > THRESHOLD;
      if (!magnitudeExceeded) return;

      spikeTimestamps.current = spikeTimestamps.current.filter((t) => now - t < WINDOW_MS);
      spikeTimestamps.current.push(now);

      if (spikeTimestamps.current.length >= REQUIRED_SPIKES) {
        spikeTimestamps.current = [];
        cooldownUntil.current = now + COOLDOWN_MS;
        onTrigger();
      }
    };

    window.addEventListener("devicemotion", handler);
    return () => window.removeEventListener("devicemotion", handler);
  }, [enabled, onTrigger]);
}
