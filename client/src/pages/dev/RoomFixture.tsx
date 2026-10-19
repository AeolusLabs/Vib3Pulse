// Dev-only: renders the REAL room shell (RoomShell: top bar, picture, chat log, dock, tray, rail, sheets) from seeded state.
// No room socket and no LiveKit: socket actions feed a local reducer, the picture is a canvas, and the few room endpoints the
// sheets read are answered in the page. The app around it (auth, notifications) still makes its usual requests.
// Query: ?scene=voice|live|immersive|weak|dropped &theme=dark|light &as=guest|holder|host &sound=1 (sound only)
// &tap=1 (audio waits for a tap) &invite=1 (invited to speak) &flood=300 (chat lines over ten seconds).
// &minors=refuse|ack|invites|listen|teennote shows the minors' room screens (listen is the room shell seen as an adult).
// ?wizard=adult|teen shows the Start a room sheet and the create wizard for that host, with every endpoint answered here.
// &controls=host|cohost opens the Controls sheet as the host or a co-host (requests waiting, settings set; saves settle locally).
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import RoomShell, { type RoomShellSocket } from "@/components/rooms/shell/RoomShell";
import MinorsRoomWarning from "@/components/rooms/MinorsRoomWarning";
import AdultInviteSheet from "@/components/rooms/AdultInviteSheet";
import TeenHostNote from "@/components/rooms/TeenHostNote";
import StartRoomFlow from "@/components/rooms/create/StartRoomFlow";
import { NotStartedPanel, RoomCodePanel } from "@/components/rooms/RoomStatePanels";
import type { AdultInvite } from "@/lib/minorsRoomApi";
import type { RoomVoice, ScreenTrack } from "@/hooks/useRoomVoice";
import { roomReducer, type RoomState } from "@/lib/roomReducer";
import { FIXTURE_HOST, FIXTURE_INVITES, FIXTURE_IDS, FIXTURE_NAMES, FIXTURE_ROOM, fixtureControlsState, fixtureLiveState, fixtureStartView, parseControlsFixture, parseFixtureQuery } from "@/lib/roomFixtures";

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
      if (/^\/api\/rooms\/fixture-room\/members\/[^/]+\/actions/.test(path)) return json({ actions: { interact: true, dm: false, invite: false, profile: true } });
      if (/^\/api\/rooms\/fixture-room\/report/.test(path)) return json({ ok: true });
      if (path.startsWith("/api/rooms/fixture-room/adult-invites")) return json(init?.method && init.method !== "GET" ? { ok: true } : { invites: FIXTURE_INVITES.active });
      if (path === "/api/blocks") return json({ blocked: [] });
      if (path === "/api/rooms/config") return json({ features: { paidRooms: false, spray: false }, limits: {}, currency: "NGN", region: "NG" });
      if (path.startsWith("/api/users/search")) return json([]);
      if (/^\/api\/users\/[^/]+\/follow-stats/.test(path)) return json({ followersCount: 128, followingCount: 64 });
      if (/^\/api\/users\/[^/?]+$/.test(path)) return json({ bio: "Fixture profile. Nothing here is real." });
      return real(input, init);
    }) as typeof window.fetch;
    return () => { window.fetch = real; };
  }, []);
}

/** The minors' room screens that are not the room shell: the two warnings, the adult invite sheet and the teen host note. */
function MinorsFixture({ scene, theme }: { scene: "refuse" | "ack" | "invites" | "teennote"; theme: "dark" | "light" }) {
  useFixtureFetch();
  const was = useRef<boolean | null>(null);
  useEffect(() => {
    const root = document.documentElement;
    if (was.current === null) was.current = root.classList.contains("dark");
    root.classList.toggle("dark", theme === "dark");
    return () => { root.classList.toggle("dark", was.current === true); };
  }, [theme]);
  const [revoked, setRevoked] = useState<Map<string, AdultInvite>>(() => new Map([[FIXTURE_INVITES.revoked.user.id, FIXTURE_INVITES.revoked]]));
  const [open, setOpen] = useState(true);
  return (
    <div className="min-h-screen bg-background font-sans text-foreground" data-testid="room-fixture" data-scene={scene}>
      <main className="mx-auto max-w-2xl space-y-4 px-4 py-4">
        {scene === "refuse" && <MinorsRoomWarning code="MINORS_ROOM" roomId={FIXTURE_ROOM.id} onAcknowledged={async () => true} />}
        {scene === "ack" && <MinorsRoomWarning code="MINORS_ROOM_ACK" roomId={FIXTURE_ROOM.id} onAcknowledged={async () => true} />}
        {scene === "teennote" && <TeenHostNote onDismiss={() => {}} />}
        {scene === "invites" && (
          <>
            <button type="button" className="min-h-[44px] rounded-lg border px-4" onClick={() => setOpen(true)}>Invite an adult</button>
            <AdultInviteSheet open={open} onOpenChange={setOpen} roomId={FIXTURE_ROOM.id} revoked={revoked} onRevokedChange={setRevoked} />
          </>
        )}
      </main>
    </div>
  );
}

/**
 * The create-a-room wizard as an adult (25) or a teen (15) host. Every endpoint it calls is answered in the page; a
 * "created" room is the fixture room, so going live lands on /rooms/fixture-room (which is not faked).
 */
function WizardFixture({ as, theme }: { as: "adult" | "teen"; theme: "dark" | "light" }) {
  // A layout effect, not a plain effect: it runs before any child's passive effects, and React Query only starts a
  // request from those (its store subscription). With useEffect here the children's first requests reached the real server.
  useLayoutEffect(() => {
    const real = window.fetch;
    const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(window.location.origin, "");
      const method = (init?.method ?? "GET").toUpperCase();
      if (path === "/api/csrf-token") return json({ csrfToken: "fixture" });
      if (path === "/api/users/me/room-privacy") return json({ roomPrivacy: {}, age: as === "teen" ? 15 : 25 });
      if (path === "/api/users/me/age-verification") return json({ verified: false, band: null, at: null, method: null });
      if (path === "/api/rooms/config") return json({ features: { paidRooms: false, spray: false }, limits: {}, currency: "NGN", region: "NG", host: { accountAgeDays: 400, minAccountAgeDays: 7 } });
      if (path === "/api/events/my-events" || path === "/api/my-venues") return json([]);
      if (path === "/api/rooms" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { visibility?: string };
        return json({ room: { id: FIXTURE_ROOM.id }, ...(body.visibility === "invite" ? { inviteLink: `/rooms/${FIXTURE_ROOM.id}?token=fixture` } : {}) }, 201);
      }
      if (/^\/api\/rooms\/fixture-room\/(start|voice|live-video)$/.test(path)) return json({ ok: true });
      return real(input, init);
    }) as typeof window.fetch;
    return () => { window.fetch = real; };
  }, [as]);
  useEffect(() => {
    const root = document.documentElement;
    const was = root.classList.contains("dark");
    root.classList.toggle("dark", theme === "dark");
    return () => { root.classList.toggle("dark", was); };
  }, [theme]);
  const [open, setOpen] = useState(true);
  const startBtn = useRef<HTMLButtonElement>(null);
  return (
    <div className="min-h-screen bg-background font-sans text-foreground" data-testid="room-fixture" data-scene={`wizard-${as}`}>
      <main className="mx-auto max-w-2xl px-4 py-4">
        <button ref={startBtn} type="button" className="min-h-[44px] rounded-lg border px-4" onClick={() => setOpen(true)}>Start a room</button>
        <StartRoomFlow open={open} onOpenChange={setOpen} returnFocusTo={() => startBtn.current} />
      </main>
    </div>
  );
}

const STATE_SCENES = ["notstarted", "full", "kicked", "banned", "ended", "locked"] as const;

/** The room state screens (not started, full, removed, banned, ended, locked) on their own, with no network. */
function StateFixture({ scene, theme }: { scene: (typeof STATE_SCENES)[number]; theme: "dark" | "light" }) {
  useFixtureFetch();
  useEffect(() => {
    const real = window.fetch;
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/csrf-token")) return Promise.resolve(new Response(JSON.stringify({ csrfToken: "fixture" }), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (/\/api\/rooms\/fixture-room\/reminder/.test(url)) return Promise.resolve(new Response(JSON.stringify({ reminder: init?.method !== "DELETE" }), { status: 200, headers: { "Content-Type": "application/json" } }));
      return real(input, init);
    }) as typeof window.fetch;
    return () => { window.fetch = real; };
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    const was = root.classList.contains("dark");
    root.classList.toggle("dark", theme === "dark");
    return () => { root.classList.toggle("dark", was); };
  }, [theme]);
  const soon = new Date(Date.now() + (2 * 86400 + 3 * 3600) * 1000).toISOString();
  const start = new Date(Date.now() - 43 * 60000).toISOString();
  return (
    <div className="min-h-screen bg-background font-sans text-foreground" data-testid="room-fixture" data-scene={scene}>
      <main className="mx-auto max-w-2xl space-y-4 px-4 py-4">
        {scene === "notstarted"
          ? <NotStartedPanel room={{ id: FIXTURE_ROOM.id, title: "Open mic: poetry night", visibility: "public", scheduledFor: soon }} hostName="Kemi" />
          : <RoomCodePanel code={{ full: "ROOM_FULL", kicked: "KICKED", banned: "BANNED", ended: "ROOM_ENDED", locked: "ROOM_LOCKED" }[scene]} kickRemainingMs={scene === "kicked" ? 9 * 60000 : null} room={scene === "ended" ? { startedAt: start, endedAt: new Date().toISOString(), peakCount: 43 } : null} onRetry={() => {}} />}
      </main>
    </div>
  );
}

export default function RoomFixture() {
  const opts = useMemo(() => parseFixtureQuery(window.location.search), []);
  const wizard = new URLSearchParams(window.location.search).get("wizard");
  if (wizard === "adult" || wizard === "teen") return <WizardFixture as={wizard} theme={opts.theme} />;
  const stateScene = new URLSearchParams(window.location.search).get("state");
  if (stateScene && (STATE_SCENES as readonly string[]).includes(stateScene)) return <StateFixture scene={stateScene as (typeof STATE_SCENES)[number]} theme={opts.theme} />;
  if (opts.minors && opts.minors !== "listen") return <MinorsFixture scene={opts.minors} theme={opts.theme} />;
  return <ShellFixture opts={opts} />;
}

function ShellFixture({ opts }: { opts: ReturnType<typeof parseFixtureQuery> }) {
  const controls = useMemo(() => parseControlsFixture(window.location.search), []);
  const [state, dispatch] = useReducer((s: RoomState, e: Ev) => roomReducer(s, e), undefined, () =>
    controls ? fixtureControlsState(controls) : fixtureLiveState(opts.scene, { as: opts.as, now: Date.now(), invite: opts.invite }));
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
  // Controls fixture: the fakes answer like the server would, a moment later, through the same reducer events.
  const later = (e: Ev) => { setTimeout(() => dispatch(e), 300); };
  const sock: RoomShellSocket = {
    chat: (text, replyTo) => { dispatch({ type: "room:chat", userId: self, text, at: Date.now(), ...(replyTo ? { replyTo } : {}) }); return true; },
    react: (emoji) => { dispatch({ type: "room:react", userId: self, emoji, at: Date.now() }); return true; },
    interact: ok, setScreen: ok, sendPlayback: ok,
    mod: (action, targetId) => { later(action === "mute" || action === "unmute" ? { type: "room:mod", action, targetId } : { type: "room:left", userId: targetId }); return true; },
    stageAction: (action, targetId) => {
      if (targetId && (action === "accept" || action === "remove")) {
        const stage = action === "accept" ? [...state.stage.filter((x) => x !== targetId), targetId] : state.stage.filter((x) => x !== targetId);
        later({ type: "room:stage", stage, hands: state.hands.filter((x) => x !== targetId) });
      }
      return true;
    },
    liveAction: (action, targetId) => {
      if (action === "grant" && targetId) later({ type: "room:live", holder: targetId, asks: state.asks.filter((x) => x !== targetId) });
      if ((action === "revoke" || action === "stop") && targetId) later({ type: "room:live", holder: null, asks: state.asks });
      return true;
    },
    setVoice: async (on) => { later({ type: "room:voice", enabled: on }); return true; },
    setLiveVideo: async (on) => { later({ type: "room:livevideo", enabled: on }); return true; },
    saveSettings: async (patch) => {
      const cur = state.room ?? {};
      const next = {
        pinnedMessage: "pinnedMessage" in patch ? patch.pinnedMessage ?? null : ((cur as { pinnedMessage?: string | null }).pinnedMessage ?? null),
        slowModeSec: patch.slowModeSec ?? ((cur as { slowModeSec?: number }).slowModeSec ?? 0),
        locked: patch.locked ?? ((cur as { locked?: boolean }).locked ?? false),
      };
      if (controls === "cohost" && ("slowModeSec" in patch || "locked" in patch)) return "Only the host can change that."; // what the server answers
      later({ type: "room:settings", ...next });
      return null;
    },
    setRole: async (targetId, role) => { later({ type: "room:mod", action: "role", targetId, role }); return null; },
    endRoom: async () => { later({ type: "room:ended" }); return null; },
    dismissInvite: () => {},
  };

  return (
    <div className="font-sans" data-testid="room-fixture" data-scene={opts.scene}>
      <RoomShell
        id={FIXTURE_ROOM.id}
        room={opts.minors === "listen" ? { ...FIXTURE_ROOM, minorsRoom: true } : FIXTURE_ROOM}
        host={FIXTURE_HOST}
        fallbackCount={state.memberCount}
        isHost={controls ? controls === "host" : opts.as === "host"}
        role={controls ?? (opts.as === "host" ? "host" : "guest")}
        meId={self}
        state={state}
        sock={sock}
        voice={voice}
        myRoomId={null}
        nav={<div className="border-b px-4 py-3 text-sm text-muted-foreground">App navigation (fixture stand-in)</div>}
        hostControls={<p className="text-sm text-muted-foreground">Room settings (fixture stand-in)</p>}
        onLeave={() => window.history.back()}
        startView={fixtureStartView(opts.scene)}
        startControlsOpen={!!controls}
        listenOnly={opts.minors === "listen"}
        listenLine={opts.minors === "listen"}
      />
    </div>
  );
}
