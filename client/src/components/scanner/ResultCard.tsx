import { format } from "date-fns";
import { AlertTriangle, Check, WifiOff, X } from "lucide-react";
import type { ScanOutcome } from "./scannerApi";

type Tone = "ok" | "bad" | "warn";

const toneClass: Record<Tone, { box: string; badge: string; title: string; bar: string }> = {
  ok: { box: "border-emerald-400 bg-emerald-950/80", badge: "bg-emerald-400 text-black", title: "text-emerald-300", bar: "bg-emerald-400" },
  bad: { box: "border-red-400 bg-red-950/80", badge: "bg-red-400 text-black", title: "text-red-300", bar: "bg-red-400" },
  warn: { box: "border-amber-400 bg-amber-950/80", badge: "bg-amber-400 text-black", title: "text-amber-300", bar: "bg-amber-400" },
};

export interface ResultView { tone: Tone; icon: "check" | "x" | "alert" | "wifi"; title: string; who: string; details: string[]; tag?: string }

/** What to say for each outcome. Colour is never the only signal: every state has its own icon and words. */
export function describeOutcome(o: ScanOutcome): ResultView {
  switch (o.type) {
    case "admitted":
      return { tone: "ok", icon: "check", title: "Admitted", who: o.holderName, details: o.tierName ? [o.tierName] : [] };
    case "already_used":
      return {
        tone: "bad", icon: "x", title: "Already used", who: o.holderName ?? "This ticket",
        details: [
          o.checkedInAt ? `Checked in at ${format(new Date(o.checkedInAt), "HH:mm")}` : "Already checked in",
          ...(o.byName ? [`by ${o.byName}`] : []),
        ],
      };
    case "wrong_event":
      return { tone: "warn", icon: "alert", title: "Wrong night", who: o.ticketLabel ? `Ticket is for ${o.ticketLabel}` : "Ticket is for a different event", details: [...(o.ticketDate ? [format(new Date(o.ticketDate), "EEE d MMM")] : []), "Not valid tonight"] };
    case "not_confirmed":
      return { tone: "bad", icon: "x", title: "Not valid", who: o.message, details: ["Do not admit"] };
    case "not_found":
      return { tone: "bad", icon: "x", title: "Invalid ticket", who: "Code not recognised", details: ["Try again, or type the code"] };
    case "ambiguous":
      return { tone: "warn", icon: "alert", title: "Type more", who: "More than one ticket matches", details: ["Enter the full code or scan the QR"] };
    case "auth":
      return { tone: "warn", icon: "alert", title: "Session ended", who: o.message, details: ["Ask your organiser for a new code"] };
    case "network":
      return { tone: "warn", icon: "wifi", title: "No connection", who: "Scanning is paused", details: ["Reconnect to keep admitting guests"] };
  }
}

const icons = { check: Check, x: X, alert: AlertTriangle, wifi: WifiOff };

/** Large result card shown over the camera. Clears itself after `ms`; tap to dismiss early. */
export default function ResultCard({ outcome, ms, vip, onDismiss, onUndo }: {
  outcome: ScanOutcome;
  /** 0 keeps it open until dismissed (offline, session ended). */
  ms: number;
  vip?: boolean;
  onDismiss: () => void;
  onUndo?: () => void;
}) {
  const v = describeOutcome(outcome);
  const c = toneClass[v.tone];
  const Icon = icons[v.icon];
  return (
    <div className="absolute inset-x-0 bottom-0 z-20 p-3" role="status" aria-live="assertive" data-testid="scan-result" data-outcome={outcome.type}>
      <div className={`flex flex-col gap-2.5 rounded-[20px] border-2 p-4 text-white ${c.box}`}>
        <div className="flex items-center gap-3">
          <span className={`grid h-14 w-14 flex-none place-items-center rounded-full ${c.badge}`}><Icon className="h-8 w-8" strokeWidth={2.75} /></span>
          <div className="min-w-0 flex-1">
            <h2 className={`text-[28px] font-semibold uppercase leading-none tracking-wide ${c.title}`} data-testid="scan-result-title">{v.title}</h2>
            <p className="mt-1 truncate text-xl font-semibold" data-testid="scan-result-who">
              {v.who}
              {vip && <span className={`ml-2 rounded-full border px-2.5 py-px align-middle text-xs font-semibold uppercase tracking-wider ${c.title} border-current`}>VIP</span>}
            </p>
          </div>
          <button type="button" onClick={onDismiss} className="grid h-11 w-11 flex-none place-items-center rounded-full bg-white/10" aria-label="Dismiss result">
            <X className="h-5 w-5" />
          </button>
        </div>
        {v.details.length > 0 && <p className="flex flex-wrap gap-x-3.5 gap-y-1 text-sm text-white/80">{v.details.map((d) => <span key={d}>{d}</span>)}</p>}
        {outcome.type === "admitted" && onUndo && (
          <button type="button" onClick={onUndo} className="self-start rounded-full border border-white/30 px-4 py-2 text-sm font-medium" data-testid="button-undo-admit">
            Wrong person? Undo
          </button>
        )}
        {ms > 0 && (
          <div className="h-1 overflow-hidden rounded-full bg-white/15" aria-hidden="true">
            <div className={`h-full ${c.bar}`} style={{ animation: `scan-drain ${ms}ms linear forwards` }} />
          </div>
        )}
      </div>
      <style>{"@keyframes scan-drain{from{width:100%}to{width:0}}@media (prefers-reduced-motion:reduce){[data-testid=scan-result] [style*=scan-drain]{animation:none!important}}"}</style>
    </div>
  );
}
