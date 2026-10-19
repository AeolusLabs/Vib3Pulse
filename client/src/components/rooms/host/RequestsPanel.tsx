import { Button } from "@/components/ui/button";
import HostAvatar from "@/components/rooms/HostAvatar";
import { XIcon } from "@/components/ui/icons";
import { CONTROLS_COPY, REQUEST_LABEL, requestQueue, type RequestItem } from "@/lib/hostControls";
import type { RoomMemberView } from "@/lib/roomReducer";

export interface RequestsPanelProps {
  members: RoomMemberView[];
  /** Rows already acted on (`kind:userId`), hidden until the server's next list or a refusal brings them back. Owned by the sheet so its badge counts the same rows. */
  acted: ReadonlySet<string>;
  onActed(key: string): void;
  hands: string[];
  asks: string[];
  liveVideo: boolean;
  /** Give the mic to a raised hand (room:stage accept) or put a go-live ask on the screen (room:live grant). False when the socket is down. */
  onAccept(item: RequestItem): boolean;
  /** Lower a raised hand (room:stage remove). Go-live asks have no dismiss on the server; the person withdraws it themselves. */
  onDismiss(item: RequestItem): boolean;
  /** One plain line when a tap could not be sent. */
  onFailed(message: string): void;
}

const nameOf = (m?: RoomMemberView) => (m ? m.displayName || m.organizationName || m.username || "Guest" : "Someone");
const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

/** Raised hands and go-live asks in one queue, one tap to accept. A tapped row hides at once and the next room:stage / room:live settles it. */
export default function RequestsPanel({ members, acted, onActed, hands, asks, liveVideo, onAccept, onDismiss, onFailed }: RequestsPanelProps) {
  const byId = new Map(members.map((m) => [m.userId, m]));
  const queue = requestQueue(hands, asks, liveVideo, acted);

  const act = (item: RequestItem, fn: (i: RequestItem) => boolean) => {
    if (!fn(item)) { onFailed(CONTROLS_COPY.sendFailed); return; }
    onActed(`${item.kind}:${item.userId}`);
  };

  if (queue.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed px-4 py-8 text-center" data-testid="requests-empty">
        <p className="font-medium">{CONTROLS_COPY.requestsEmpty}</p>
        <p className="mt-1 text-sm text-muted-foreground">{CONTROLS_COPY.requestsEmptySub}</p>
      </div>
    );
  }
  return (
    <div className="space-y-3" data-testid="requests-panel">
      <ul className="grid gap-2" aria-label="Requests">
        {queue.map((item) => {
          const m = byId.get(item.userId);
          const name = nameOf(m);
          return (
            <li key={`${item.kind}:${item.userId}`} className="flex items-center gap-3 rounded-2xl border bg-muted px-3 py-2" data-testid={`request-${item.kind}-${item.userId}`}>
              <HostAvatar person={m ?? {}} className="h-10 w-10 shrink-0 rounded-full" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{name}</span>
                <span className="block text-xs text-muted-foreground">{REQUEST_LABEL[item.kind]}</span>
              </span>
              <Button className={`min-h-[44px] rounded-full px-5 ${FOCUS}`} onClick={() => act(item, onAccept)} aria-label={`Accept ${name}`} data-testid={`button-accept-${item.kind}-${item.userId}`}>Accept</Button>
              {item.kind === "hand" && (
                <Button variant="outline" size="icon" className={`h-11 w-11 shrink-0 rounded-full ${FOCUS}`} onClick={() => act(item, onDismiss)} aria-label={`Lower ${name}'s hand`} data-testid={`button-dismiss-${item.userId}`}>
                  <XIcon className="h-4 w-4" aria-hidden />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {queue.some((i) => i.kind === "live") && <p className="text-sm text-muted-foreground">{CONTROLS_COPY.oneOnCamera}</p>}
    </div>
  );
}
