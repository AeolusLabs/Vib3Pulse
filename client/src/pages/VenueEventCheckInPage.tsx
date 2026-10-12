import { useQuery, useMutation } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import ScannerScreen from "@/components/scanner/ScannerScreen";
import StaffDoor from "@/components/scanner/StaffDoor";
import { useAuth } from "@/hooks/useAuth";
import { format } from "date-fns";
import type { VenueTicket, User, VenueEntryNight, Venue, VenueStaffAccessCode } from "@shared/schema";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { CameraIcon, CheckCircle2Icon, XCircleIcon, Loader2Icon, ArrowLeftIcon, UsersIcon, ShieldCheckIcon, PlusIcon, Trash2Icon, LogOutIcon, ScanLineIcon, UserCheckIcon, CopyIcon, QrCodeIcon, DownloadIcon } from "@/components/ui/icons";
import { Link as LinkIcon } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type Mode = "detecting" | "organizer" | "staff";

type VenueTicketWithUser = VenueTicket & { user: User };

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Sub-components ────────────────────────────────────────────────────────────

function DetectingSpinner() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <Loader2Icon className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Loading check-in…</p>
      </div>
    </div>
  );
}

function OrganizerView({
  venueEntryNightId,
  onSwitchToStaff,
}: {
  venueEntryNightId: string;
  onSwitchToStaff: () => void;
}) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [scannerOpen, setScannerOpen] = useState(false);

  const [expandedQRs, setExpandedQRs] = useState<Set<string>>(new Set());
  const [qrDataUrls, setQrDataUrls] = useState<Record<string, string>>({});

  const handleToggleQR = async (sc: VenueStaffAccessCode) => {
    if (!qrDataUrls[sc.id]) {
      const url = `${window.location.origin}/venue-events/${venueEntryNightId}/check-in?code=${sc.code}`;
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

  const handleDownloadQR = (sc: VenueStaffAccessCode) => {
    const dataUrl = qrDataUrls[sc.id];
    if (!dataUrl) return;
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `checkin-code-${sc.pin ?? sc.id}.png`;
    a.click();
  };

  const { data: entryNight } = useQuery<VenueEntryNight & { venue: Venue }>({
    queryKey: [`/api/venue-events/${venueEntryNightId}`],
    enabled: !!venueEntryNightId,
  });

  const { data: checkIns, refetch: refetchCheckIns } = useQuery<VenueTicketWithUser[]>({
    queryKey: [`/api/venue-events/${venueEntryNightId}/check-ins`],
    enabled: !!venueEntryNightId,
  });

  const { data: staffCodes, refetch: refetchStaffCodes } = useQuery<VenueStaffAccessCode[]>({
    queryKey: [`/api/venue-events/${venueEntryNightId}/staff-codes`],
    enabled: !!venueEntryNightId,
  });

  const generateCodeMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/venue-events/${venueEntryNightId}/staff-codes`, {});
      return response.json();
    },
    onSuccess: () => {
      refetchStaffCodes();
      toast({ title: "Code generated", description: "Give the 6-digit code to your door staff." });
    },
    onError: () => toast({ title: "Error", description: "Failed to generate code.", variant: "destructive" }),
  });

  const revokeCodeMutation = useMutation({
    mutationFn: async (codeId: string) => {
      const response = await apiRequest("DELETE", `/api/venue-events/${venueEntryNightId}/staff-codes/${codeId}`, undefined);
      return response.json();
    },
    onSuccess: () => {
      refetchStaffCodes();
      toast({ title: "Code revoked", description: "Staff member can no longer scan." });
    },
    onError: () => toast({ title: "Error", description: "Failed to revoke code.", variant: "destructive" }),
  });

  const checkedInTickets = checkIns?.filter((t) => t.checkedInAt) || [];
  const totalTickets = checkIns?.length || 0;

  if (scannerOpen) {
    return (
      <ScannerScreen
        identity={{ kind: "venue", eventId: venueEntryNightId }}
        eventTitle={entryNight?.name ?? "Check-in"}
        onExit={() => { setScannerOpen(false); refetchCheckIns(); }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />

      <main className="container px-4 py-6 max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Button variant="ghost" size="sm" onClick={() => navigate("/manage-venues")} data-testid="button-back">
            <ArrowLeftIcon className="h-4 w-4 mr-2" />
            Back to Venues
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
            {entryNight && <p className="text-muted-foreground mt-1">{entryNight.name}</p>}
          </div>
          <Badge variant="secondary" className="text-sm px-3 py-1" data-testid="badge-check-in-count">
            <UsersIcon className="h-4 w-4 mr-1" />
            {checkedInTickets.length} / {totalTickets} checked in
          </Badge>
        </div>

        {/* Door scanner */}
        <Card>
          <CardHeader>
            <CardTitle>Scan tickets</CardTitle>
            <CardDescription>Full-screen scanner: the camera stays on, results clear themselves, and you can type a code if a QR will not scan.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => setScannerOpen(true)} className="w-full sm:w-auto" data-testid="button-open-scanner">
              <ScanLineIcon className="h-4 w-4 mr-2" />
              Open door scanner
            </Button>
          </CardContent>
        </Card>

        {/* Checked-In Attendees */}
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-3">
            <div>
              <CardTitle>Checked-In Attendees</CardTitle>
              <CardDescription>
                {checkedInTickets.length} attendee{checkedInTickets.length !== 1 ? "s" : ""} checked in
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const a = document.createElement("a");
                a.href = `/api/venue-events/${venueEntryNightId}/guestlist.csv`;
                a.click();
              }}
            >
              <DownloadIcon className="h-4 w-4 mr-2" />
              Download CSV
            </Button>
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
                    <CheckCircle2Icon className="h-5 w-5 text-green-600" />
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
                  <ShieldCheckIcon className="h-5 w-5" />
                  Staff Access
                </CardTitle>
                <CardDescription>
                  One code per door staff member: share the link, they open it, enter their name and the 6-digit code
                </CardDescription>
              </div>
              <Button
                size="sm"
                onClick={() => generateCodeMutation.mutate()}
                disabled={generateCodeMutation.isPending}
                data-testid="button-generate-staff-code"
              >
                {generateCodeMutation.isPending ? (
                  <Loader2Icon className="h-4 w-4 animate-spin" />
                ) : (
                  <PlusIcon className="h-4 w-4 mr-1" />
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
                {window.location.origin}/venue-events/{venueEntryNightId}/check-in
              </p>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 flex-shrink-0"
                title="Copy check-in link"
                data-testid="button-copy-checkin-link"
                onClick={() => {
                  navigator.clipboard.writeText(`${window.location.origin}/venue-events/${venueEntryNightId}/check-in`);
                  toast({ title: "Link copied", description: "Share this with your door staff." });
                }}
              >
                <CopyIcon className="h-3.5 w-3.5" />
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

                    <div className="flex items-center justify-between p-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span
                            className="font-mono text-2xl font-bold tracking-[0.2em] min-w-0 max-w-full cursor-pointer select-all"
                            title="Click to copy code"
                            onClick={() => {
                              if (!sc.pin) return;
                              navigator.clipboard.writeText(sc.pin);
                              toast({ title: "Copied!", description: `Code ${sc.pin} copied.` });
                            }}
                          >
                            {sc.pin ? `${sc.pin.slice(0, 3)} ${sc.pin.slice(3)}` : "Link only"}
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
                            <Trash2Icon className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>

                    {expandedQRs.has(sc.id) && qrDataUrls[sc.id] && (
                      <div className="border-t p-4 flex flex-col items-center gap-3 bg-muted/20">
                        <img
                          src={qrDataUrls[sc.id]}
                          alt="QR code for staff sign-in"
                          className="w-48 h-48 rounded-sm"
                          data-testid={`img-staff-qr-${sc.id}`}
                        />
                        <p className="text-xs text-center text-muted-foreground max-w-[220px]">
                          Staff scan this QR, enter their name, and start scanning. No code to type.
                        </p>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleDownloadQR(sc)}
                            data-testid={`button-download-qr-${sc.id}`}
                          >
                            <DownloadIcon className="h-4 w-4 mr-2" />
                            Download
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              navigator.clipboard.writeText(
                                `${window.location.origin}/venue-events/${venueEntryNightId}/check-in?code=${sc.code}`,
                              );
                              toast({ title: "Link copied", description: "Direct link with code pre-filled." });
                            }}
                            data-testid={`button-copy-code-link-${sc.id}`}
                          >
                            <CopyIcon className="h-4 w-4 mr-2" />
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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function VenueEventCheckInPage() {
  const [, params] = useRoute("/venue-events/:id/check-in");
  const venueEntryNightId = params?.id;

  const { data: authUser, isLoading: authLoading } = useAuth();

  // ?code= is the organiser's staff link: staff go straight to the door flow.
  const urlCode = new URLSearchParams(window.location.search).get("code") ?? "";
  const [mode, setMode] = useState<Mode>(urlCode ? "staff" : "detecting");
  const [eventTitle, setEventTitle] = useState<string | undefined>();

  useEffect(() => {
    if (!venueEntryNightId) return;
    fetch(`/api/venue-events/${venueEntryNightId}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((ev) => { if (ev?.name) setEventTitle(ev.name); })
      .catch(() => {});
  }, [venueEntryNightId]);

  // The venue owner gets the dashboard; everyone else is door staff.
  useEffect(() => {
    if (urlCode || authLoading || !venueEntryNightId) return;
    let cancelled = false;
    (async () => {
      if (authUser?.userType === "organizer" && authUser?.id) {
        try {
          const res = await fetch(`/api/venue-events/${venueEntryNightId}`, { credentials: "include" });
          if (!cancelled && res.ok) {
            const ev = await res.json();
            // Ownership check: venue.ownerId must match session user
            if (ev.venue?.ownerId === authUser.id) {
              if (ev.name) setEventTitle(ev.name);
              setMode("organizer");
              return;
            }
          }
        } catch {
          // Network error: do not grant organiser access.
        }
      }
      if (!cancelled) setMode("staff");
    })();
    return () => { cancelled = true; };
  }, [authLoading, authUser, venueEntryNightId, urlCode]);

  if (mode === "detecting") return <DetectingSpinner />;
  if (mode === "organizer") return <OrganizerView venueEntryNightId={venueEntryNightId!} onSwitchToStaff={() => setMode("staff")} />;
  return <StaffDoor kind="venue" targetId={venueEntryNightId!} title={eventTitle} urlCode={urlCode} onOrganiser={() => setMode("detecting")} />;
}
