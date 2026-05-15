import { useQuery, useMutation } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import QRCode from "qrcode";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Camera,
  CheckCircle2,
  XCircle,
  Loader2,
  ArrowLeft,
  Users,
  ShieldCheck,
  Plus,
  Trash2,
  LogOut,
  ScanLine,
  UserCheck,
  Copy,
  QrCode as QrCodeIcon,
  Download,
  Link as LinkIcon,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, ensureCsrfToken } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import { format } from "date-fns";
import type { Event, Ticket, User, EventStaffAccessCode } from "@shared/schema";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";

// ── Types ─────────────────────────────────────────────────────────────────────

type Mode = "detecting" | "code-entry" | "organizer" | "staff-scanner";

type StaffSession = {
  scannerToken: string;
  eventId: string;
  eventTitle: string;
  staffName: string;
  expiresAt: string;
};

type ScanResultState = {
  success: boolean;
  message: string;
  attendeeName?: string;
};

type TicketWithUser = Ticket & { user: User };

// ── Helpers ───────────────────────────────────────────────────────────────────

function storageKey(eventId: string) {
  return `vib3_scanner_${eventId}`;
}

// Staff ticket validation using scanner token instead of session auth
async function staffValidateTicket(
  validationCode: string,
  eventId: string,
  scannerToken: string,
): Promise<Response> {
  const csrf = await ensureCsrfToken();
  return fetch("/api/tickets/validate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrf,
      "X-Scanner-Token": scannerToken,
    },
    credentials: "include",
    body: JSON.stringify({ validationCode, eventId }),
  });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DetectingSpinner() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Loading check-in…</p>
      </div>
    </div>
  );
}

// Code entry form for bouncers — inline on the selection screen
function CodeEntryForm({
  eventId,
  onAuthenticated,
  defaultCode = "",
}: {
  eventId: string;
  onAuthenticated: (session: StaffSession) => void;
  defaultCode?: string;
}) {
  const { toast } = useToast();
  const [staffName, setStaffName] = useState("");
  const [code, setCode] = useState(defaultCode);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      toast({ title: "Invalid code", description: "Enter the 6-digit code from your organiser.", variant: "destructive" });
      return;
    }
    if (!staffName.trim()) {
      toast({ title: "Name required", description: "Enter your name so the organiser can track your scans.", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const csrf = await ensureCsrfToken();
      const res = await fetch(`/api/events/${eventId}/staff-access/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrf },
        credentials: "include",
        body: JSON.stringify({ code, staffName: staffName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: "Error", description: data.message || "Failed to authenticate", variant: "destructive" });
        return;
      }
      onAuthenticated({
        scannerToken: data.scannerToken,
        eventId: data.eventId,
        eventTitle: data.eventTitle,
        staffName: data.staffName,
        expiresAt: data.expiresAt,
      });
    } catch {
      toast({ title: "Network error", description: "Could not reach server.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 pt-2">
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
      <Button type="submit" className="w-full" disabled={loading} data-testid="button-staff-activate">
        {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <ShieldCheck className="h-4 w-4 mr-2" />}
        Activate Scanner
      </Button>
    </form>
  );
}

// Selection screen — shown when neither organiser nor staff token detected
function SelectionView({
  eventId,
  eventTitle,
  onAuthenticated,
}: {
  eventId: string;
  eventTitle?: string;
  onAuthenticated: (session: StaffSession) => void;
}) {
  // If organiser shared a URL with ?code=123456, pre-fill and auto-expand
  const urlCode = new URLSearchParams(window.location.search).get("code") ?? "";
  const [showCodeEntry, setShowCodeEntry] = useState(!!urlCode);
  const redirectUrl = `/login?redirect=${encodeURIComponent(`/events/${eventId}/check-in`)}`;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="border-b px-4 py-3 flex items-center gap-3">
        <ShieldCheck className="h-5 w-5 text-primary" />
        <div>
          <p className="font-semibold text-sm">Event Check-In</p>
          {eventTitle && <p className="text-xs text-muted-foreground truncate max-w-[240px]">{eventTitle}</p>}
        </div>
      </div>

      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-4">
          <div className="text-center mb-6">
            <h1 className="text-2xl font-serif font-bold">Who are you?</h1>
            <p className="text-muted-foreground text-sm mt-1">Select your role to continue</p>
          </div>

          {/* Organiser card */}
          <Card
            className="cursor-pointer hover:border-primary transition-colors"
            onClick={() => (window.location.href = redirectUrl)}
            data-testid="card-organizer"
          >
            <CardContent className="flex items-center gap-4 p-5">
              <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                <UserCheck className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-medium">I'm the organiser</p>
                <p className="text-xs text-muted-foreground">Sign in to manage check-ins and staff</p>
              </div>
            </CardContent>
          </Card>

          {/* Staff card */}
          <Card
            className={`transition-colors ${showCodeEntry ? "border-primary" : "cursor-pointer hover:border-primary"}`}
            data-testid="card-staff"
          >
            <CardContent className="p-5">
              <div
                className={`flex items-center gap-4 ${!showCodeEntry ? "cursor-pointer" : ""}`}
                onClick={() => !showCodeEntry && setShowCodeEntry(true)}
              >
                <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <ScanLine className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="font-medium">I'm staff / door</p>
                  <p className="text-xs text-muted-foreground">Enter your 6-digit code to start scanning</p>
                </div>
              </div>

              {showCodeEntry && (
                <CodeEntryForm eventId={eventId} onAuthenticated={onAuthenticated} defaultCode={urlCode} />
              )}
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}

// Staff scanner view — camera only, minimal UI
function StaffScannerView({
  session,
  onLogout,
  onRevoked,
}: {
  session: StaffSession;
  onLogout: () => void;
  onRevoked: () => void;
}) {
  const { toast } = useToast();
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResultState | null>(null);
  const [scanCount, setScanCount] = useState(0);
  const scannerRef = useRef<Html5Qrcode | null>(null);

  const stopScanning = async () => {
    if (scannerRef.current) {
      try { await scannerRef.current.stop(); } catch { /* ignore */ }
      scannerRef.current = null;
      setIsScanning(false);
    }
  };

  const startScanning = async () => {
    try {
      const scanner = new Html5Qrcode("staff-qr-reader");
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        async (decodedText) => {
          stopScanning();
          await handleScan(decodedText);
        },
        undefined,
      );
      setIsScanning(true);
    } catch {
      toast({ title: "Camera Error", description: "Unable to access camera. Check permissions.", variant: "destructive" });
    }
  };

  const handleScan = async (validationCode: string) => {
    try {
      const res = await staffValidateTicket(validationCode, session.eventId, session.scannerToken);

      // Token revoked — kick back to code entry
      if (res.status === 401) {
        toast({ title: "Access revoked", description: "Your scanner access has been revoked by the organiser.", variant: "destructive" });
        onRevoked();
        return;
      }

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
      setScanResult({ success: false, message: "Network error — try again" });
      toast({ title: "Error", description: "Could not reach server", variant: "destructive" });
    }
    setTimeout(() => setScanResult(null), 3000);
  };

  useEffect(() => () => { stopScanning(); }, []);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Staff header */}
      <div className="border-b px-4 py-3 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary flex-shrink-0" />
            <span className="font-semibold text-sm truncate">{session.eventTitle}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {session.staffName} · expires {format(new Date(session.expiresAt), "h:mm a")}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Badge variant="secondary">{scanCount} scanned</Badge>
          <Button variant="ghost" size="icon" onClick={onLogout} title="Exit scanner" data-testid="button-staff-logout">
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
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              id="staff-qr-reader"
              className={isScanning ? "block rounded-md overflow-hidden" : "hidden"}
              data-testid="staff-qr-reader"
            />

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

// Full organiser dashboard — all existing scanner, check-ins, and staff code panels
function OrganizerView({
  eventId,
  onSwitchToStaff,
}: {
  eventId: string;
  onSwitchToStaff: () => void;
}) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<{
    success: boolean;
    message: string;
    ticket?: Ticket & { user?: User };
  } | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);

  // Staff code QR state
  const [expandedQRs, setExpandedQRs] = useState<Set<string>>(new Set());
  const [qrDataUrls, setQrDataUrls] = useState<Record<string, string>>({});

  const handleToggleQR = async (sc: EventStaffAccessCode) => {
    if (!qrDataUrls[sc.id]) {
      const url = `${window.location.origin}/events/${eventId}/check-in?code=${sc.code}`;
      try {
        const dataUrl = await QRCode.toDataURL(url, { width: 280, margin: 2, errorCorrectionLevel: "M" });
        setQrDataUrls((prev) => ({ ...prev, [sc.id]: dataUrl }));
      } catch {
        toast({ title: "Error", description: "Could not generate QR code.", variant: "destructive" });
        return;
      }
    }
    setExpandedQRs((prev) => {
      const next = new Set(prev);
      next.has(sc.id) ? next.delete(sc.id) : next.add(sc.id);
      return next;
    });
  };

  const handleDownloadQR = (sc: EventStaffAccessCode) => {
    const dataUrl = qrDataUrls[sc.id];
    if (!dataUrl) return;
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `checkin-code-${sc.code}.png`;
    a.click();
  };

  const { data: event } = useQuery<Event>({
    queryKey: [`/api/events/${eventId}`],
    enabled: !!eventId,
  });

  const { data: checkIns, refetch: refetchCheckIns } = useQuery<TicketWithUser[]>({
    queryKey: [`/api/events/${eventId}/check-ins`],
    enabled: !!eventId,
  });

  const { data: staffCodes, refetch: refetchStaffCodes } = useQuery<EventStaffAccessCode[]>({
    queryKey: [`/api/events/${eventId}/staff-codes`],
    enabled: !!eventId,
  });

  const validateMutation = useMutation({
    mutationFn: async (validationCode: string) => {
      const response = await apiRequest("POST", "/api/tickets/validate", { validationCode, eventId });
      return response.json();
    },
    onSuccess: (data) => {
      setScanResult({ success: data.valid && !data.alreadyCheckedIn, message: data.message, ticket: data.ticket });
      if (data.valid && !data.alreadyCheckedIn) {
        toast({ title: "✓ Ticket Validated", description: "Check-in successful." });
        refetchCheckIns();
      } else {
        toast({
          title: data.alreadyCheckedIn ? "Already Checked In" : "Invalid Ticket",
          description: data.message,
          variant: "destructive",
        });
      }
      setTimeout(() => setScanResult(null), 3000);
    },
    onError: (error: any) => {
      const message = error.message || "Failed to validate ticket";
      setScanResult({ success: false, message });
      toast({ title: "Validation Error", description: message, variant: "destructive" });
      setTimeout(() => setScanResult(null), 3000);
    },
  });

  const generateCodeMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/events/${eventId}/staff-codes`, {});
      return response.json();
    },
    onSuccess: () => {
      refetchStaffCodes();
      toast({ title: "Code generated", description: "Share the 6-digit code with your staff." });
    },
    onError: () => toast({ title: "Error", description: "Failed to generate code.", variant: "destructive" }),
  });

  const revokeCodeMutation = useMutation({
    mutationFn: async (codeId: string) => {
      const response = await apiRequest("DELETE", `/api/events/${eventId}/staff-codes/${codeId}`, undefined);
      return response.json();
    },
    onSuccess: () => {
      refetchStaffCodes();
      toast({ title: "Code revoked", description: "Staff member can no longer scan." });
    },
    onError: () => toast({ title: "Error", description: "Failed to revoke code.", variant: "destructive" }),
  });

  const startScanning = async () => {
    try {
      const scanner = new Html5Qrcode("qr-reader");
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => { stopScanning(); validateMutation.mutate(decodedText); },
        undefined,
      );
      setIsScanning(true);
    } catch {
      toast({ title: "Camera Error", description: "Unable to access camera. Please check permissions.", variant: "destructive" });
    }
  };

  const stopScanning = async () => {
    if (scannerRef.current) {
      try { await scannerRef.current.stop(); } catch { /* ignore */ }
      scannerRef.current = null;
      setIsScanning(false);
    }
  };

  useEffect(() => () => { stopScanning(); }, []);

  const checkedInTickets = checkIns?.filter((t) => t.checkedInAt) || [];
  const totalTickets = checkIns?.length || 0;

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />

      <main className="container px-4 py-6 max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Button variant="ghost" size="sm" onClick={() => navigate("/manage-events")} data-testid="button-back">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Events
          </Button>
          <button
            onClick={onSwitchToStaff}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors underline-offset-2 hover:underline"
            data-testid="button-switch-to-staff"
          >
            Test staff mode
          </button>
        </div>

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-serif font-bold" data-testid="heading-check-in">
              Event Check-In
            </h1>
            {event && <p className="text-muted-foreground mt-1">{event.title}</p>}
          </div>
          <Badge variant="secondary" className="text-sm px-3 py-1" data-testid="badge-check-in-count">
            <Users className="h-4 w-4 mr-1" />
            {checkedInTickets.length} / {totalTickets} checked in
          </Badge>
        </div>

        {/* QR Scanner Card */}
        <Card>
          <CardHeader>
            <CardTitle>Scan Tickets</CardTitle>
            <CardDescription>Scan attendee QR codes to validate and check them in</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="relative">
              <div
                id="qr-reader"
                className={`${isScanning ? "block" : "hidden"} w-full rounded-md overflow-hidden`}
                data-testid="qr-reader"
              />
              {!isScanning && (
                <div className="flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-md">
                  <Camera className="h-12 w-12 text-muted-foreground mb-4" />
                  <p className="text-sm text-muted-foreground mb-4">Click below to start scanning tickets</p>
                  <Button onClick={startScanning} disabled={validateMutation.isPending} data-testid="button-start-scan">
                    <Camera className="h-4 w-4 mr-2" />
                    Start Scanner
                  </Button>
                </div>
              )}
            </div>

            {isScanning && (
              <Button variant="destructive" onClick={stopScanning} className="w-full" data-testid="button-stop-scan">
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
                data-testid="scan-result"
              >
                {scanResult.success ? (
                  <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0" />
                ) : (
                  <XCircle className="h-5 w-5 text-red-600 dark:text-red-400 flex-shrink-0" />
                )}
                <div className="flex-1">
                  <p className={`font-medium ${scanResult.success ? "text-green-900 dark:text-green-100" : "text-red-900 dark:text-red-100"}`}>
                    {scanResult.message}
                  </p>
                  {scanResult.ticket?.user && (
                    <p className="text-sm mt-1 text-muted-foreground">
                      {scanResult.ticket.user.displayName || scanResult.ticket.user.username}
                    </p>
                  )}
                </div>
              </div>
            )}

            {validateMutation.isPending && (
              <div className="flex items-center justify-center p-4">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <span className="ml-2">Validating ticket…</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Checked-In Attendees */}
        <Card>
          <CardHeader>
            <CardTitle>Checked-In Attendees</CardTitle>
            <CardDescription>
              {checkedInTickets.length} attendee{checkedInTickets.length !== 1 ? "s" : ""} checked in
            </CardDescription>
          </CardHeader>
          <CardContent>
            {checkedInTickets.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No attendees checked in yet</p>
            ) : (
              <div className="space-y-3">
                {checkedInTickets.map((ticket) => (
                  <div
                    key={ticket.id}
                    className="flex items-center justify-between p-3 rounded-md border"
                    data-testid={`checked-in-${ticket.id}`}
                  >
                    <div>
                      <p className="font-medium">{ticket.user.displayName || ticket.user.username}</p>
                      <p className="text-sm text-muted-foreground">
                        Checked in: {ticket.checkedInAt && format(new Date(ticket.checkedInAt), "h:mm a")}
                      </p>
                    </div>
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Staff Access Codes */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5" />
                  Staff Access
                </CardTitle>
                <CardDescription>
                  Generate a code per bouncer, share the link below, they open it and enter their code
                </CardDescription>
              </div>
              <Button
                size="sm"
                onClick={() => generateCodeMutation.mutate()}
                disabled={generateCodeMutation.isPending}
                data-testid="button-generate-staff-code"
              >
                {generateCodeMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4 mr-1" />
                )}
                New Code
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">

            {/* Shareable check-in link */}
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
              <LinkIcon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <p className="text-xs text-muted-foreground truncate flex-1 font-mono">
                {window.location.origin}/events/{eventId}/check-in
              </p>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 flex-shrink-0"
                title="Copy check-in link"
                data-testid="button-copy-checkin-link"
                onClick={() => {
                  navigator.clipboard.writeText(`${window.location.origin}/events/${eventId}/check-in`);
                  toast({ title: "Link copied", description: "Share this with your door staff." });
                }}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>

            {/* Code list */}
            {!staffCodes || staffCodes.length === 0 ? (
              <p className="text-center text-muted-foreground py-4 text-sm">
                No staff codes yet — click "New Code" to generate one
              </p>
            ) : (
              <div className="space-y-3">
                {staffCodes.map((sc) => (
                  <div key={sc.id} className="rounded-md border" data-testid={`staff-code-${sc.id}`}>

                    {/* Code row */}
                    <div className="flex items-center justify-between p-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span
                            className="font-mono text-xl font-bold tracking-[0.3em] cursor-pointer select-all"
                            title="Click to copy code"
                            onClick={() => {
                              navigator.clipboard.writeText(sc.code);
                              toast({ title: "Copied!", description: `Code ${sc.code} copied.` });
                            }}
                          >
                            {sc.code}
                          </span>
                          <Badge
                            variant={
                              sc.status === "active" ? "default" : sc.status === "revoked" ? "destructive" : "secondary"
                            }
                          >
                            {sc.status === "active" ? "Active" : sc.status === "revoked" ? "Revoked" : "Pending"}
                          </Badge>
                          {sc.scanCount > 0 && (
                            <span className="text-xs text-muted-foreground">{sc.scanCount} scanned</span>
                          )}
                        </div>
                        {sc.validatedBy ? (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {sc.validatedBy} · redeemed {sc.redeemedAt ? format(new Date(sc.redeemedAt), "h:mm a") : ""}
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Not yet used · expires {format(new Date(sc.expiresAt), "h:mm a")}
                          </p>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                        {sc.status !== "revoked" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title={expandedQRs.has(sc.id) ? "Hide QR" : "Show QR code to share"}
                            onClick={() => handleToggleQR(sc)}
                            data-testid={`button-qr-${sc.id}`}
                          >
                            <QrCodeIcon className="h-4 w-4" />
                          </Button>
                        )}
                        {sc.status !== "revoked" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive"
                            onClick={() => revokeCodeMutation.mutate(sc.id)}
                            disabled={revokeCodeMutation.isPending}
                            title="Revoke access"
                            data-testid={`button-revoke-${sc.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>

                    {/* Expanded QR section */}
                    {expandedQRs.has(sc.id) && qrDataUrls[sc.id] && (
                      <div className="border-t p-4 flex flex-col items-center gap-3 bg-muted/20">
                        <img
                          src={qrDataUrls[sc.id]}
                          alt={`QR code for staff code ${sc.code}`}
                          className="w-48 h-48 rounded-sm"
                          data-testid={`img-staff-qr-${sc.id}`}
                        />
                        <p className="text-xs text-center text-muted-foreground max-w-[220px]">
                          Bouncer scans this QR → opens check-in page → code pre-filled → enters name → starts scanning
                        </p>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleDownloadQR(sc)}
                            data-testid={`button-download-qr-${sc.id}`}
                          >
                            <Download className="h-4 w-4 mr-2" />
                            Download
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              navigator.clipboard.writeText(
                                `${window.location.origin}/events/${eventId}/check-in?code=${sc.code}`,
                              );
                              toast({ title: "Link copied", description: "Direct link with code pre-filled." });
                            }}
                            data-testid={`button-copy-code-link-${sc.id}`}
                          >
                            <Copy className="h-4 w-4 mr-2" />
                            Copy link
                          </Button>
                        </div>
                      </div>
                    )}

                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </main>

      <BottomNavigation />
    </div>
  );
}

// ── Main page — bulletproof mode detection ────────────────────────────────────

export default function EventCheckInPage() {
  const [, params] = useRoute("/events/:id/check-in");
  const eventId = params?.id;

  // Reactive auth state — resolved server-side via /api/auth/session
  const { data: authUser, isLoading: authLoading } = useAuth();

  const [mode, setMode] = useState<Mode>("detecting");
  const [staffSession, setStaffSession] = useState<StaffSession | null>(null);
  const [eventTitle, setEventTitle] = useState<string | undefined>();

  // Fetch event title for display on the selection screen (public, no auth)
  useEffect(() => {
    if (!eventId) return;
    fetch(`/api/events/${eventId}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((ev) => { if (ev?.title) setEventTitle(ev.title); })
      .catch(() => {});
  }, [eventId]);

  // ── Bulletproof mode detection ─────────────────────────────────────────────
  // Runs once auth settles. Uses a cancellation flag to prevent stale async
  // updates if the component unmounts during the detection sequence.
  useEffect(() => {
    if (authLoading || !eventId) return;

    let cancelled = false;

    async function detectMode() {
      // ① Organiser check: session user must be an organiser AND own this event.
      //    We make a fresh fetch here rather than trusting cached event data so
      //    that ownership is always verified against the server.
      if (authUser?.userType === "organizer" && authUser?.id) {
        try {
          const res = await fetch(`/api/events/${eventId}`, { credentials: "include" });
          if (!cancelled && res.ok) {
            const ev = await res.json();
            if (ev.organizerId === authUser.id) {
              if (ev.title) setEventTitle(ev.title);
              setMode("organizer");
              return;
            }
            // Logged in as organiser but doesn't own this event — fall through
          }
        } catch {
          // Network error — conservative fallback: do NOT grant organiser access
        }
      }

      if (cancelled) return;

      // ② Staff token check: read event-scoped localStorage entry, then verify
      //    with the server. Client-side expiry is a fast-path optimisation only;
      //    the server is the source of truth (it rejects revoked/expired tokens).
      const raw = localStorage.getItem(storageKey(eventId));
      if (raw) {
        try {
          const parsed: StaffSession = JSON.parse(raw);

          // Fast client-side expiry guard
          const notExpired = parsed.expiresAt && new Date() < new Date(parsed.expiresAt);
          const correctEvent = parsed.eventId === eventId;

          if (parsed.scannerToken && correctEvent && notExpired) {
            const verifyRes = await fetch("/api/scanner/verify", {
              headers: { "X-Scanner-Token": parsed.scannerToken },
              credentials: "include",
            });

            if (!cancelled && verifyRes.ok) {
              const data = await verifyRes.json();
              // Double-check eventId in server response — prevents token swap attacks
              if (data.valid && data.eventId === eventId) {
                setStaffSession(parsed);
                setMode("staff-scanner");
                return;
              }
            }
          }

          // Token invalid, expired, or mismatched — clear it
          localStorage.removeItem(storageKey(eventId));
        } catch {
          localStorage.removeItem(storageKey(eventId));
        }
      }

      if (!cancelled) setMode("code-entry");
    }

    detectMode();
    return () => { cancelled = true; };
  }, [authLoading, authUser, eventId]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleStaffAuthenticated = (session: StaffSession) => {
    localStorage.setItem(storageKey(eventId!), JSON.stringify(session));
    setStaffSession(session);
    setMode("staff-scanner");
  };

  const handleStaffLogout = () => {
    localStorage.removeItem(storageKey(eventId!));
    setStaffSession(null);
    setMode("code-entry");
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (mode === "detecting") return <DetectingSpinner />;

  if (mode === "organizer") {
    return <OrganizerView eventId={eventId!} onSwitchToStaff={() => setMode("code-entry")} />;
  }

  if (mode === "staff-scanner" && staffSession) {
    return (
      <StaffScannerView
        session={staffSession}
        onLogout={handleStaffLogout}
        onRevoked={handleStaffLogout}
      />
    );
  }

  return (
    <SelectionView
      eventId={eventId!}
      eventTitle={eventTitle}
      onAuthenticated={handleStaffAuthenticated}
    />
  );
}
