import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/hooks/use-toast";
import { defaultVideoView, type VideoView } from "@/lib/roomLayout";
import { chromeHiddenFor, effectiveView, resizeStep, shouldShowImmersiveHint } from "@/lib/videoViewState";

const width = () => (typeof window === "undefined" ? 1280 : window.innerWidth);
const store = () => { try { return window.localStorage; } catch { return null; } };
let hintedThisVisit = false; // blocked storage would otherwise show the hint on every room

/**
 * Which live video view to show. Starts at the width's default (immersive under 1024 px), keeps a user's choice
 * across resizes on the same side of the 1024 line, and resets when the line is crossed. Desktop is always compact.
 * `chromeHidden` (tap the picture to hide controls) only means something in immersive while live.
 */
export function useVideoView(isLive: boolean): { view: VideoView; setView(v: VideoView): void; chromeHidden: boolean; toggleChrome(): void; showChrome(): void; canImmerse: boolean } {
  const [w, setW] = useState(width);
  const [pick, setPick] = useState(() => ({ view: defaultVideoView(width()), userChose: false }));
  const [hidden, setHidden] = useState(false);
  const lastW = useRef(w);

  useEffect(() => {
    const onResize = () => {
      const before = lastW.current, after = width();
      if (before === after) return;
      lastW.current = after;
      setPick((cur) => resizeStep(cur, before, after));
      setW(after);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const view = effectiveView(pick.view, w);

  // Controls come back whenever the view changes or the live picture ends.
  useEffect(() => { setHidden(false); }, [view, isLive]);

  // First time per browser in immersive: say how to hide the controls.
  useEffect(() => {
    if (!isLive || view !== "immersive" || hintedThisVisit) return;
    hintedThisVisit = true;
    if (shouldShowImmersiveHint(store())) toast({ description: "Tap the picture to hide controls" });
  }, [isLive, view]);

  const setView = useCallback((v: VideoView) => setPick({ view: v, userChose: true }), []);
  const toggleChrome = useCallback(() => setHidden((h) => !h), []);
  const showChrome = useCallback(() => setHidden(false), []);

  return { view, setView, chromeHidden: chromeHiddenFor(view, isLive, hidden), toggleChrome, showChrome, canImmerse: effectiveView("immersive", w) === "immersive" };
}
