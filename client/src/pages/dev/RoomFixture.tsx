// Dev-only: renders the REAL room shell (RoomShell: top bar, picture, chat log, dock, tray, rail, sheets) from seeded state.
// No sockets, no LiveKit: socket actions feed a local reducer, the picture is a canvas, and the few room endpoints the
// sheets read are answered in the page. Query: ?scene=voice|live|immersive|weak|dropped &theme=dark|light
// &as=guest|holder|host &sound=1 (sound only) &tap=1 (audio waits for a tap) &flood=300 (chat lines over ten seconds).
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import RoomShell, { type RoomShellSocket } from "@/components/rooms/shell/RoomShell";
import type { RoomVoice, ScreenTrack } from "@/hooks/useRoomVoice";
import { roomReducer, type RoomState } from "@/lib/roomReducer";
import { FIXTURE_HOST, FIXTURE_IDS, FIXTURE_NAMES, FIXTURE_ROOM, fixtureLiveState, fixtureStartView, parseFixtureQuery } from "@/lib/roomFixtures";

type Ev = Parameters<typeof roomReducer>[1];

/** A moving canvas stands in for the live camera, so the picture, object-cover and the scrim can be judged. */
function canvasTrack(): ScreenTrack & { stop(): void } {
  const c = document.createElement("canvas");
  c.width = 640; c.height = 360;
  const g = c.getContext("2d")!;
  let f = 0;
  const draw = () => {
    f++;
    const grad = g.createLinearGradient(0, 0, 640, 360);
    grad.addColorStop(0, "#2a1650"); grad.addColorStop(1, "#0b3b3a");
    g.fillStyle = grad; g.fillRect(0, 0, 640, 360);
    g.fillStyle = "#16121f"; g.beginPath(); g.ellipse(320, 380, 190, 130, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#c27a4a"; g.beginPath(); g.arc(320, 170 + Math.sin(f / 6) * 3, 62, 0, Math.PI * 2); g.fill();
  };
  draw();
  const t = setInterval(draw, 120);
  const stream = (c as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(8);
  return {
    attach(el) { el.srcObject = stream; void el.play().catch(() => {}); },
    detach(el) { el.srcObject = null; },
    stop() { clearInterval(t); stream.getTracks().forEach((tr) => tr.stop()); },
  };
}

/** Answers the endpoints the room sheets read, inside the page. Everything else goes to the real fetch. */
function useFixtureFetch() {
  useEffect(() => {
    const real = window.fetch;
    const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(window.location.origin, "");
      if (/^\/api\/rooms\/fixture-room\/members\/[^/]+\/actions/.test(path)) return json({ actions: { interact: true, dm: false, invite: false } });
      if (/^\/api\/rooms\/fixture-room\/report/.test(path)) return json({ ok: true });
      if (/^\/api\/users\/[^/]+\/follow-stats/.test(path)) return json({ followersCount: 128, followingCount: 64 });
      if (/^\/api\/users\/[^/?]+$/.test(path)) return json({ bio: "Fixture profile. Nothing here is real." });
      return real(input, init);
    }) as typeof window.fetch;
    return () => { window.fetch = real; };
  }, []);
}

export default function RoomFixture() {
  const opts = useMemo(() => parseFixtureQuery(window.location.search), []);
  const [state, dispatch] = useReducer((s: RoomState, e: Ev) => roomReducer(s, e), undefined, () => fixtureLiveState(opts.scene, { as: opts.as, now: Date.now() }));
  const was = useRef<boolean | null>(null);
  useFixtureFetch();

  useEffect(() => {
    const root = document.documentElement;
    if (was.current === null) was.current = root.classList.contains("dark");
    root.classList.toggle("dark", opts.theme === "dark");
    return () => { root.classList.toggle("dark", was.current === true); };
  }, [opts.theme]);

  // The picture: none for a voice room or a dropped holder (the slate explains), otherwise the moving canvas.
  const [track, setTrack] = useState<(ScreenTrack & { stop(): void }) | null>(null);
  useEffect(() => {
    if (opts.scene === "voice" || opts.scene === "dropped") return;
    const t = canvasTrack();
    setTrack(t);
    return () => t.stop();
  }, [opts.scene]);

  // Reactions fade like the real socket hook does it.
  useEffect(() => {
    const t = setInterval(() => dispatch({ type: "client:expire", before: Date.now() - 4000 }), 1000);
    return () => clearInterval(t);
  }, []);

  // Chat flood: `flood` lines spread over ten seconds, from everyone but you.
  useEffect(() => {
    if (!opts.flood) return;
    const authors = Object.keys(FIXTURE_NAMES).filter((id) => id !== state.selfId);
    let n = 0;
    const t = setInterval(() => {
      n++;
      dispatch({ type: "room:chat", userId: authors[n % authors.length], text: `Flood line ${n}: ${n % 7 === 0 ? "a much longer message that wraps onto a second line on a phone" : "hello"}`, at: Date.now() });
      if (n >= opts.flood) clearInterval(t);
    }, 10_000 / opts.flood);
    return () => clearInterval(t);
  }, [opts.flood]); // eslint-disable-line react-hooks/exhaustive-deps

  const self = state.selfId ?? FIXTURE_IDS.self;
  const [audioOnly, setAudioOnly] = useState(opts.sound);
  const [micOn, setMicOn] = useState(false);
  const [status, setStatus] = useState<RoomVoice["status"]>(opts.tap ? "needs-tap" : "listening");
  const isHolder = state.holder === self;
  const voice: RoomVoice = {
    status,
    unlock: async () => { setStatus("connecting"); setTimeout(() => setStatus("listening"), 600); },
    canPublish: opts.as !== "guest",
    micOn,
    toggleMic: async () => setMicOn((m) => !m),
    activeSpeakers: state.stage,
    error: null, micError: null,
    video: isHolder || audioOnly ? null : track,
    localVideo: isHolder ? track : null,
    cameraOn: isHolder && !!track,
    cameraError: null,
    reconnecting: false, comingBack: false,
    startCamera: async () => true, stopCamera: async () => {},
    onAir: isHolder, videoPaused: false, pauseVideo: async () => {}, resumeVideo: async () => {},
    audioOnly, setAudioOnly,
    linkQuality: opts.scene === "weak" ? "poor" : "good",
    linkPoorSince: opts.scene === "weak" ? Date.now() - 20_000 : null,
  } as RoomVoice;

  const ok = () => true;
  const sock: RoomShellSocket = {
    chat: (text, replyTo) => { dispatch({ type: "room:chat", userId: self, text, at: Date.now(), ...(replyTo ? { replyTo } : {}) }); return true; },
    react: (emoji) => { dispatch({ type: "room:react", userId: self, emoji, at: Date.now() }); return true; },
    interact: ok, setScreen: ok, mod: ok, stageAction: ok, liveAction: ok, sendPlayback: ok,
    setVoice: async () => true, setLiveVideo: async () => true,
    dismissInvite: () => {},
  };

  return (
    <div className="font-sans" data-testid="room-fixture" data-scene={opts.scene}>
      <RoomShell
        id={FIXTURE_ROOM.id}
        room={FIXTURE_ROOM}
        host={FIXTURE_HOST}
        fallbackCount={state.memberCount}
        isHost={opts.as === "host"}
        role={opts.as === "host" ? "host" : "guest"}
        meId={self}
        state={state}
        sock={sock}
        voice={voice}
        myRoomId={null}
        nav={<div className="border-b px-4 py-3 text-sm text-muted-foreground">App navigation (fixture stand-in)</div>}
        hostControls={<p className="text-sm text-muted-foreground">Room settings (fixture stand-in)</p>}
        onLeave={() => window.history.back()}
        startView={fixtureStartView(opts.scene)}
      />
    </div>
  );
}
