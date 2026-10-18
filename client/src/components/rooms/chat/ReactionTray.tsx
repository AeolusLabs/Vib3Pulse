import { useEffect, useRef } from "react";

export interface ReactionTrayProps {
  emojis: readonly string[];
  onPick(e: string): void;
  open: boolean;
  onClose(): void;
}

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const ITEM = '[role="menuitem"]';

/**
 * The immersive reaction tray. A menu that scales in from the heart button (bottom right), closes after a pick, on Escape
 * and on an outside tap, and hands focus back to the button that opened it. Render it inside the dock (relative container).
 */
export function ReactionTray({ emojis, onPick, open, onClose }: ReactionTrayProps) {
  const root = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    // Some touch browsers don't focus a tapped button, so fall back to the dock heart.
    const back = () => {
      const target = opener && opener !== document.body && opener.isConnected ? opener : document.querySelector<HTMLElement>('[data-testid="dock-heart"]');
      target?.focus();
    };
    root.current?.querySelector<HTMLElement>(ITEM)?.focus();
    const outside = (ev: PointerEvent) => {
      const t = ev.target as Node | null;
      if (!t || root.current?.contains(t)) return;
      if (opener && opener.contains(t)) return; // the heart toggles the tray itself
      onCloseRef.current();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => { document.removeEventListener("pointerdown", outside, true); back(); };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key === "Tab") { e.preventDefault(); onClose(); return; }
    const list = Array.from(root.current?.querySelectorAll<HTMLElement>(ITEM) ?? []);
    const at = list.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (at + 1) % list.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (at - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    if (next >= 0) { e.preventDefault(); list[next]?.focus(); }
  };

  return (
    <div
      ref={root}
      role="menu"
      aria-label="React to the room"
      onKeyDown={onKeyDown}
      className="room-tray-in absolute bottom-[calc(100%-4px)] right-3 z-20 grid grid-cols-4 gap-1 rounded-2xl border border-white/10 bg-black/80 p-1.5 shadow-xl backdrop-blur"
      style={{ transformOrigin: "bottom right" }}
      data-testid="reaction-tray"
    >
      {emojis.map((e) => (
        <button
          key={e}
          type="button"
          role="menuitem"
          aria-label={`React with ${e}`}
          onClick={() => { onPick(e); onClose(); }}
          className={`grid h-12 w-12 place-items-center rounded-xl text-2xl motion-safe:transition-transform motion-safe:active:scale-95 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-white/15 ${FOCUS}`}
          data-testid={`tray-${e}`}
        >
          <span aria-hidden="true">{e}</span>
        </button>
      ))}
    </div>
  );
}

export default ReactionTray;
