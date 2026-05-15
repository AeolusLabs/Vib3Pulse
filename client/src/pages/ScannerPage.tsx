import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Html5Qrcode } from "html5-qrcode";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Camera, CheckCircle2, XCircle, Loader2, LogOut, ScanLine, ShieldCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import type { User } from "@shared/schema";

const STORAGE_KEY = "vib3_scanner_token";

type ScannerSession = {
  scannerToken: string;
  eventId: string;
  eventTitle: string;
  staffName: string;
  expiresAt: string;
};

type ScanResult = {
  success: boolean;
  message: string;
  attendeeName?: string;
};

// ── Organizer view: redirect them to the proper dashboard ─────────────────────
function OrganizerRedirect() {
  const [, navigate] = useLocation();
  useEffect(() => {
    navigate("/manage-events");
  }, [navigate]);
  return (
    <div className="min-h-screen flex items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}

// ── Staff scanner view ────────────────────────────────────────────────────────
function StaffScannerView({ session, onLogout }: { session: ScannerSession; onLogout: () => void }) {
  const { toast } = useToast();
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanCount, setScanCount] = useState(0);
  const scannerRef = useRef<Html5Qrcode | null>(null);

  const startScanning = async () => {
    try {
      const scanner = new Html5Qrcode("staff-qr-reader");
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        async (decodedText) => {
          stopScanning();
          await validateTicket(decodedText);
        },
        undefined,
      );
      setIsScanning(true);
    } catch {
      toast({ title: "Camera Error", description: "Unable to access camera.", variant: "destructive" });
    }
  };

  const stopScanning = async () => {
    if (scannerRef.current) {
      try { await scannerRef.current.stop(); } catch { /* ignore */ }
      scannerRef.current = null;
      setIsScanning(false);
    }
  };

  const validateTicket = async (validationCode: string) => {
    try {
      const res = await fetch("/api/tickets/validate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Scanner-Token": session.scannerToken,
        },
        body: JSON.stringify({ validationCode, eventId: session.eventId }),
      });
      const data = await res.json();

      if (data.valid && !data.alreadyCheckedIn) {
        const name = data.ticket?.user?.displayName || data.ticket?.user?.username || "";
        setScanResult({ success: true, message: "Valid ticket", attendeeName: name });
        setScanCount((c) => c + 1);
        toast({ title: "✓ Admitted", description: name || "Ticket validated" });
      } else if (data.alreadyCheckedIn) {
        setScanResult({ success: false, message: "Already used" });
        toast({ title: "Already Checked In", description: data.message, variant: "destructive" });
      } else {
        setScanResult({ success: false, message: data.message || "Invalid ticket" });
        toast({ title: "Invalid Ticket", description: data.message, variant: "destructive" });
      }
    } catch {
      setScanResult({ success: false, message: "Network error" });
      toast({ title: "Error", description: "Could not reach server", variant: "destructive" });
    }
    setTimeout(() => setScanResult(null), 3000);
  };

  useEffect(() => () => { stopScanning(); }, []);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <div className="border-b px-4 py-3 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <span className="font-semibold">Staff Scanner</span>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5 truncate max-w-[220px]">{session.eventTitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{session.staffName}</Badge>
          <Badge variant="outline">{scanCount} scanned</Badge>
          <Button variant="ghost" size="icon" onClick={onLogout} title="Exit scanner">
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <main className="flex-1 container px-4 py-6 max-w-lg mx-auto space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ScanLine className="h-5 w-5" />
              Scan Tickets
            </CardTitle>
            <CardDescription>
              Expires {format(new Date(session.expiresAt), "h:mm a")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div id="staff-qr-reader" className={isScanning ? "block rounded-md overflow-hidden" : "hidden"} />

            {!isScanning && (
              <div className="flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-md">
                <Camera className="h-12 w-12 text-muted-foreground mb-4" />
                <Button onClick={startScanning} data-testid="button-staff-start-scan">
                  <Camera className="h-4 w-4 mr-2" />
                  Start Scanner
                </Button>
              </div>
            )}

            {isScanning && (
              <Button variant="destructive" onClick={stopScanning} className="w-full" data-testid="button-staff-stop-scan">
                Stop Scanner
              </Button>
            )}

            {scanResult && (
              <div
                className={`p-4 rounded-md border flex items-start gap-3 ${
                  scanResult.success
                    ? "bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800"
                    : "bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800"
                }`}
                data-testid="staff-scan-result"
              >
                {scanResult.success ? (
                  <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0" />
                ) : (
                  <XCircle className="h-5 w-5 text-red-600 flex-shrink-0" />
                )}
                <div>
                  <p className={`font-medium ${scanResult.success ? "text-green-900 dark:text-green-100" : "text-red-900 dark:text-red-100"}`}>
                    {scanResult.message}
                  </p>
                  {scanResult.attendeeName && (
                    <p className="text-sm text-muted-foreground mt-0.5">{scanResult.attendeeName}</p>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

// ── Code entry form ───────────────────────────────────────────────────────────
function CodeEntryForm({ onAuthenticated }: { onAuthenticated: (session: ScannerSession) => void }) {
  const { toast } = useToast();
  const [staffName, setStaffName] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== 6 || !/^\d{6}$/.test(code)) {
      toast({ title: "Invalid code", description: "Enter the 6-digit code from your organiser.", variant: "destructive" });
      return;
    }
    if (!staffName.trim()) {
      toast({ title: "Name required", description: "Enter your name so the organiser can track your scans.", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/scanner/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, staffName: staffName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: "Error", description: data.message || "Failed to authenticate", variant: "destructive" });
        return;
      }
      const session: ScannerSession = {
        scannerToken: data.scannerToken,
        eventId: data.eventId,
        eventTitle: data.eventTitle,
        staffName: data.staffName,
        expiresAt: data.expiresAt,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      onAuthenticated(session);
    } catch {
      toast({ title: "Network error", description: "Could not reach server.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <ShieldCheck className="h-10 w-10 text-primary" />
          </div>
          <CardTitle>Staff Check-In</CardTitle>
          <CardDescription>Enter your name and the code from your organiser to start scanning.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="staff-name">Your Name</Label>
              <Input
                id="staff-name"
                placeholder="e.g. Maria"
                value={staffName}
                onChange={(e) => setStaffName(e.target.value)}
                autoComplete="name"
                data-testid="input-staff-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="staff-code">6-Digit Code</Label>
              <Input
                id="staff-code"
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                maxLength={6}
                data-testid="input-staff-code"
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading} data-testid="button-staff-login">
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Activate Scanner
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ScannerPage() {
  const [session, setSession] = useState<ScannerSession | null>(null);
  const [verified, setVerified] = useState(false);

  const { data: authUser } = useQuery<User>({
    queryKey: ["/api/auth/session"],
    retry: false,
  });

  // On mount, check localStorage for an existing scanner session and verify it
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) { setVerified(true); return; }
    try {
      const parsed: ScannerSession = JSON.parse(stored);
      // Quick expiry check client-side first
      if (new Date() > new Date(parsed.expiresAt)) {
        localStorage.removeItem(STORAGE_KEY);
        setVerified(true);
        return;
      }
      // Verify with server
      fetch("/api/scanner/verify", {
        headers: { "X-Scanner-Token": parsed.scannerToken },
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.valid) {
            setSession(parsed);
          } else {
            localStorage.removeItem(STORAGE_KEY);
          }
        })
        .catch(() => { localStorage.removeItem(STORAGE_KEY); })
        .finally(() => setVerified(true));
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      setVerified(true);
    }
  }, []);

  const handleLogout = () => {
    localStorage.removeItem(STORAGE_KEY);
    setSession(null);
  };

  if (!verified) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // Organizer session → send them to their dashboard
  if (authUser && (authUser as any).userType === "organizer") {
    return <OrganizerRedirect />;
  }

  // Valid staff token → scanner
  if (session) {
    return <StaffScannerView session={session} onLogout={handleLogout} />;
  }

  // No session → code entry
  return <CodeEntryForm onAuthenticated={setSession} />;
}
