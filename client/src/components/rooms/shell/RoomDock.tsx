import { useEffect, useRef, useState, type ReactNode } from "react";
import { CameraIcon, HeartIcon, MicIcon, SendIcon, XIcon } from "@/components/ui/icons";
import { useToast } from "@/hooks/use-toast";
import { ROOM_LIMITS } from "@shared/rooms";
import { DOCK_REACTIONS } from "@/lib/roomShell";

export interface DockVoice {
  /** You have your hand up (asking for the mic). */
  hasHand: boolean;
  /** You may ask for the mic (a guest in a room with voice on). */
  canAsk: boolean;
  onRaise(): void;
  onLower(): void;
  /** Why the mic can't be used right now; the button shows as disabled and a tap explains why. */
  muteLocked?: string;
  /** You already have the mic (host, co-host, guest on stage): the button mutes and unmutes it instead of raising a hand. */
  mic?: { on: boolean; onToggle(): void };
}

export interface DockCam {
  /** Live video is on in this room. */
  visible: boolean;
  /** You asked to go live, or you are live. */
  pressed: boolean;
  onClick(): void;
  /** Why the camera can't be used right now; shown as a toast on tap. */
  lockedReason?: string;
  /** Accessible name; defaults to "Go live on camera". */
  label?: string;
}

export interface RoomDockProps {
  /** A host muted you in chat. */
  muted: boolean;
  /** The message you are replying to. `userId` is a RoomMemberView userId, never a username. */
  reply: { userId: string; text: string } | null;
  /** Display name for the reply chip (the page remembers names of people who left). Defaults to "Someone". */
  replyName?: string;
  onCancelReply(): void;
  onSend(text: string): void;
  onReact(emoji: string): void;
  /** Immersive only: the reaction tray (task 1.4) is open. */
  trayOpen: boolean;
  onToggleTray(): void;
  voice: DockVoice;
  cam: DockCam;
  immersive: boolean;
  /** Seconds between your messages when the host turned on slow mode (phase 3). */
  slowModeSec?: number;
  /** Wave at the room. The row shows a Wave button only when this is given (there is no room-wide wave on the server yet). */
  onWave?: () => void;
  /** Task 1.4: the 4 px hype bar above the composer. */
  hype?: ReactNode;
  /** Task 1.4: the reaction tray, positioned by its own component (it scales in from the heart button). */
  tray?: ReactNode;
}

const HOVER = "[@media(hover:hover)_and_(pointer:fine)]:hover:border-primary";
const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const PRESS = "motion-safe:transition-transform motion-safe:active:scale-[0.97]";

/** Bottom of the room: reply chip, reactions, mic, camera, the composer and send. Sits above the safe-area inset. */
export default function RoomDock({ muted, reply, replyName, onCancelReply, onSend, onReact, trayOpen, onToggleTray, voice, cam, immersive, slowModeSec, onWave, hype, tray }: RoomDockProps) {
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [waitUntil, setWaitUntil] = useState(0);
  const [, rerender] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // Slow mode: tick once a second while you have to wait, so the countdown and the send button update.
  const waitLeft = Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000));
  useEffect(() => {
    if (!waitLeft) return;
    const t = setTimeout(() => rerender((n) => n + 1), 1000);
    return () => clearTimeout(t);
  });
  // A new reply target: put the caret in the composer.
  useEffect(() => { if (reply) input.current?.focus(); }, [reply]);

  const trimmed = text.trim();
  const canSend = !!trimmed && !muted && waitLeft === 0;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    onSend(trimmed);
    setText("");
    if (slowModeSec && slowModeSec > 0) setWaitUntil(Date.now() + slowModeSec * 1000);
  };

  const rb = "grid h-12 w-12 shrink-0 place-items-center rounded-full border";
  const rbIdle = immersive ? "border-transparent bg-white/15 text-white" : "border-border bg-muted text-foreground";
  const rbOn = "border-primary bg-primary text-primary-foreground";
  const locked = (reason: string) => toast({ title: reason });

  const micBtn = (() => {
    if (immersive) return null;
    const { mic, canAsk, hasHand, muteLocked } = voice;
    if (!mic && !canAsk && !muteLocked) return null;
    const pressed = mic ? mic.on : hasHand;
    const label = muteLocked ? "Microphone" : mic ? (mic.on ? "Mute mic" : "Turn on mic") : hasHand ? "Lower hand" : "Ask to speak";
    const onClick = () => {
      if (muteLocked) return locked(muteLocked);
      if (mic) return mic.onToggle();
      if (hasHand) { voice.onLower(); toast({ title: "Hand lowered" }); }
      else { voice.onRaise(); toast({ title: "Hand raised. The host can bring you on the mic." }); }
    };
    return (
      <button type="button" onClick={onClick} aria-label={label} aria-pressed={muteLocked ? undefined : pressed} aria-disabled={muteLocked ? true : undefined}
        className={`${rb} ${pressed && !muteLocked ? rbOn : rbIdle} ${muteLocked ? "opacity-40" : HOVER} ${FOCUS} ${PRESS}`} data-testid="dock-mic">
        <MicIcon className="h-5 w-5" aria-hidden />
      </button>
    );
  })();

  const camBtn = !immersive && cam.visible ? (
    <button type="button" onClick={() => (cam.lockedReason ? locked(cam.lockedReason) : cam.onClick())} aria-label={cam.label ?? "Go live on camera"}
      aria-pressed={cam.lockedReason ? undefined : cam.pressed} aria-disabled={cam.lockedReason ? true : undefined}
      className={`${rb} ${cam.pressed && !cam.lockedReason ? rbOn : rbIdle} ${cam.lockedReason ? "opacity-40" : HOVER} ${FOCUS} ${PRESS}`} data-testid="dock-cam">
      <CameraIcon className="h-5 w-5" aria-hidden />
    </button>
  ) : null;

  const placeholder = muted ? "You're muted" : waitLeft > 0 ? `Slow mode, wait ${waitLeft}s` : "Message the room";

  return (
    <div className="relative grid grid-cols-[minmax(0,1fr)] gap-1.5 px-3 pb-[calc(12px+env(safe-area-inset-bottom,0px))] pt-1" data-testid="room-dock">
      {!immersive && hype}
      {!immersive && (
        <div className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none]" role="group" aria-label="React to the room" data-testid="dock-reactions">
          {onWave && (
            <button type="button" onClick={onWave} className={`min-h-[44px] shrink-0 rounded-full border border-border bg-muted px-3.5 text-sm font-medium ${HOVER} ${FOCUS} ${PRESS}`} data-testid="dock-wave">Wave <span aria-hidden>👋</span></button>
          )}
          {DOCK_REACTIONS.map((e) => (
            <button key={e} type="button" onClick={() => onReact(e)} aria-label={`React with ${e}`} className={`grid h-11 w-11 shrink-0 place-items-center rounded-full border border-border bg-muted text-[22px] ${HOVER} ${FOCUS} ${PRESS}`} data-testid={`react-${e}`}>{e}</button>
          ))}
        </div>
      )}
      {reply && (
        <div className={`flex min-h-[44px] items-center justify-between gap-2 rounded-xl pl-3 pr-1 text-sm ${immersive ? "bg-black/60 text-white" : "bg-primary/15 text-primary"}`} data-testid="dock-reply">
          <span className="min-w-0 truncate">Replying to {replyName ?? "Someone"}: {reply.text}</span>
          <button type="button" onClick={onCancelReply} aria-label="Cancel reply" className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${FOCUS}`} data-testid="dock-reply-cancel"><XIcon className="h-4 w-4" aria-hidden /></button>
        </div>
      )}
      <form onSubmit={submit} className="flex min-w-0 items-center gap-2">
        {micBtn}
        {camBtn}
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, ROOM_LIMITS.chat))}
          onKeyDown={(e) => { if (e.key === "Escape" && reply) { e.preventDefault(); onCancelReply(); } }}
          maxLength={ROOM_LIMITS.chat}
          placeholder={placeholder}
          disabled={muted}
          autoComplete="off"
          enterKeyHint="send"
          aria-label="Message"
          // 16 px so iOS doesn't zoom the page when the composer gets focus.
          className={`min-w-0 flex-1 rounded-full border px-[18px] text-base outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60 ${immersive ? "h-11 border-transparent bg-white/15 text-white placeholder:text-white/75" : "h-12 border-border bg-muted text-foreground placeholder:text-muted-foreground"}`}
          data-testid="dock-input"
        />
        {immersive && !trimmed && (
          <button type="button" onClick={onToggleTray} aria-label="React" aria-expanded={trayOpen} className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${trayOpen ? rbOn : "bg-white/15 text-white"} ${FOCUS} ${PRESS}`} data-testid="dock-heart">
            <HeartIcon className="h-5 w-5" aria-hidden />
          </button>
        )}
        {(!immersive || trimmed) && (
          <button type="submit" disabled={!canSend} aria-label="Send message"
            className={`grid shrink-0 place-items-center rounded-full ${immersive ? "h-11 w-11" : "h-12 w-12"} ${canSend ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"} ${FOCUS} ${PRESS}`} data-testid="dock-send">
            <SendIcon className="h-5 w-5" aria-hidden />
          </button>
        )}
      </form>
      {!immersive && text.length > ROOM_LIMITS.chat - 40 && <p className="text-right text-xs text-muted-foreground" aria-live="polite">{text.length}/{ROOM_LIMITS.chat}</p>}
      {immersive && tray}
    </div>
  );
}
