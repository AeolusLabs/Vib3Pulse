// Dev-only: renders the REAL room shell (RoomShell: top bar, picture, chat log, dock, tray, rail, sheets) from seeded state.
// No room socket and no LiveKit: socket actions feed a local reducer, the picture is a canvas, and the few room endpoints the
// sheets read are answered in the page. The app around it (auth, notifications) still makes its usual requests.
// Query: ?scene=voice|live|immersive|weak|dropped &theme=dark|light &as=guest|holder|host &sound=1 (sound only)
// &tap=1 (audio waits for a tap) &invite=1 (invited to speak) &flood=300 (chat lines over ten seconds).
// &minors=refuse|ack|invites|listen|teennote shows the minors' room screens (listen is the room shell seen as an adult).
// ?wizard=adult|teen shows the Start a room sheet and the create wizard for that host, with every endpoint answered here.
// &controls=host|cohost opens the Controls sheet as the host or a co-host (requests waiting, settings set; saves settle locally).
// ?edge=micdenied|micbusy|micmissing|camdenied|cambusy|cammissing|reconnecting shows the edge states of flows board 11 in the shell;
// ?spray=unavailable|offline are the spray ones. Weak signal is ?scene=weak, the room-full / removed / banned / ended panels are ?state=...
// ?ticket=page|checkout|confirmed|waiting|hostsales|price|refund shows the paid room screens (task 4.7), every call answered here.
// ?wizard=adult&paid=1 runs the wizard with paidRooms on and an ID-verified host, so the Paid room switch and price step show.
// ?spray=tray|confirm|bank|declined|limit|quiet opens the spray flow (phase 5) in an 18+ room as a verified adult guest,
// every spray endpoint answered here: a note or bundle lands after a moment, bag and rain go to a stand-in bank page.
// ?game=versus|team|drop|teen shows the gamers-live stage (flag on, every control answered by the shared game rules in the page).
// ?earn=empty|week|clawback|noaccount|mismatch|soon|attention &page=earnings|payouts|payments shows the room money screens (phase 6).
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
import { applyGame, type GameAction, type GameView, type Side } from "@shared/gameScreen";
import { soundFeed, type Follow } from "@/lib/gameScreen";
import type { GameTracks } from "@/hooks/useGameTracks";
import { FIXTURE_HOST, FIXTURE_INVITES, FIXTURE_IDS, FIXTURE_NAMES, FIXTURE_ROOM, fixtureControlsState, fixtureLiveState, fixtureStartView, parseControlsFixture, parseEdgeFixture, parseFixtureQuery, fixtureGameState, parseGameFixture, type EdgeScene, type GameScene } from "@/lib/roomFixtures";
import {
  FIXTURE_TICKET, FIXTURE_TICKET_BLOCK, FIXTURE_TICKET_PRICE_KOBO, FIXTURE_TICKET_REF, fixtureTicketRoom, fixtureTicketSummary, parseTicketFixture, type TicketScene,
} from "@/lib/roomFixtures";
import TicketPage from "@/components/rooms/tickets/TicketPage";
import Checkout from "@/components/rooms/tickets/Checkout";
import TicketConfirmed from "@/components/rooms/tickets/TicketConfirmed";
import WaitingRoom from "@/components/rooms/tickets/WaitingRoom";
import RefundButton from "@/components/rooms/tickets/RefundButton";
import HostSales, { HostSalesBody } from "@/components/rooms/tickets/HostSales";
import StepPrice from "@/components/rooms/create/StepPrice";
import { PRICE_COPY, defaultTicketDraft, parseSummary, type TicketDraft } from "@/lib/roomTickets";
import type { RoomTicketView } from "@/lib/roomsApi";
import { FIXTURE_SPRAY_BLOCK, fixtureSprayChatText, fixtureSprayMe, fixtureSprayStart, parseSprayFixture, type SprayScene } from "@/lib/sprayFixtures";
import { mediaLineFor } from "@/lib/mediaIssues";
import { SPRAY_CATALOGUE, isSprayTier, type SprayTier } from "@shared/money";
import EarningsFixture from "./EarningsFixture";
import { parseEarnFixture } from "@/components/rooms/earnings/earningsFixtures";

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

/** A moving canvas in its own colour, so two game feeds can be told apart in the fixture. */
function gameCanvasTrack(hue: number, label: string): ScreenTrack & { stop(): void } {
  const c = document.createElement("canvas");
  c.width = 640; c.height = 360;
  const g = c.getContext("2d")!;
  let f = 0;
  const draw = () => {
    f++;
    g.fillStyle = `hsl(${hue} 45% 14%)`; g.fillRect(0, 0, 640, 360);
    g.fillStyle = `hsl(${hue} 60% 40%)`; g.fillRect(40 + ((f * 6) % 520), 250, 60, 60);
    g.fillStyle = "#f7f7f7"; g.font = "600 28px sans-serif"; g.fillText(label, 24, 48);
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

/** Stand-in for useGameTracks: a coloured canvas per player, follow and sound kept locally. */
function useFixtureGameTracks(game: GameView | null): GameTracks {
  const cache = useRef(new Map<string, ScreenTrack & { stop(): void }>());
  useEffect(() => { const m = cache.current; return () => { m.forEach((t) => t.stop()); m.clear(); }; }, []);
  const [following, setFollowing] = useState<Follow>({});
  const [pick, setPick] = useState<string | null>(null);
  const trackFor = (id: string) => {
    let t = cache.current.get(id);
    if (!t) { t = gameCanvasTrack((cache.current.size * 67 + 250) % 360, FIXTURE_NAMES[id] ?? id); cache.current.set(id, t); }
    return t;
  };
  return {
    startShare: async () => {}, stopShare: () => {}, sharing: false, shareError: null, trackFor,
    follow: (side: Side, id: string) => setFollowing((f) => ({ ...f, [side]: id })),
    unfollow: (side: Side) => setFollowing((f) => { const { [side]: _x, ...rest } = f; return rest; }),
    following, soundId: game ? soundFeed(game, following, pick) : null, setSound: setPick, reportWidth: () => {},
  };
}

/** Answers the endpoints the room sheets read, inside the page. Everything else goes to the real fetch. */
function useFixtureFetch(gaming = false) {
  // Layout effect: a child's query effect runs before the parent's plain effect, so its first request would reach the real fetch.
  useLayoutEffect(() => {
    const real = window.fetch;
    const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(window.location.origin, "");
      if (/^\/api\/rooms\/fixture-room\/members\/[^/]+\/actions/.test(path)) return json({ actions: { interact: true, dm: false, invite: false, profile: true } });
      if (/^\/api\/rooms\/fixture-room\/report/.test(path)) return json({ ok: true });
      if (path.startsWith("/api/rooms/fixture-room/adult-invites")) return json(init?.method && init.method !== "GET" ? { ok: true } : { invites: FIXTURE_INVITES.active });
      if (path === "/api/blocks") return json({ blocked: [] });
      if (path === "/api/rooms/config") return json({ features: { paidRooms: false, spray: false, ...(gaming ? { gaming: true } : {}) }, ...(gaming ? { game: { ingest: true, teamSpray: true, lanes: false } } : {}), limits: {}, currency: "NGN", region: "NG" });
      if (path.startsWith("/api/users/search")) return json([]);
      if (/^\/api\/users\/[^/]+\/follow-stats/.test(path)) return json({ followersCount: 128, followingCount: 64 });
      if (/^\/api\/users\/[^/?]+$/.test(path)) return json({ bio: "Fixture profile. Nothing here is real." });
      return real(input, init);
    }) as typeof window.fetch;
    return () => { window.fetch = real; };
  }, [gaming]);
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
function WizardFixture({ as, theme, paid = false }: { as: "adult" | "teen"; theme: "dark" | "light"; paid?: boolean }) {
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
      if (path === "/api/users/me/age-verification") return json(paid && as === "adult" ? { verified: true, band: "adult", at: "2026-10-01T00:00:00.000Z", method: "admin" } : { verified: false, band: null, at: null, method: null });
      if (path === "/api/rooms/config") return json({ features: { paidRooms: paid, spray: false }, limits: {}, currency: "NGN", region: "NG", host: { accountAgeDays: 400, minAccountAgeDays: 7 } });
      if (path === "/api/events/my-events" || path === "/api/my-venues") return json([]);
      if (path === "/api/rooms" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { visibility?: string };
        return json({ room: { id: FIXTURE_ROOM.id }, ...(body.visibility === "invite" ? { inviteLink: `/rooms/${FIXTURE_ROOM.id}?token=fixture` } : {}) }, 201);
      }
      if (/^\/api\/rooms\/fixture-room\/(start|voice|live-video)$/.test(path)) return json({ ok: true });
      return real(input, init);
    }) as typeof window.fetch;
    return () => { window.fetch = real; };
  }, [as, paid]);
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

/**
 * The paid room screens with no network: a fake fetch is installed in a layout effect, which runs before any child's
 * effects (React Query and the verify call both start from those), so nothing reaches the real server. Get ticket moves
 * to the checkout scene instead of leaving the page; verify answers after a short pause so the progress screen shows.
 */
function TicketFixture({ scene: first, theme }: { scene: TicketScene; theme: "dark" | "light" }) {
  useLayoutEffect(() => {
    const real = window.fetch;
    const json = (body: unknown, status = 200, delay = 0) => new Promise<Response>((res) =>
      setTimeout(() => res(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })), delay));
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(window.location.origin, "");
      const base = "/api/rooms/fixture-paid-room";
      if (path === "/api/csrf-token") return json({ csrfToken: "fixture" });
      if (path === `${base}/tickets/checkout`) return json({ url: `${window.location.origin}/dev/room-fixture?ticket=checkout`, reference: FIXTURE_TICKET_REF }, 200, 400);
      if (path === `${base}/tickets/verify`) return json({ ticket: FIXTURE_TICKET }, 200, 900);
      if (path === `${base}/tickets/refund`) return json({ result: "refunded", settled: true }, 200, 500);
      if (path === `${base}/tickets/summary`) return json(fixtureTicketSummary(), 200, 300);
      if (path === `${base}/cancel`) return json({ ok: true }, 200, 400);
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
  const [scene, setScene] = useState<TicketScene>(first);
  const [ticket, setTicket] = useState<RoomTicketView>(FIXTURE_TICKET);
  const [draft, setDraft] = useState<TicketDraft>(() => ({ ...defaultTicketDraft(), on: true }));
  // The start time is read once, here, so the countdown runs from a fixed point (12 minutes 8 seconds, as in the board).
  const [startsAt] = useState(() => Date.now() + (12 * 60 + 8) * 1000);
  const far = scene === "page" || scene === "checkout" || scene === "confirmed";
  const room = fixtureTicketRoom(new Date(far ? startsAt + 3 * 86_400_000 : startsAt).toISOString());
  const later = (ms: number) => new Date(startsAt + ms).toISOString();
  return (
    <div className="min-h-screen bg-background font-sans text-foreground" data-testid="room-fixture" data-scene={`ticket-${scene}`}>
      <main className="mx-auto max-w-md space-y-4 px-4 py-4">
        {scene === "page" && <TicketPage room={room} host={FIXTURE_HOST} ticket={FIXTURE_TICKET_BLOCK} go={() => setScene("checkout")} />}
        {scene === "checkout" && <Checkout roomId={room.id} reference={FIXTURE_TICKET_REF} onVerified={(t) => { setTicket(t); setScene("confirmed"); }} onBack={() => setScene("page")} />}
        {scene === "confirmed" && <TicketConfirmed ticket={ticket} room={room} hostName="Maya Okafor" onContinue={() => setScene("waiting")} />}
        {scene === "waiting" && <WaitingRoom room={room} hostName="Maya Okafor" priceKobo={FIXTURE_TICKET_PRICE_KOBO} onRecheck={() => {}} onRefunded={() => {}} />}
        {scene === "refund" && (
          <>
            <p className="text-sm text-muted-foreground">Window open (starts in 2 days):</p>
            <RefundButton room={{ ...room, scheduledFor: later(2 * 86_400_000) }} priceKobo={FIXTURE_TICKET_PRICE_KOBO} onRefunded={() => {}} />
            <p className="text-sm text-muted-foreground">Window closed (starts in 12 minutes):</p>
            <RefundButton room={room} priceKobo={FIXTURE_TICKET_PRICE_KOBO} onRefunded={() => {}} />
            <p className="text-sm text-muted-foreground">Host turned refunds off:</p>
            <RefundButton room={{ ...room, scheduledFor: later(2 * 86_400_000), refundBeforeStart: false }} priceKobo={FIXTURE_TICKET_PRICE_KOBO} onRefunded={() => {}} />
          </>
        )}
        {scene === "hostsales" && (
          <>
            <h1 className="text-lg font-semibold">Tickets</h1>
            <HostSalesBody summary={parseSummary(fixtureTicketSummary())!} capacity={room.ticketCapacity} />
            <HostSales room={room} capacity={room.ticketCapacity} onChanged={() => {}} />
          </>
        )}
        {scene === "price" && (
          <>
            <h1 className="font-serif text-3xl font-bold">{PRICE_COPY.title}</h1>
            <StepPrice draft={draft} set={(p) => setDraft((d) => ({ ...d, ...p }))} error={null} />
          </>
        )}
      </main>
    </div>
  );
}

export default function RoomFixture() {
  const opts = useMemo(() => parseFixtureQuery(window.location.search), []);
  const wizard = new URLSearchParams(window.location.search).get("wizard");
  if (wizard === "adult" || wizard === "teen") return <WizardFixture as={wizard} theme={opts.theme} paid={new URLSearchParams(window.location.search).get("paid") === "1"} />;
  const earn = parseEarnFixture(window.location.search);
  if (earn) return <EarningsFixture scene={earn.scene} page={earn.page} theme={opts.theme} />;
  const ticketScene = parseTicketFixture(window.location.search);
  if (ticketScene) return <TicketFixture scene={ticketScene} theme={opts.theme} />;
  const stateScene = new URLSearchParams(window.location.search).get("state");
  if (stateScene && (STATE_SCENES as readonly string[]).includes(stateScene)) return <StateFixture scene={stateScene as (typeof STATE_SCENES)[number]} theme={opts.theme} />;
  if (opts.minors && opts.minors !== "listen") return <MinorsFixture scene={opts.minors} theme={opts.theme} />;
  const sprayScene = parseSprayFixture(window.location.search);
  const edge = parseEdgeFixture(window.location.search);
  // The camera sheets need the live-video room; every other edge scene keeps the scene the query asked for.
  const shellOpts = edge?.startsWith("cam") && opts.scene === "voice" ? { ...opts, scene: "live" as const } : opts;
  return <ShellFixture opts={shellOpts} spray={sprayScene} edge={edge} game={parseGameFixture(window.location.search)} />;
}

function ShellFixture({ opts, spray = null, edge = null, game = null }: { opts: ReturnType<typeof parseFixtureQuery>; spray?: SprayScene | null; edge?: EdgeScene | null; game?: GameScene | null }) {
  const controls = useMemo(() => parseControlsFixture(window.location.search), []);
  const [state, dispatch] = useReducer((s: RoomState, e: Ev) => roomReducer(s, e), undefined, () =>
    controls ? fixtureControlsState(controls)
      : game ? fixtureGameState(game, fixtureLiveState("live", { as: opts.as, now: Date.now(), invite: opts.invite }), Date.now())
      : fixtureLiveState(opts.scene, { as: opts.as, now: Date.now(), invite: opts.invite }));
  const was = useRef<boolean | null>(null);
  useFixtureFetch(!!game);
  const gameTracks = useFixtureGameTracks(state.game);

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

  // Edge states: the connection drop is the reducer's own event; the media ones are the hook's own inline lines.
  useEffect(() => { if (edge === "reconnecting") dispatch({ type: "client:reconnecting" }); }, [edge]);
  const edgeLine = edge && edge !== "reconnecting" ? mediaLineFor(edge.startsWith("mic") ? "mic" : "camera", edge.endsWith("denied") ? "denied" : edge.endsWith("busy") ? "busy" : "missing") : null;

  // Spray scenes: every spray endpoint answered here, in a layout effect so it is in place before any child's request.
  // A delivered spray arrives as the server would send it: room:spray plus a normal chat line.
  const sprayStart = useMemo(() => (spray ? fixtureSprayStart(spray, Date.now(), window.location.origin) : null), [spray]);
  const sprayMe = useRef(fixtureSprayMe());
  const [sprayBlock, setSprayBlock] = useState(FIXTURE_SPRAY_BLOCK);
  useLayoutEffect(() => {
    if (!spray) return;
    const real = window.fetch;
    let n = 0;
    const polls = new Map<string, { tier: SprayTier; polls: number; done: boolean }>([["fx-spray-bank", { tier: "bag", polls: 0, done: false }]]);
    const land = (id: string, tier: SprayTier) => {
      dispatch({ type: "room:spray", id, tier, v3c: SPRAY_CATALOGUE[tier].v3c, fromId: FIXTURE_IDS.self, toId: FIXTURE_IDS.host, at: Date.now() });
      // Word for word what the server sends (a system receipt line, never a typed message).
      dispatch({ type: "room:chat", userId: FIXTURE_IDS.self, text: fixtureSprayChatText(tier, FIXTURE_NAMES[FIXTURE_IDS.host] ?? "Maya Okafor"), at: Date.now(), system: "spray" });
    };
    const json = (body: unknown, status = 200, delay = 250) => new Promise<Response>((res) =>
      setTimeout(() => res(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })), delay));
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(window.location.origin, "");
      const method = (init?.method ?? "GET").toUpperCase();
      const base = "/api/rooms/fixture-room/spray";
      if (path === "/api/csrf-token") return json({ csrfToken: "fixture" }, 200, 0);
      if (path === "/api/users/me/spray" && method === "GET") return json(sprayMe.current);
      if (path === "/api/users/me/spray/daily-limit" && method === "PUT") {
        const k = Number(JSON.parse(String(init?.body ?? "{}")).kobo);
        sprayMe.current = { ...sprayMe.current, dailyLimitKobo: k };
        return json({ dailyLimitKobo: k });
      }
      if (path === "/api/users/me/spray/method" && method === "DELETE") { sprayMe.current = { ...sprayMe.current, method: null }; return json({ ok: true }); }
      if (path === `${base}/limit` && method === "PUT") {
        const k = Number(JSON.parse(String(init?.body ?? "{}")).kobo);
        const next = { ...FIXTURE_SPRAY_BLOCK, roomLimitKobo: k };
        setTimeout(() => setSprayBlock(next), 0);
        return json({ limitKobo: k, spentKobo: 0 });
      }
      if (path === base && method === "POST") {
        const b = JSON.parse(String(init?.body ?? "{}")) as { tier?: unknown };
        const tier: SprayTier = isSprayTier(b.tier) ? b.tier : "note";
        if (spray === "declined") return json({ code: "PAYMENT_DECLINED", sprayId: `fx-spray-${++n}`, reason: "DECLINED", message: "Your card was not charged." }, 402, 600);
        const id = `fx-spray-${++n}`;
        if (tier === "bag" || tier === "rain" || !sprayMe.current.method) {
          polls.set(id, { tier, polls: 0, done: false });
          return json({ status: "action_required", sprayId: id, authorizationUrl: `${window.location.origin}/dev/room-fixture?spray=tray` }, 200, 600);
        }
        setTimeout(() => land(id, tier), 1200);
        return json({ status: "pending", sprayId: id }, 200, 600);
      }
      const m = path.match(/^\/api\/rooms\/fixture-room\/spray\/([^/?]+)$/);
      if (m && method === "GET") {
        const p = polls.get(m[1]);
        if (!p) return json({ status: "delivered" });
        p.polls++;
        if (p.polls < 3) return json({ status: "action_required" });
        if (!p.done) { p.done = true; land(m[1], p.tier); }
        return json({ status: "delivered" });
      }
      return real(input, init);
    }) as typeof window.fetch;
    // Quiet effects: one spray from someone else arrives, shown as a chip instead of the animation.
    const t = spray === "quiet" ? setTimeout(() => dispatch({ type: "room:spray", id: "fx-quiet-1", tier: "bundle", v3c: SPRAY_CATALOGUE.bundle.v3c, fromId: "fx-g1", toId: FIXTURE_IDS.host, at: Date.now() }), 900) : undefined;
    return () => { window.fetch = real; clearTimeout(t); };
  }, [spray]);

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
    error: null, micError: edge?.startsWith("mic") ? edgeLine : null,
    video: isHolder || audioOnly ? null : track,
    localVideo: isHolder ? track : null,
    cameraOn: isHolder && !!track,
    cameraError: edge?.startsWith("cam") ? edgeLine : null,
    reconnecting: false, comingBack: false,
    startCamera: async () => true, stopCamera: async () => {},
    onAir: isHolder, videoPaused: false, pauseVideo: async () => {}, resumeVideo: async () => {},
    audioOnly, setAudioOnly,
    linkQuality: opts.scene === "weak" ? "poor" : "good",
    linkPoorSince: opts.scene === "weak" ? Date.now() - 20_000 : null,
    room: null,
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
    // The server's job, played by the shared rules: the same answer a real room would give, a moment later.
    gameAction: (action: GameAction, extra: { targetId?: string; side?: Side; value?: number } = {}) => {
      const cur = state.game;
      if (!cur) return false;
      const role = controls ?? (opts.as === "host" ? "host" : "guest");
      const r = applyGame(cur, action, { actorId: self, actorRole: role, targetId: extra.targetId ?? self, targetPresent: true, targetEligible: true, gameOn: true, side: extra.side, value: extra.value });
      if (!r.ok) { later({ type: "room:notice", code: r.code }); return true; }
      const { away } = cur;
      later({ type: "room:game", game: { ...r.state, away } });
      return true;
    },
  };

  return (
    <div className="font-sans" data-testid="room-fixture" data-scene={opts.scene}>
      <RoomShell
        id={FIXTURE_ROOM.id}
        room={opts.minors === "listen" || game === "teen" ? { ...FIXTURE_ROOM, minorsRoom: true } : spray ? { ...FIXTURE_ROOM, ageLimit: "18+" as const } : FIXTURE_ROOM}
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
        spray={spray ? sprayBlock : null}
        sprayFixture={sprayStart ?? undefined}
        gameTracksFixture={state.game ? gameTracks : undefined}
      />
    </div>
  );
}
