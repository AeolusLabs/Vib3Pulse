import HostAvatar from "@/components/rooms/HostAvatar";
import { MicOffMark } from "@/components/rooms/MicOffMark";
import SpeakerStrip from "@/components/rooms/shell/SpeakerStrip";
import type { InteractionItem, ReactionItem, RoomMemberView } from "@/lib/roomReducer";

interface Props {
  members: RoomMemberView[];
  /** Everyone in the room; the list above is capped by the server. */
  memberCount: number;
  selfId: string | null;
  reactions: ReactionItem[];
  interactions: InteractionItem[];
  hidden?: Set<string>;
  /** Guests given the mic; host and co-hosts are always on the stage row. Empty when voice is off. */
  stage?: string[];
  /** Ids LiveKit reports as speaking right now. */
  speaking?: string[];
  onAvatarTap: (member: RoomMemberView) => void;
  /** "scene" (default): the stage row over the dance floor. "strip": one row of speakers under a live picture. */
  variant?: "scene" | "strip";
}

const nameOf = (m: RoomMemberView) => m.displayName || m.organizationName || m.username || "Guest";

function Figure({ m, selfId, size, emoji, onTap, onMic, talking }: { m: RoomMemberView; selfId: string | null; size: "stage" | "floor"; emoji: string[]; onTap: (m: RoomMemberView) => void; onMic?: boolean; talking?: boolean }) {
  const you = m.userId === selfId;
  const box = size === "stage" ? "h-20 w-20" : "h-14 w-14";
  const label = `${nameOf(m)}${you ? " (you)" : ""}${m.role !== "guest" ? `, ${m.role === "host" ? "host" : "co-host"}` : ""}${m.muted ? ", muted" : ""}${onMic ? ", on the mic" : ""}${talking ? ", speaking" : ""}`;
  return (
    <li className="flex w-20 flex-col items-center">
      <button
        type="button"
        onClick={() => onTap(m)}
        className="relative flex min-h-[44px] min-w-[44px] flex-col items-center rounded-xl p-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        aria-label={`${label}. Open actions`}
        data-testid={`avatar-${m.userId}`}
      >
        <span className="relative">
          <span className={talking ? "block rounded-full ring-4 ring-green-500 ring-offset-2 ring-offset-background" : "block"} data-testid={talking ? `speaking-${m.userId}` : undefined}><HostAvatar person={m} className={box} /></span>
          {emoji.map((e, i) => <span key={`${e}${i}`} className="room-float pointer-events-none absolute -top-2 left-1/2 text-2xl" aria-hidden>{e}</span>)}
          {m.muted && <MicOffMark />}
        </span>
        <span className={`mt-1 w-full truncate text-center text-[11px] leading-tight ${you ? "font-semibold text-primary" : "text-foreground"}`}>{you ? "You" : nameOf(m)}</span>
        {onMic && m.role === "guest" && <span className="text-[10px] font-medium text-green-700 dark:text-green-400" data-testid={`onmic-${m.userId}`}>On the mic</span>}
      </button>
    </li>
  );
}

/**
 * A 2D club: the stage row (host and co-hosts) over the floor (everyone else). Positions are assigned, not
 * dragged. Every avatar is a real button, and the member list sheet offers the same actions without the scene.
 */
export default function RoomScene({ members, memberCount, selfId, reactions, interactions, hidden, stage = [], speaking = [], onAvatarTap, variant = "scene" }: Props) {
  if (variant === "strip") return <SpeakerStrip members={members} stage={stage} speaking={speaking} selfId={selfId} onPick={onAvatarTap} />;
  const emojiFor = (userId: string) => [
    ...(hidden?.has(userId) ? [] : reactions.filter((r) => r.userId === userId).slice(-2).map((r) => r.emoji)),
    ...(hidden?.has(userId) ? [] : interactions.filter((i) => i.kind === "wave" && i.fromId === userId).slice(-1).map(() => "👋")),
  ];
  const onMicIds = new Set(stage);
  const isOnStage = (m: RoomMemberView) => m.role === "host" || m.role === "cohost" || onMicIds.has(m.userId);
  const stageRow = members.filter(isOnStage);
  const floor = members.filter((m) => !isOnStage(m));
  const talking = new Set(speaking);
  const more = Math.max(0, memberCount - members.length);

  return (
    <section aria-label="The room" className="space-y-3 rounded-2xl border bg-gradient-to-b from-muted/60 to-muted/20 p-3" data-testid="room-scene">
      <div>
        <h2 className="sr-only">Stage</h2>
        <ul className="flex flex-wrap items-end justify-center gap-2" data-testid="scene-stage">
          {stageRow.map((m) => <Figure key={m.userId} m={m} selfId={selfId} size="stage" emoji={emojiFor(m.userId)} onTap={onAvatarTap} onMic={onMicIds.has(m.userId)} talking={talking.has(m.userId)} />)}
        </ul>
      </div>
      <div className="border-t border-dashed" />
      <div>
        <h2 className="sr-only">Dance floor</h2>
        <ul className="flex flex-wrap justify-center gap-x-1 gap-y-2" data-testid="scene-floor">
          {floor.map((m) => <Figure key={m.userId} m={m} selfId={selfId} size="floor" emoji={emojiFor(m.userId)} onTap={onAvatarTap} />)}
          {more > 0 && <li className="flex h-14 min-w-[44px] items-center self-center rounded-full bg-muted px-3 text-xs font-semibold" data-testid="scene-more">+{more} more</li>}
        </ul>
        {floor.length === 0 && more === 0 && <p className="py-4 text-center text-sm text-muted-foreground">It's quiet. Say hi.</p>}
      </div>
    </section>
  );
}
