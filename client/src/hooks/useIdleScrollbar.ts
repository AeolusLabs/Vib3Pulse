import { useEffect, type RefObject } from "react";

const WAKE_EVENTS = ["wheel", "touchstart", "touchmove", "pointerdown", "keydown"] as const;

/**
 * Keeps a scroll container's scrollbar quiet. Sets `data-scrolling="true"` on the element when the reader touches it
 * (wheel, touchstart, touchmove, pointerdown, keydown) and back to "false" after `idleMs` without any of those.
 * Pair it with the `.scroll-fade` class, which hides the bar while the attribute is "false".
 * Programmatic scrolling (new chat lines) deliberately does not wake the bar.
 */
export function useIdleScrollbar(ref: RefObject<HTMLElement>, idleMs = 1200): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    el.dataset.scrolling = "false";
    const wake = () => {
      el.dataset.scrolling = "true";
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { el.dataset.scrolling = "false"; }, idleMs);
    };
    for (const ev of WAKE_EVENTS) el.addEventListener(ev, wake, { passive: true });
    return () => {
      if (timer) clearTimeout(timer);
      for (const ev of WAKE_EVENTS) el.removeEventListener(ev, wake);
    };
  }, [ref, idleMs]);
}
