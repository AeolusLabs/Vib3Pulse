import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDownIcon, HeartIcon, ReplyIcon } from "@/components/ui/icons";
import { useIdleScrollbar } from "@/hooks/useIdleScrollbar";
import { canQuote, quoteView, replyProgress, swipeDecision } from "@/lib/chatReply";
import type { ChatItem } from "@/lib/roomReducer";

/**
 * Props for the room chat log.
 * - `chat`: lines from the room reducer (already capped there).
 * - `nameOf`: display name for a userId; return "" for someone who left and the quote shows "Someone".
 * - `selfId`: the viewer's userId, or null. Own lines get no Wave action.
 * - `hidden`: userIds the viewer muted locally; their lines are not rendered.
 * - `immersive`: the log sits over the picture. Rows get a dark translucent panel (the scrim that keeps the text readable).
 *   It stays a polite live region: the room page renders one chat log in every view, so it is the one that announces.
 * - `onReply` / `onHeart`: the viewer chose that line (swipe right 56 px or more, or the action row).
 * - `onWave` / `onPickAuthor`: addressed by userId, never by name.
 * The component fills its parent (`h-full`); the parent decides the height.
 */
export interface ChatLogProps {
  chat: ChatItem[];
  nameOf(userId: string): string;
  selfId: string | null;
  hidden?: Set<string>;
  immersive?: boolean;
  onReply(item: ChatItem): void;
  onHeart(item: ChatItem): void;
  onWave(userId: string): void;
  onPickAuthor(userId: string): void;
}

const STICK_PX = 48;

interface RowProps {
  item: ChatItem;
  name: string;
  quoteName: string | null; // primitives, so memo still skips untouched rows
  quoteText: string;
  mine: boolean;
  open: boolean;
  immersive: boolean;
  /** Still in the server's quote window (the newest 50 lines): older lines offer no Reply and ignore the swipe. */
  canReply: boolean;
  onToggle(id: string): void;
  onReply(item: ChatItem): void;
  onHeart(item: ChatItem): void;
  onWave(userId: string): void;
  onPickAuthor(userId: string): void;
}

const ChatRow = memo(function ChatRow({ item, name, quoteName, quoteText, mine, open, immersive, canReply, onToggle, onReply, onHeart, onWave, onPickAuthor }: RowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ x: number; y: number; active: boolean; dx: number; id: number } | null>(null);
  const swiped = useRef(false);

  const paint = (offset: number, reveal: number, dragging: boolean) => {
    const row = rowRef.current, hint = hintRef.current;
    if (row) { row.style.transform = offset ? `translateX(${offset}px)` : ""; row.style.transition = dragging ? "none" : ""; }
    if (hint) hint.style.opacity = reveal ? String(reveal) : "";
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, active: false, dx: 0, id: e.pointerId };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    const step = swipeDecision({ active: d.active, dx, dy, pointerType: e.pointerType, buttons: e.buttons });
    if (step === "cancel") { // a mouse moving over the row with no button held: the press ended elsewhere
      drag.current = null;
      if (d.active) paint(0, 0, false);
      return;
    }
    if (step === "wait") return;
    if (step === "start") {
      d.active = true;
      try { rowRef.current?.setPointerCapture(d.id); } catch { /* pointer already gone */ }
    }
    d.dx = dx;
    const p = replyProgress(dx);
    paint(p.offset, p.reveal, true);
  };
  const finish = (cancelled: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.active) return;
    swiped.current = true; // the click that follows the release must not toggle the action row
    setTimeout(() => { swiped.current = false; }, 80);
    paint(0, 0, false);
    if (!cancelled && canReply && replyProgress(d.dx).commit) onReply(item);
  };

  const onClickCapture = (e: React.MouseEvent) => {
    if (swiped.current) { swiped.current = false; e.preventDefault(); e.stopPropagation(); }
  };
  const toggle = () => onToggle(item.id);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(); }
  };
  const pick = (e: React.MouseEvent) => { e.stopPropagation(); onPickAuthor(item.userId); };
  const act = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); onToggle(item.id); };

  useEffect(() => { if (open) rowRef.current?.scrollIntoView?.({ block: "nearest" }); }, [open]);

  const initial = (name.trim()[0] ?? "?").toUpperCase();
  const who = mine ? "You" : name;
  return (
    <div className="relative" data-testid="chat-row">
      <span ref={hintRef} aria-hidden="true" className="pointer-events-none absolute left-1 top-1/2 -translate-y-1/2 text-primary opacity-0">
        <ReplyIcon size={18} />
      </span>
      <div
        ref={rowRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => finish(false)}
        onPointerCancel={() => finish(true)}
        onPointerLeave={() => { if (drag.current && !drag.current.active) drag.current = null; }}
        onLostPointerCapture={() => finish(true)}
        onClickCapture={onClickCapture}
        onClick={toggle}
        style={{ touchAction: "pan-y" }}
        className={`flex min-w-0 items-start gap-2 rounded-xl px-2 py-1.5 transition-transform duration-150 motion-reduce:transition-none ${
          immersive ? "bg-black/35 text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.6)]" : open ? "bg-muted/60" : ""
        }`}
      >
        <button
          type="button"
          tabIndex={-1}
          onClick={pick}
          aria-label={`Open profile card for ${who}`}
          className="-m-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        >
          <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/20 text-sm font-semibold text-primary">{initial}</span>
        </button>
        <div className="min-w-0 flex-1">
          <button type="button" onClick={pick} className={`max-w-full truncate text-left text-[13px] font-semibold leading-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${mine ? "text-primary" : ""}`}>
            {who}
          </button>
          {item.replyTo && (
            <div className={`mb-0.5 truncate rounded-lg px-2 py-0.5 text-[13px] ${immersive ? "bg-white/15" : "bg-muted text-muted-foreground"}`} data-testid="chat-quote">
              <span className="font-medium">{quoteName}</span> {quoteText}
            </div>
          )}
          <p
            role="button"
            tabIndex={0}
            aria-expanded={open}
            onKeyDown={onKeyDown}
            className="whitespace-pre-wrap rounded text-[15px] leading-snug [overflow-wrap:anywhere] focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          >{item.text}</p>
          {open && (
            <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="Message actions" aria-live="off">
              <ActionButton onClick={act(() => onHeart(item))}><HeartIcon size={16} /> Heart</ActionButton>
              {canReply && <ActionButton onClick={act(() => onReply(item))}><ReplyIcon size={16} /> Reply</ActionButton>}
              {!mine && <ActionButton onClick={act(() => onWave(item.userId))}><span aria-hidden="true">👋</span> Wave</ActionButton>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

function ActionButton({ onClick, children }: { onClick: (e: React.MouseEvent) => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-full border bg-background/90 px-3.5 text-sm font-medium text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary [@media(hover:hover)_and_(pointer:fine)]:hover:border-primary [@media(hover:hover)_and_(pointer:fine)]:hover:text-primary"
    >
      {children}
    </button>
  );
}

export function ChatLog({ chat, nameOf, selfId, hidden, immersive = false, onReply, onHeart, onWave, onPickAuthor }: ChatLogProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastSeen = useRef<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  useIdleScrollbar(listRef);

  const lines = hidden && hidden.size ? chat.filter((c) => !hidden.has(c.userId)) : chat;
  const lastId = lines.length ? lines[lines.length - 1].id : null;
  const position = new Map(chat.map((c, i) => [c.id, i]));

  // New lines since the reader last had the bottom in view. If that line aged out of the capped list, all of them count.
  let unseen = 0;
  if (!atBottom && lastId) {
    const at = lastSeen.current ? lines.findIndex((c) => c.id === lastSeen.current) : -1;
    unseen = at === -1 ? lines.length : lines.length - 1 - at;
  }

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) { el.scrollTop = el.scrollHeight; lastSeen.current = lastId; }
  }, [lastId]);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
    stick.current = near;
    if (near) lastSeen.current = lastId;
    setAtBottom(near);
  }, [lastId]);

  const jump = () => {
    const el = listRef.current;
    if (!el) return;
    stick.current = true;
    lastSeen.current = lastId;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  // Drop the open action row if its line is gone (capped out, or its author was muted).
  useEffect(() => { if (openId && !lines.some((c) => c.id === openId)) setOpenId(null); }, [lines, openId]);
  const toggle = useCallback((id: string) => setOpenId((cur) => (cur === id ? null : id)), []);

  return (
    <div className="relative h-full min-h-0 min-w-0" data-testid="chat-log-wrap">
      <div
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-label="Room chat"
        data-scrolling="false"
        onScroll={onScroll}
        className="scroll-fade h-full min-w-0 space-y-1 overflow-y-auto overflow-x-hidden overscroll-contain px-1 py-1 text-sm"
        data-testid="chat-log"
      >
        {lines.length === 0 && <p className={immersive ? "px-2 text-white/80" : "px-2 text-muted-foreground"}>Say hi.</p>}
        {lines.map((c) => (
          <ChatRow
            key={c.id}
            item={c}
            name={nameOf(c.userId)}
            quoteName={c.replyTo ? quoteView(c.replyTo, hidden, nameOf).name : null}
            quoteText={c.replyTo ? quoteView(c.replyTo, hidden, nameOf).text : ""}
            mine={c.userId === selfId}
            open={openId === c.id}
            canReply={canQuote(position.get(c.id) ?? -1, chat.length)}
            immersive={immersive}
            onToggle={toggle}
            onReply={onReply}
            onHeart={onHeart}
            onWave={onWave}
            onPickAuthor={onPickAuthor}
          />
        ))}
      </div>
      {!atBottom && unseen > 0 && (
        <button
          type="button"
          onClick={jump}
          className="absolute bottom-2 left-1/2 inline-flex min-h-11 -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          data-testid="chat-new-pill"
        >
          <ChevronDownIcon size={16} />
          {unseen === 1 ? "1 new message" : `${unseen > 99 ? "99+" : unseen} new messages`}
        </button>
      )}
    </div>
  );
}
