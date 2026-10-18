import HostAvatar from "@/components/rooms/HostAvatar";
import { MicOffMark } from "@/components/rooms/MicOffMark";
import type { RoomMemberView } from "@/lib/roomReducer";
import { stripOrder } from "@/lib/videoViewState";

interface Props {
  members: RoomMemberView[];
  /** Guests given the mic (host and co-hosts are always in the strip). */
  stage: string[];
  /** Ids LiveKit reports as speaking right now (useRoomVoice().activeSpeakers). */
  speaking: string[];
  selfId: string | null;
  onPick(m: RoomMemberView): void;
}

const nameOf = (m: RoomMemberView) => m.displayName || m.organizationName || m.username || "Guest";

/** One scrolling row under the live picture: host, co-hosts and stage guests, with a ring on whoever is talking. */
export default function SpeakerStrip({ members, stage, speaking, selfId, onPick }: Props) {
  const people = stripOrder(members, stage);
  if (people.length === 0) return null;
  const talking = new Set(speaking);
  return (
    <ul aria-label="Speakers and guests" className="flex items-start gap-1 overflow-x-auto px-3 pt-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" data-testid="speaker-strip">
      {people.map((m) => {
        const you = m.userId === selfId;
        const on = talking.has(m.userId);
        const label = `${nameOf(m)}${you ? " (you)" : ""}${m.role === "host" ? ", host" : m.role === "cohost" ? ", co-host" : ", on the mic"}${m.muted ? ", muted" : ""}${on ? ", speaking" : ""}`;
        return (
          <li key={m.userId} className="w-14 flex-none">
            <button
              type="button"
              onClick={() => onPick(m)}
              aria-label={`${label}. Open actions`}
              className="flex min-h-[44px] w-full flex-col items-center rounded-xl p-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              data-testid={`strip-${m.userId}`}
            >
              <span className="relative">
                <span className={on ? "block rounded-full ring-[3px] ring-green-500 ring-offset-2 ring-offset-background" : "block"} data-testid={on ? `strip-speaking-${m.userId}` : undefined}>
                  <HostAvatar person={m} className="h-11 w-11" />
                </span>
                {m.muted && <MicOffMark />}
              </span>
              <span className={`mt-1 w-full truncate text-center text-[11px] leading-tight ${you ? "font-semibold text-primary" : "text-foreground"}`}>{you ? "You" : nameOf(m)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
