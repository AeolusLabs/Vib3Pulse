import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import HostAvatar from "@/components/rooms/HostAvatar";
import { requestQueue, type RequestItem } from "@/lib/hostControls";
import type { RoomMemberView } from "@/lib/roomReducer";

// Going on stage, on the room screen itself: the host or co-host gets one card per waiting request (Accept, Not now), the viewer gets
// a calm "request sent" card with their place in line, and a plain line if the host doesn't take the request.

const CARD = "pointer-events-auto absolute inset-x-3 bottom-[calc(76px+env(safe-area-inset-bottom,0px))] z-[14] rounded-2xl border bg-background/95 p-3 shadow-xl backdrop-blur motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-200";
const nameOf = (m?: RoomMemberView) => (m ? m.displayName || m.organizationName || m.username || "Guest" : "Someone");
const place = (n: number) => (n === 1 ? "You are next. " : n > 1 ? `You are ${n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`} in line. ` : "");

interface HostProps {
  members: RoomMemberView[];
  hands: string[];
  asks: string[];
  liveVideo: boolean;
  /** Same sends as the Requests tab: room:stage accept / room:live grant, and room:stage remove for Not now. False when the socket is down. */
  onAccept(item: RequestItem): boolean;
  onDecline(item: RequestItem): boolean;
  /** Takes back an accepted mic (room:stage remove). */
  onUndo(userId: string): void;
}

export function HostRequestCard({ members, hands, asks, liveVideo, onAccept, onDecline, onUndo }: HostProps) {
  const [acted, setActed] = useState<ReadonlySet<string>>(new Set());
  const [undo, setUndo] = useState<{ userId: string; name: string } | null>(null);
  // Forget a handled request once it leaves the server's list, so the same person can ask again.
  useEffect(() => {
    setActed((s) => {
      const keep = Array.from(s).filter((k) => (k.startsWith("hand:") ? hands : asks).includes(k.slice(k.indexOf(":") + 1)));
      return keep.length === s.size ? s : new Set(keep);
    });
  }, [hands, asks]);
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 5000);
    return () => clearTimeout(t);
  }, [undo]);

  const queue = requestQueue(hands, asks, liveVideo, acted);
  const first = queue[0];
  const mark = (i: RequestItem) => setActed((s) => new Set(s).add(`${i.kind}:${i.userId}`));
  const byId = (id: string) => members.find((m) => m.userId === id);

  if (undo) {
    return (
      <div role="status" className="pointer-events-auto absolute inset-x-3 bottom-[calc(76px+env(safe-area-inset-bottom,0px))] z-[14] flex items-center gap-3 rounded-full bg-foreground py-1.5 pl-5 pr-2 text-background shadow-xl motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-200" data-testid="stage-undo">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{undo.name} is on stage</span>
        <Button variant="ghost" className="min-h-[44px] rounded-full px-4 font-semibold text-background hover:bg-background/10 hover:text-background" onClick={() => { onUndo(undo.userId); setUndo(null); }}>Undo</Button>
      </div>
    );
  }
  if (!first) return null;
  const m = byId(first.userId);
  const name = nameOf(m);
  return (
    <div role="status" aria-live="polite" className={CARD} data-testid="stage-request-card">
      <div className="mb-3 flex items-center gap-3">
        <HostAvatar person={m ?? {}} className="h-11 w-11 shrink-0 rounded-full" />
        <p className="min-w-0 flex-1 text-base font-semibold leading-tight">
          <span className="block truncate">{name}</span>
          <span className="block text-sm font-normal text-muted-foreground">{first.kind === "hand" ? "wants the mic" : "wants to go live on camera"}</span>
        </p>
        {queue.length > 1 && <span className="shrink-0 rounded-full bg-secondary/20 px-2.5 py-1 text-xs font-semibold">{queue.length - 1} more</span>}
      </div>
      <div className="flex gap-2">
        <Button className="min-h-[48px] flex-1 rounded-full font-semibold" onClick={() => { if (onAccept(first)) { mark(first); if (first.kind === "hand") setUndo({ userId: first.userId, name }); } }} aria-label={`Accept ${name}`} data-testid="stage-request-accept">Accept</Button>
        <Button variant="outline" className="min-h-[48px] rounded-full px-5" onClick={() => { if (onDecline(first)) mark(first); }} data-testid="stage-request-decline">Not now</Button>
      </div>
    </div>
  );
}

interface ViewerProps {
  /** Your hand is up; `spot` is your 1-based place among the raised hands. */
  hasHand: boolean;
  spot: number;
  onStage: boolean;
  onCancel(): void;
}

export function ViewerAskCard({ hasHand, spot, onStage, onCancel }: ViewerProps) {
  const [declined, setDeclined] = useState(false);
  const was = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (was.current && !hasHand && !onStage && !cancelled.current) setDeclined(true);
    if (hasHand) { cancelled.current = false; setDeclined(false); }
    was.current = hasHand;
  }, [hasHand, onStage]);
  useEffect(() => {
    if (!declined) return;
    const t = setTimeout(() => setDeclined(false), 6000);
    return () => clearTimeout(t);
  }, [declined]);

  if (declined) {
    return <p role="status" className={`${CARD} text-sm font-medium`} data-testid="stage-declined">The host isn't taking requests right now</p>;
  }
  if (!hasHand) return null;
  return (
    <div role="status" aria-live="polite" className={`${CARD} flex items-center gap-3`} data-testid="stage-waiting">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-primary motion-safe:animate-pulse" aria-hidden />
      <p className="min-w-0 flex-1 leading-tight">
        <span className="block text-base font-semibold">Request sent</span>
        <span className="block text-sm text-muted-foreground">{place(spot)}We will tell you when the host answers.</span>
      </p>
      <Button variant="outline" className="min-h-[48px] rounded-full px-5" onClick={() => { cancelled.current = true; onCancel(); }} data-testid="stage-cancel">Cancel</Button>
    </div>
  );
}

/**
 * For someone on stage (or a co-host) in a room with spray on: sprays only reach people with a bank account that passed the name check, and a
 * person who has not set one up is simply not offered to the room. Nothing else tells them, so say it once, with the way to fix it.
 */
export function StagePayoutHint() {
  const { data } = useQuery<{ verifiedAdult: boolean; subaccountReady: boolean }>({ queryKey: ["/api/rooms/payouts/status"], staleTime: 60_000 });
  if (!data || data.subaccountReady) return null;
  return (
    <p role="status" className="rounded-xl border bg-muted px-3 py-2 text-sm" data-testid="stage-payout-hint">
      People can't spray you yet. <Link href="/rooms/payouts" className="font-medium text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">Finish Get paid</Link> so your share reaches your bank.
    </p>
  );
}
