import type { ReactNode } from "react";

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
}

/**
 * The room's frame. Purely layout: it owns no state. Fills its parent, so the parent decides the height (the page gives it the
 * whole viewport). In `stack` the zone is capped so chat always keeps most of the screen; in immersive the zone is the frame.
 */
export default function RoomFrame({ layout, immersive, top, zone, pin, chat, dock, floating }: RoomFrameProps) {
  const imm = immersive && layout === "stack";

  if (layout === "rail") {
    return (
      <div className="relative grid h-full min-h-0 grid-cols-[minmax(0,1fr)_360px] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-background text-foreground" data-testid="room-frame" data-layout="rail" data-immersive="false">
        <div className="col-start-1 row-start-1 min-w-0 px-2 pb-2 pt-3">{top}</div>
        <div className="col-start-1 row-span-2 row-start-2 min-h-0 min-w-0 overflow-y-auto px-4 pb-4" data-testid="room-zone">{zone}</div>
        <section aria-label="Room chat" className="col-start-2 row-span-2 row-start-1 flex min-h-0 flex-col border-l bg-card">
          <h2 className="px-4 pb-2 pt-4 text-sm font-semibold">Chat</h2>
          {pin && <div className="px-3 pb-1">{pin}</div>}
          <div className="flex min-h-0 flex-1 flex-col">{chat}</div>
        </section>
        <div className="col-start-2 row-start-3 border-l bg-card">{dock}</div>
        {floating}
      </div>
    );
  }

  if (imm) {
    return (
      <div className="relative h-full min-h-0 overflow-hidden bg-black text-white" data-testid="room-frame" data-layout="stack" data-immersive="true">
        <div className="absolute inset-0 z-0" data-testid="room-zone">{zone}</div>
        <div className="absolute inset-x-0 top-0 z-[5] bg-gradient-to-b from-black/70 to-transparent px-2 pb-5 pt-3">{top}</div>
        {/* Chat floats over the lower picture, clear of the right-hand rail. The log itself takes pointer events per message. */}
        <section aria-label="Room chat" className="absolute bottom-[76px] left-0 right-16 z-[4] flex h-[30%] min-h-0 flex-col">{chat}</section>
        <div className="absolute inset-x-0 bottom-0 z-[5] bg-gradient-to-t from-black/70 to-transparent pt-3">{dock}</div>
        {floating}
      </div>
    );
  }

  return (
    <div className="relative grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden bg-background text-foreground" data-testid="room-frame" data-layout="stack" data-immersive="false">
      <div className="min-w-0 px-2 pb-2 pt-3">{top}</div>
      {/* Capped so chat is always on screen at 390 x 800; the scene scrolls inside its own box when the room is busy. */}
      <div className="max-h-[38dvh] min-h-0 min-w-0 overflow-y-auto px-3" data-testid="room-zone">{zone}</div>
      <section aria-label="Room chat" className="mt-1.5 flex min-h-0 flex-col">
        {pin && <div className="px-3 pb-1">{pin}</div>}
        <div className="flex min-h-0 flex-1 flex-col">{chat}</div>
      </section>
      <div className="border-t bg-card">{dock}</div>
      {floating}
    </div>
  );
}
