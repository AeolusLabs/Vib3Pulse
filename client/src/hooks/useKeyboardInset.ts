import { useState, useEffect } from "react";

// Tracks how far the on-screen keyboard has pushed the visual viewport up, so
// a bottom-pinned composer can lift by the same amount instead of being
// covered by the keyboard. `active` gates the listeners — pass `open` for a
// sheet/dialog so nothing is wired up while it's closed.
export function useKeyboardInset(active: boolean = true): number {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const diff = window.innerHeight - (vv.height + vv.offsetTop);
      setOffset(Math.max(0, diff));
    };

    if (active) {
      vv.addEventListener("resize", update);
      vv.addEventListener("scroll", update);
      update();
    } else {
      setOffset(0);
    }

    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [active]);

  return offset;
}
