import type { ReactNode } from "react";
import { frameSlots } from "@/lib/roomShell";
import { chromeClasses } from "@/lib/roomIntegration";

export interface RoomFrameProps {
  /** `stack`: phone and tablet (rows: top, zone, pin + chat taking the rest, dock). `rail`: desktop (picture left, 360 px chat rail right, dock under the chat). */
  layout: "stack" | "rail";
  /** The zone (the picture) fills the frame and top, chat and dock float over it. Only meaningful for live video; ignored in `rail`. */
  immersive: boolean;
  top: ReactNode;
  /** The scene: avatars for a voice room, the picture for live video, plus banners that belong to it. */
  zone: ReactNode;
  /** Above the chat log (pinned host message, phase 3). Hidden in immersive. */
  pin?: ReactNode;
  chat: ReactNode;
  dock: ReactNode;
  /** Absolutely positioned over everything (status pill, floating emoji, the immersive rail from task 1.5). */
  floating?: ReactNode;
  /** Immersive only: the picture was tapped to hide the top bar and dock. They fade out but come back while focus is in them. */
  chromeHidden?: boolean;
  /** Focus reached hidden chrome (keyboard): show it again for real. */
  onReveal?: () => void;
  /** Live video in the compact stack: the zone may grow to hold the picture, its controls and the speaker strip. */
  live?: boolean;
}

/**
 * The room's frame. Purely layout: it owns no state. Fills its parent, so the parent decides the height.
 * The element tree is the same in every layout and view (only classes change, see `frameSlots`): rotating a tablet across
 * 1024 px or switching to immersive must never unmount the picture, the composer draft or the chat scroll position.
 */
export default function RoomFrame({ layout, immersive, top, zone, pin, chat, dock, floating, chromeHidden = false, onReveal, live = false }: RoomFrameProps) {
  const imm = immersive && layout === "stack";
  const c = frameSlots(layout, imm, { live });
  const hide = imm && chromeHidden;
  const chrome = chromeClasses(imm, hide);
  const reveal = hide ? onReveal : undefined;
  return (
    <div className={c.root} data-testid="room-frame" data-layout={layout} data-immersive={imm ? "true" : "false"}>
      <div className={`${c.top} ${chrome}`} onFocus={reveal} data-chrome-hidden={hide ? "true" : "false"} data-testid="room-top">{top}</div>
      <div className={c.zone} data-testid="room-zone">{zone}</div>
      <section aria-label="Room chat" className={c.chat}>
        <h2 className={c.chatHeading}>Chat</h2>
        <div className={pin ? c.pin : "hidden"}>{pin}</div>
        <div className={c.chatBody}>{chat}</div>
      </section>
      <div className={`${c.dock} ${chrome}`} onFocus={reveal} data-chrome-hidden={hide ? "true" : "false"} data-testid="room-dock-wrap">{dock}</div>
      {floating}
    </div>
  );
}
