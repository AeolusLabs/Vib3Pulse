import { useEffect, useRef } from "react";

export interface ReactionTrayProps {
  emojis: readonly string[];
  onPick(e: string): void;
  open: boolean;
  onClose(): void;
}

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const ITEM = '[role="menuitem"]';
const HEART = '[data-testid="dock-heart"]';

interface Containing { contains(other: Node | null): boolean }
/**
 * What a pointerdown anywhere on the page means while the tray is open. Inside the tray: a pick (handled by the item).
 * On the heart: the heart's own click toggles the tray, so closing here would close and re-open it. Anywhere else: close.
 */
export function trayOutsideTap(target: Node | null, tray: Containing | null, heart: Containing | null): "ignore" | "close" {
  if (!target) return "ignore";
  if (tray?.contains(target)) return "ignore";
  if (heart?.contains(target)) return "ignore";
  return "close";
}

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
    // Anchored on the heart itself, never on document.activeElement: iPhone Safari does not focus a tapped button, so the
    // active element can be <body> (which contains every target) or the composer (whose tap would close, then re-open).
    const heart = () => document.querySelector<HTMLElement>(HEART);
    const back = () => heart()?.focus();
    root.current?.querySelector<HTMLElement>(ITEM)?.focus();
    const outside = (ev: PointerEvent) => {
      if (trayOutsideTap(ev.target as Node | null, root.current, heart()) === "close") onCloseRef.current();
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
