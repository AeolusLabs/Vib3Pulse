import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SendIcon } from "@/components/ui/icons";
import { ROOM_LIMITS, ROOM_REACTIONS } from "@shared/rooms";
import type { ChatItem } from "@/lib/roomReducer";
import { SPRAY_COPY, systemChatText } from "@/lib/sprayUi";

interface ChatProps {
  chat: ChatItem[];
  nameOf: (userId: string) => string;
  onSend: (text: string) => void;
  muted: boolean;
  /** Fewer lines and no heading, for the fullscreen strip. */
  compact?: boolean;
  /** Ids the viewer muted locally. */
  hidden?: Set<string>;
  notice?: string | null;
}

export function RoomChat({ chat, nameOf, onSend, muted, compact, hidden, notice }: ChatProps) {
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lines = (hidden ? chat.filter((c) => !hidden.has(c.userId)) : chat).slice(compact ? -6 : -200);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || muted) return;
    onSend(t);
    setText("");
  };

  return (
    <div className={compact ? "space-y-2" : "space-y-2 rounded-2xl border p-3"} data-testid="room-chat">
      {!compact && <h2 className="text-sm font-semibold">Chat</h2>}
      <div
        ref={listRef}
        role="log"
        aria-live={compact ? "off" : "polite"} // the fullscreen strip repeats the main chat: announce it once, not twice
        aria-label="Room chat"
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}
        className={`${compact ? "max-h-24" : "h-48"} space-y-1 overflow-y-auto text-sm`}
        data-testid="chat-log"
      >
        {lines.length === 0 && <p className="text-muted-foreground">Say hi.</p>}
        {lines.map((c) => c.system ? (
          // A server-made line (spray receipt, or the payer-only refund line): never drawn as something a person typed.
          <p key={c.id} className="break-words rounded-lg bg-secondary/15 px-2 py-0.5 font-medium" data-testid="chat-system-line" data-system={c.system}>
            <span className="sr-only">{c.system === "spray_reversed" ? `${SPRAY_COPY.privateLine}. ` : "Spray. "}</span>
            {systemChatText(c.system, c.text, nameOf(c.userId))}
          </p>
        ) : (
          <p key={c.id} className="break-words"><span className="font-semibold">{nameOf(c.userId)}</span> <span>{c.text}</span></p>
        ))}
      </div>
      {notice && <p role="status" className="text-xs text-muted-foreground" data-testid="chat-notice">{notice}</p>}
      <form onSubmit={submit} className="flex gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, ROOM_LIMITS.chat))}
          maxLength={ROOM_LIMITS.chat}
          placeholder={muted ? "You're muted" : "Message the room"}
          disabled={muted}
          aria-label="Message"
          className="min-h-[44px] text-base"
          data-testid="input-chat"
        />
        <Button type="submit" size="icon" className="h-11 w-11 shrink-0" disabled={muted || !text.trim()} aria-label="Send message" data-testid="button-send-chat"><SendIcon className="h-4 w-4" /></Button>
      </form>
      {!compact && text.length > ROOM_LIMITS.chat - 40 && <p className="text-right text-xs text-muted-foreground">{text.length}/{ROOM_LIMITS.chat}</p>}
    </div>
  );
}

export function ReactionBar({ onReact, className = "" }: { onReact: (emoji: string) => void; className?: string }) {
  return (
    <div className={`flex flex-wrap gap-1 ${className}`} role="group" aria-label="React to the room" data-testid="reaction-bar">
      {ROOM_REACTIONS.map((e) => (
        <button key={e} type="button" onClick={() => onReact(e)} className="flex h-11 w-11 items-center justify-center rounded-full border bg-background/80 text-xl transition-transform active:scale-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" aria-label={`React with ${e}`} data-testid={`react-${e}`}>{e}</button>
      ))}
    </div>
  );
}
