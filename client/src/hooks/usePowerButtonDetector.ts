import { useCallback, useEffect, useRef, useState } from "react";

const OPT_IN_KEY = "vibepulse_power_button_sos_enabled";

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

// Off by default per the PRD (high false-positive risk — pulling the
// notification drawer, screen timeout). Client-only opt-in, no server sync:
// low-stakes preference, consistent with other client-only toggles in this
// codebase (e.g. useGeolocation's cache).
export function usePowerButtonOptIn() {
  const [optedIn, setOptedInState] = useState(readOptIn);

  const setOptedIn = useCallback((value: boolean) => {
    writeOptIn(value);
    setOptedInState(value);
  }, []);

  return { optedIn, setOptedIn };
}

// Detects 5 rapid hidden→visible cycles within 4 seconds (screen off/on via
// the power button shows up as document.visibilityState toggling).
export function usePowerButtonDetector({ enabled, onTrigger }: { enabled: boolean; onTrigger: () => void }) {
  const cycleTimestamps = useRef<number[]>([]);
  const wasHidden = useRef(false);
  const cooldownUntil = useRef(0);

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;

    const WINDOW_MS = 4000;
    const REQUIRED_CYCLES = 5;
    const COOLDOWN_MS = 5000;

    const handler = () => {
      const now = Date.now();
      if (now < cooldownUntil.current) return;

      if (document.visibilityState === "hidden") {
        wasHidden.current = true;
        return;
      }
      // visible again, and we previously saw it go hidden — that's one cycle
      if (!wasHidden.current) return;
      wasHidden.current = false;

      cycleTimestamps.current = cycleTimestamps.current.filter((t) => now - t < WINDOW_MS);
      cycleTimestamps.current.push(now);

      if (cycleTimestamps.current.length >= REQUIRED_CYCLES) {
        cycleTimestamps.current = [];
        cooldownUntil.current = now + COOLDOWN_MS;
        onTrigger();
      }
    };

    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [enabled, onTrigger]);
}
