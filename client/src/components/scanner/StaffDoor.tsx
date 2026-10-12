import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { ensureCsrfToken } from "@/lib/queryClient";
import ScannerScreen from "./ScannerScreen";
import StaffLogin, { type RedeemResult, type StaffSecret } from "./StaffLogin";
import type { ScanKind } from "./scannerApi";

interface StaffSession {
  scannerToken: string;
  eventId: string;
  eventTitle: string;
  staffName: string;
  expiresAt: string;
}

const storageKey = (kind: ScanKind, id: string) => (kind === "event" ? `vib3_scanner_${id}` : `vib3_scanner_venue_${id}`);
const redeemPath = (kind: ScanKind, id: string) =>
  kind === "event" ? `/api/events/${id}/staff-access/validate` : `/api/venue-events/${id}/staff-access/validate`;

const FULL_CODE = /^[0-9a-f]{64}$/i;

/**
 * Everything door staff see for one event or venue night: sign in with the 6-digit code (or the
 * organiser's link), then the scanner. The session lives on the phone until it expires or is revoked.
 */
export default function StaffDoor({ kind, targetId, title, urlCode, onOrganiser }: {
  kind: ScanKind;
  targetId: string;
  /** Event or night title, when the page already knows it. */
  title?: string;
  /** `?code=` from the organiser's link. Only the long (64 character) form is accepted here. */
  urlCode?: string;
  onOrganiser?: () => void;
}) {
  const [session, setSession] = useState<StaffSession | null>(null);
  const [checking, setChecking] = useState(true);
  const linkCode = useMemo(() => (urlCode && FULL_CODE.test(urlCode) ? urlCode : undefined), [urlCode]);

  // Resume a session saved on this phone, but only after the server confirms it is still good.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const key = storageKey(kind, targetId);
      try {
        const raw = localStorage.getItem(key);
        if (raw) {
          const saved: StaffSession = JSON.parse(raw);
          const fresh = saved.scannerToken && saved.eventId === targetId && new Date() < new Date(saved.expiresAt);
          if (fresh) {
            const res = await fetch("/api/scanner/verify", { headers: { "X-Scanner-Token": saved.scannerToken }, credentials: "include" });
            const data = res.ok ? await res.json() : null;
            if (data?.valid && data.eventId === targetId) {
              if (!cancelled) setSession(saved);
              return;
            }
          }
          localStorage.removeItem(key);
        }
      } catch {
        try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => { cancelled = true; };
  }, [kind, targetId]);

  const redeem = useCallback(async (staffName: string, secret: StaffSecret): Promise<RedeemResult> => {
    try {
      const csrf = await ensureCsrfToken();
      const res = await fetch(redeemPath(kind, targetId), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrf },
        credentials: "include",
        body: JSON.stringify({ staffName, ...secret }),
      });
      const data = await res.json().catch(() => ({}));
      // The global rate limiter answers 429 without a reason; treat it like the per-event lockout.
      if (!res.ok) return { ok: false, reason: data.reason ?? (res.status === 429 ? "locked" : undefined), message: data.message ?? "" };
      const next: StaffSession = {
        scannerToken: data.scannerToken,
        eventId: data.eventId,
        eventTitle: data.eventTitle ?? title ?? "",
        staffName: data.staffName,
        expiresAt: data.expiresAt,
      };
      try { localStorage.setItem(storageKey(kind, targetId), JSON.stringify(next)); } catch { /* works for this visit only */ }
      setSession(next);
      return { ok: true };
    } catch {
      return { ok: false, message: "Could not reach the server. Check your connection and try again." };
    }
  }, [kind, targetId, title]);

  const leave = useCallback(() => {
    try { localStorage.removeItem(storageKey(kind, targetId)); } catch { /* nothing saved */ }
    setSession(null);
  }, [kind, targetId]);

  if (checking) {
    return <div className="grid min-h-dvh place-items-center"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }
  if (session) {
    return (
      <ScannerScreen
        identity={{ kind, eventId: targetId, token: session.scannerToken }}
        eventTitle={session.eventTitle || title || "Door check-in"}
        staffName={session.staffName}
        expiresAt={session.expiresAt}
        onExit={leave}
        onSessionEnded={leave}
      />
    );
  }
  return <StaffLogin eventTitle={title} linkCode={linkCode} onRedeem={redeem} onOrganiser={onOrganiser} />;
}
