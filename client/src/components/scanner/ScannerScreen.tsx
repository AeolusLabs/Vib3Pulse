import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraOff, Flashlight, FlipHorizontal2, Keyboard, List, Loader2, Volume2, VolumeX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import ResultCard from "./ResultCard";
import ManualCodeSheet from "./ManualCodeSheet";
import DoorLog from "./DoorLog";
import { useQrCamera } from "./useQrCamera";
import { isMuted, primeAudio, setMuted, signal } from "./feedback";
import { fetchLog, fetchStats, undoCheckIn, validateTicket, type DoorStats, type LogEntry, type ScanOutcome, type ScannerIdentity } from "./scannerApi";

const REGION_ID = "vp-scan-region";
// The same QR held in front of the camera must not be submitted again straight away.
const SAME_CODE_COOLDOWN_MS = 5000;
const STATS_REFRESH_MS = 15000;

interface ScannerScreenProps {
  identity: ScannerIdentity;
  eventTitle: string;
  /** Staff only: shown under the title. */
  staffName?: string;
  expiresAt?: string;
  /** Leave the scanner (staff: end session; organiser: back to the dashboard). */
  onExit: () => void;
  /** Called when the server says this scanner session is over. */
  onSessionEnded?: () => void;
}

interface Shown { id: number; outcome: ScanOutcome; ms: number }

/**
 * The door scanner, used by staff and organisers. The camera stays on between guests; a large result
 * card appears over it and clears itself, so admitting someone takes one scan and no taps.
 */
export default function ScannerScreen({ identity, eventTitle, staffName, expiresAt, onExit, onSessionEnded }: ScannerScreenProps) {
  const { toast } = useToast();
  const [shown, setShown] = useState<Shown | null>(null);
  const [stats, setStats] = useState<DoorStats | null>(null);
  const [serverLog, setServerLog] = useState<LogEntry[]>([]);
  const [rejects, setRejects] = useState<LogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [logLoading, setLogLoading] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualBusy, setManualBusy] = useState(false);
  const [muted, setMutedState] = useState(isMuted());
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [started, setStarted] = useState(false);
  const [lastAdmit, setLastAdmit] = useState<{ ticketId: string; holderName: string } | null>(null);

  const busy = useRef(false);
  const last = useRef<{ text: string; at: number } | null>(null);
  const counter = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onlineRef = useRef(online);
  onlineRef.current = online;

  const refreshStats = useCallback(async () => {
    const s = await fetchStats(identity);
    if (s) setStats(s);
  }, [identity]);

  const refreshLog = useCallback(async () => {
    setLogLoading(true);
    setServerLog(await fetchLog(identity));
    setLogLoading(false);
  }, [identity]);

  useEffect(() => {
    void refreshStats();
    const id = setInterval(() => { if (document.visibilityState === "visible") void refreshStats(); }, STATS_REFRESH_MS);
    return () => clearInterval(id);
  }, [refreshStats]);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const show = useCallback((outcome: ScanOutcome, ms: number) => {
    clearTimer();
    counter.current += 1;
    setShown({ id: counter.current, outcome, ms });
    if (ms > 0) timer.current = setTimeout(() => setShown(null), ms);
  }, []);
  useEffect(() => clearTimer, []);

  const run = useCallback(async (request: () => Promise<ScanOutcome>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const outcome = await request();
      if (outcome.type === "admitted") {
        signal("ok");
        setLastAdmit(outcome.ticketId ? { ticketId: outcome.ticketId, holderName: outcome.holderName } : null);
        show(outcome, outcome.ticketId ? 3500 : 2500);
        void refreshStats();
      } else {
        signal(outcome.type === "wrong_event" || outcome.type === "ambiguous" || outcome.type === "network" || outcome.type === "auth" ? "warn" : "reject");
        const hold = outcome.type === "network" || outcome.type === "auth" ? 0 : 4500;
        show(outcome, hold);
        if (outcome.type === "auth") onSessionEnded?.();
        if (outcome.type !== "network" && outcome.type !== "auth") {
          setRejects((r) => [{
            id: `local-${Date.now()}`,
            action: "reject" as const,
            holderName: outcome.type === "already_used" ? outcome.holderName ?? "Ticket" : outcome.type === "not_found" ? "Unknown code" : "Ticket",
            detail: outcome.type === "already_used" ? "Already used" : outcome.type === "wrong_event" ? "Wrong night" : outcome.type === "not_confirmed" ? "Not valid" : "Not recognised",
            createdAt: new Date().toISOString(),
          }, ...r].slice(0, 20));
        }
      }
    } finally {
      busy.current = false;
    }
  }, [show, refreshStats, onSessionEnded]);

  const onDecode = useCallback((text: string) => {
    if (!text.trim()) return;
    if (!onlineRef.current) { show({ type: "network" }, 0); return; }
    const now = Date.now();
    if (last.current && last.current.text === text && now - last.current.at < SAME_CODE_COOLDOWN_MS) return;
    last.current = { text, at: now };
    void run(() => validateTicket(identity, { scanned: text }));
  }, [identity, run, show]);

  const camera = useQrCamera(REGION_ID, onDecode);

  // Test seam: lets automated tests feed a decoded QR without a physical camera. Absent from production builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as any).__vpScan = (text: string) => onDecode(text);
    return () => { delete (window as any).__vpScan; };
  }, [onDecode]);

  const begin = async () => {
    primeAudio();
    setStarted(true);
    // Wait a tick so the scan region exists in the DOM before the camera attaches to it.
    setTimeout(() => void camera.start(), 0);
  };

  const submitManual = async (code: string) => {
    if (!onlineRef.current) { show({ type: "network" }, 0); setManualOpen(false); return; }
    setManualBusy(true);
    await run(() => validateTicket(identity, { typed: code }));
    setManualBusy(false);
    setManualOpen(false);
  };

  const undo = async (ticketId: string, name: string) => {
    const ok = await undoCheckIn(identity, ticketId);
    setShown(null);
    clearTimer();
    toast({ title: ok ? "Check-in undone" : "Couldn't undo", description: ok ? `${name} can be scanned again.` : "Only recent check-ins can be undone by door staff. Ask the organiser.", variant: ok ? undefined : "destructive" });
    if (ok) { setLastAdmit(null); void refreshStats(); void refreshLog(); }
  };

  const logEntries = [...rejects, ...serverLog].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)).slice(0, 40);
  const isOrganiser = !identity.token;
  // An admit can be undone once: hide the button when a later undo for the same ticket is already in the log.
  const canUndoRow = (e: LogEntry) =>
    e.action === "admit" &&
    !!e.ticketId &&
    !logEntries.some((o) => o.action === "undo" && o.ticketId === e.ticketId && +new Date(o.createdAt) >= +new Date(e.createdAt)) &&
    (isOrganiser || Date.now() - +new Date(e.createdAt) < 10 * 60_000);

  const toggleMute = () => { const next = !muted; setMuted(next); setMutedState(next); };

  return (
    <div className="flex h-dvh flex-col bg-[#0a090c] text-[#f4f3f7]" data-testid="scanner-screen">
      <header className="flex flex-shrink-0 items-center gap-2.5 px-3 pb-2 pt-3">
        <div className="min-w-0 flex-1 leading-tight">
          <b className="block truncate font-semibold" data-testid="text-scanner-title">{eventTitle}</b>
          <small className="text-[13px] text-[#a9a5b6]">{staffName ? `${staffName}${expiresAt ? ` · expires ${format(new Date(expiresAt), "h:mm a")}` : ""}` : "Organiser"}</small>
        </div>
        <button type="button" onClick={toggleMute} className="grid h-11 w-11 place-items-center rounded-xl border border-[#34313c] bg-[#1a1920]" aria-label={muted ? "Turn sound on" : "Turn sound off"} aria-pressed={muted} data-testid="button-mute">
          {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
        </button>
        <button type="button" onClick={() => { void camera.stop(); onExit(); }} className="grid h-11 w-11 place-items-center rounded-xl border border-[#34313c] bg-[#1a1920]" aria-label="Exit scanner" data-testid="button-exit-scanner">
          <X className="h-5 w-5" />
        </button>
      </header>

      <div className="flex flex-shrink-0 gap-2 px-3" data-testid="scanner-counters">
        <div className="flex-1 rounded-xl border border-[#34313c] bg-[#14131a] px-3 py-2">
          <small className="block text-[11px] uppercase tracking-[0.1em] text-[#a9a5b6]">Admitted</small>
          <b className="text-[22px] font-semibold tabular-nums" data-testid="count-admitted">{stats ? stats.admitted : "–"}</b>
          {stats && <em className="ml-1 text-[13px] not-italic text-[#a9a5b6]">of {stats.capacity ?? stats.total}</em>}
        </div>
        {stats?.mine != null && (
          <div className="flex-1 rounded-xl border border-[#34313c] bg-[#14131a] px-3 py-2">
            <small className="block text-[11px] uppercase tracking-[0.1em] text-[#a9a5b6]">You</small>
            <b className="text-[22px] font-semibold tabular-nums" data-testid="count-mine">{stats.mine}</b>
          </div>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        {!online && (
          <p className="absolute inset-x-3 top-3 z-10 flex items-center gap-2 rounded-xl border border-amber-400 bg-amber-950/90 px-3 py-2 text-sm" data-testid="banner-scanner-offline">
            No connection. Scanning is paused until you are back online.
          </p>
        )}
        {/* The camera attaches to this element; it stays mounted so the video keeps running between guests. */}
        <div id={REGION_ID} className={`h-full w-full [&_video]:h-full [&_video]:w-full [&_video]:object-cover ${camera.running ? "" : "invisible"}`} />

        {!started && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <div className="flex max-w-xs flex-col items-center gap-4">
              <Camera className="h-12 w-12 text-[#a9a5b6]" />
              <p className="text-[#c9c5d4]">Point the camera at each guest's QR code. No buttons between guests.</p>
              <Button className="h-12 px-8 text-base font-semibold" onClick={begin} data-testid="button-start-scanning">Start scanning</Button>
            </div>
          </div>
        )}
        {started && !camera.running && !camera.problem && (
          <div className="absolute inset-0 grid place-items-center"><Loader2 className="h-8 w-8 animate-spin text-[#a9a5b6]" /></div>
        )}
        {camera.problem && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center" data-testid="camera-problem">
            <div className="flex max-w-xs flex-col items-center gap-3">
              <CameraOff className="h-12 w-12 text-[#a9a5b6]" />
              <p className="font-semibold">{camera.problem === "denied" ? "Camera access is blocked" : camera.problem === "none" ? "No camera found" : "The camera would not start"}</p>
              <p className="text-sm text-[#a9a5b6]">
                {camera.problem === "denied" ? "Allow the camera for this site in your browser settings, then try again. You can still admit guests by typing their code." : "You can still admit guests by typing their code."}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" className="h-11 border-[#34313c] bg-[#1a1920] text-[#f4f3f7]" onClick={() => void camera.start()}>Try again</Button>
                <Button className="h-11" onClick={() => setManualOpen(true)}>Type a code</Button>
              </div>
            </div>
          </div>
        )}
        {started && camera.running && !shown && (
          <p className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-sm text-[#a9a5b6]">Point at the QR code</p>
        )}

        {shown && (
          <ResultCard
            key={shown.id}
            outcome={shown.outcome}
            ms={shown.ms}
            vip={shown.outcome.type === "admitted" && /vip/i.test(shown.outcome.tierName ?? "")}
            onDismiss={() => { clearTimer(); setShown(null); }}
            onUndo={shown.outcome.type === "admitted" && lastAdmit ? () => void undo(lastAdmit.ticketId, lastAdmit.holderName) : undefined}
          />
        )}
      </div>

      <nav className="grid flex-shrink-0 grid-cols-4 gap-2 bg-[#0a090c] px-3 pb-4 pt-2.5" aria-label="Scanner tools">
        {[
          { label: "Type code", icon: Keyboard, onClick: () => setManualOpen(true), disabled: false, id: "button-type-code" },
          { label: camera.torchOn ? "Light on" : "Light", icon: Flashlight, onClick: () => void camera.toggleTorch(), disabled: !camera.torchSupported, id: "button-torch" },
          { label: "Flip", icon: FlipHorizontal2, onClick: () => void camera.flip(), disabled: !camera.canFlip, id: "button-flip-camera" },
          { label: "Log", icon: List, onClick: () => { setLogOpen(true); void refreshLog(); }, disabled: false, id: "button-open-log" },
        ].map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={b.onClick}
            disabled={b.disabled}
            className="flex min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-xl border border-[#34313c] bg-[#1a1920] px-1 text-[13px] font-semibold transition-transform active:scale-[0.97] disabled:opacity-40"
            data-testid={b.id}
          >
            <b.icon className="h-5 w-5" />{b.label}
          </button>
        ))}
      </nav>

      <ManualCodeSheet open={manualOpen} onOpenChange={setManualOpen} onSubmit={submitManual} busy={manualBusy} />
      <DoorLog
        open={logOpen}
        onOpenChange={setLogOpen}
        entries={logEntries}
        loading={logLoading}
        canUndo={canUndoRow}
        onUndo={(e) => e.ticketId && void undo(e.ticketId, e.holderName)}
      />
    </div>
  );
}
