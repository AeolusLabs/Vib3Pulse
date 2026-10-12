import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Loader2, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ensureCsrfToken } from "@/lib/queryClient";
import ScannerScreen from "@/components/scanner/ScannerScreen";
import StaffLogin, { type RedeemResult } from "@/components/scanner/StaffLogin";
import type { ScanKind } from "@/components/scanner/scannerApi";
import type { User } from "@shared/schema";

const STORAGE_KEY = "vib3_scanner_token";
const FULL_CODE = /^[0-9a-f]{64}$/i;

type ScannerSession = {
  scannerToken: string;
  eventId: string;
  eventTitle: string;
  staffName: string;
  expiresAt: string;
  kind: ScanKind;
};

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center">{children}</div>;
}

/**
 * /scanner: for door staff who open the organiser's link with a code in it. A 6-digit code only works on
 * the event's own check-in page (it needs to know which event), so without a link this page explains where to go.
 */
export default function ScannerPage() {
  const [, navigate] = useLocation();
  const [session, setSession] = useState<ScannerSession | null>(null);
  const [checking, setChecking] = useState(true);
  const linkCode = useMemo(() => {
    const c = new URLSearchParams(window.location.search).get("code") ?? "";
    return FULL_CODE.test(c) ? c : undefined;
  }, []);

  const { data: authUser } = useQuery<User>({ queryKey: ["/api/auth/session"], retry: false });

  // Resume a session saved on this phone, if the server still accepts it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const saved: ScannerSession = JSON.parse(raw);
        if (new Date() > new Date(saved.expiresAt)) { localStorage.removeItem(STORAGE_KEY); return; }
        const res = await fetch("/api/scanner/verify", { headers: { "X-Scanner-Token": saved.scannerToken } });
        const data = await res.json();
        if (data.valid && !cancelled) {
          setSession({ ...saved, eventId: data.eventId ?? saved.eventId, kind: data.type === "venue-event" ? "venue" : "event" });
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch {
        try { localStorage.removeItem(STORAGE_KEY); } catch { /* nothing to clear */ }
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const redeem = useCallback(async (staffName: string): Promise<RedeemResult> => {
    try {
      const res = await fetch("/api/scanner/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": await ensureCsrfToken() },
        credentials: "include",
        body: JSON.stringify({ code: linkCode, staffName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, reason: data.reason ?? (res.status === 429 ? "locked" : undefined), message: data.message ?? "" };
      const next: ScannerSession = { scannerToken: data.scannerToken, eventId: data.eventId, eventTitle: data.eventTitle, staffName: data.staffName, expiresAt: data.expiresAt, kind: "event" };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* works for this visit only */ }
      setSession(next);
      return { ok: true };
    } catch {
      return { ok: false, message: "Could not reach the server. Check your connection and try again." };
    }
  }, [linkCode]);

  const leave = useCallback(() => {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* nothing saved */ }
    setSession(null);
  }, []);

  if (checking) return <Centered><Loader2 className="h-8 w-8 animate-spin text-primary" /></Centered>;

  // An organiser session belongs on the dashboard, not here.
  if (authUser && (authUser as any).userType === "organizer" && !session) {
    navigate("/manage-events");
    return <Centered><Loader2 className="h-8 w-8 animate-spin text-primary" /></Centered>;
  }

  if (session) {
    return (
      <ScannerScreen
        identity={{ kind: session.kind, eventId: session.eventId, token: session.scannerToken }}
        eventTitle={session.eventTitle || "Door check-in"}
        staffName={session.staffName}
        expiresAt={session.expiresAt}
        onExit={leave}
        onSessionEnded={leave}
      />
    );
  }

  if (linkCode) return <StaffLogin linkCode={linkCode} onRedeem={(name) => redeem(name)} />;

  return (
    <Centered>
      <span className="grid h-16 w-16 place-items-center rounded-full bg-primary/10"><QrCode className="h-7 w-7 text-primary" /></span>
      <h1 className="font-serif text-3xl font-bold">Door check-in</h1>
      <p className="max-w-xs text-muted-foreground">Open the check-in link your organiser sent you, or scan their staff QR code. Then enter your name and the 6-digit code.</p>
      <Button variant="outline" className="h-11" onClick={() => navigate("/login")}>I'm the organiser</Button>
    </Centered>
  );
}
