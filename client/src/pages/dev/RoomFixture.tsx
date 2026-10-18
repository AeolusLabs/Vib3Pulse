// Dev-only: renders the room building blocks from seeded state, no sockets, no LiveKit.
// Query: ?scene=voice|live|immersive|weak|dropped  &theme=dark|light
import { useEffect, useMemo, useRef } from "react";
import RoomScene from "@/components/rooms/RoomScene";
import { RoomChat, ReactionBar } from "@/components/rooms/RoomChat";
import VoiceBar from "@/components/rooms/VoiceBar";
import { FIXTURE_NAMES, fixtureState, type FixtureScene } from "@/lib/roomFixtures";
import type { RoomVoice } from "@/hooks/useRoomVoice";

const SCENES: FixtureScene[] = ["voice", "live", "immersive", "weak", "dropped"];
const noop = () => {};

export default function RoomFixture() {
  const params = new URLSearchParams(window.location.search);
  const asked = params.get("scene");
  const scene: FixtureScene = SCENES.includes(asked as FixtureScene) ? (asked as FixtureScene) : "voice";
  const theme = params.get("theme") === "light" ? "light" : "dark";
  const state = useMemo(() => fixtureState(scene), [scene]);
  const was = useRef<boolean | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (was.current === null) was.current = root.classList.contains("dark");
    root.classList.toggle("dark", theme === "dark");
    return () => { root.classList.toggle("dark", was.current === true); };
  }, [theme]);

  const voice = { status: "listening", canPublish: false, micOn: false, error: null, micError: null, unlock: async () => {}, toggleMic: async () => {}, activeSpeakers: state.stage } as unknown as RoomVoice;
  const nameOf = (id: string) => FIXTURE_NAMES[id] ?? "Someone";

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-4 bg-background p-4 font-sans text-foreground" data-testid="room-fixture" data-scene={scene}>
      <header>
        <p className="text-xs text-muted-foreground">Dev fixture, scene: {scene}</p>
        <p className="text-sm" data-testid="fixture-count">{state.memberCount} people here</p>
      </header>
      <RoomScene members={state.members} memberCount={state.memberCount} selfId={state.selfId} reactions={state.reactions} interactions={state.interactions} stage={state.stage} speaking={state.stage} onAvatarTap={noop} />
      <VoiceBar voice={voice} hasHand={false} canAskToSpeak onRaise={noop} onLower={noop} />
      <RoomChat chat={state.chat} nameOf={nameOf} onSend={noop} muted={false} />
      <ReactionBar onReact={noop} />
    </main>
  );
}
