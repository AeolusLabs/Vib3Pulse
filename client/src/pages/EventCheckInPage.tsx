import { useQuery, useMutation } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Camera, CheckCircle2, XCircle, Loader2, ArrowLeft, Users, ShieldCheck, Plus, Trash2, Copy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { format } from "date-fns";
import type { Event, Ticket, User, EventStaffAccessCode } from "@shared/schema";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";

type TicketWithUser = Ticket & { user: User };

export default function EventCheckInPage() {
  const [, params] = useRoute("/events/:id/check-in");
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<{
    success: boolean;
    message: string;
    ticket?: Ticket & { user?: User };
  } | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const eventId = params?.id;

  const { data: event } = useQuery<Event>({
    queryKey: [`/api/events/${eventId}`],
    enabled: !!eventId,
  });

  const { data: checkIns, refetch: refetchCheckIns } = useQuery<TicketWithUser[]>({
    queryKey: [`/api/events/${eventId}/check-ins`],
    enabled: !!eventId,
  });

  const validateMutation = useMutation({
    mutationFn: async (validationCode: string) => {
      const response = await apiRequest("POST", "/api/tickets/validate", {
        validationCode,
        eventId,
      });
      return response.json();
    },
    onSuccess: (data) => {
      setScanResult({
        success: data.valid && !data.alreadyCheckedIn,
        message: data.message,
        ticket: data.ticket,
      });
      
      if (data.valid && !data.alreadyCheckedIn) {
        toast({
          title: "✓ Ticket Validated",
          description: `Welcome! Check-in successful.`,
        });
        refetchCheckIns();
      } else {
        toast({
          title: data.alreadyCheckedIn ? "Already Checked In" : "Invalid Ticket",
          description: data.message,
          variant: "destructive",
        });
      }

      // Clear result after 3 seconds
      setTimeout(() => setScanResult(null), 3000);
    },
    onError: (error: any) => {
      const message = error.message || "Failed to validate ticket";
      setScanResult({
        success: false,
        message,
      });
      toast({
        title: "Validation Error",
        description: message,
        variant: "destructive",
      });
      setTimeout(() => setScanResult(null), 3000);
    },
  });

  const startScanning = async () => {
    try {
      const scanner = new Html5Qrcode("qr-reader");
      scannerRef.current = scanner;

      await scanner.start(
        { facingMode: "environment" },
        {
          fps: 10,
          qrbox: { width: 250, height: 250 },
        },
        (decodedText) => {
          // Stop scanning and validate
          stopScanning();
          validateMutation.mutate(decodedText);
        },
        undefined
      );

      setIsScanning(true);
    } catch (error) {
      console.error("Scanner error:", error);
      toast({
        title: "Camera Error",
        description: "Unable to access camera. Please check permissions.",
        variant: "destructive",
      });
    }
  };

  const stopScanning = async () => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop();
        scannerRef.current = null;
        setIsScanning(false);
      } catch (error) {
        console.error("Error stopping scanner:", error);
      }
    }
  };

  useEffect(() => {
    return () => {
      stopScanning();
    };
  }, []);

  const { data: staffCodes, refetch: refetchStaffCodes } = useQuery<EventStaffAccessCode[]>({
    queryKey: [`/api/events/${eventId}/staff-codes`],
    enabled: !!eventId,
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
    onError: () => {
      toast({ title: "Error", description: "Failed to generate code.", variant: "destructive" });
    },
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
    onError: () => {
      toast({ title: "Error", description: "Failed to revoke code.", variant: "destructive" });
    },
  });

  const checkedInTickets = checkIns?.filter(t => t.checkedInAt) || [];
  const totalTickets = checkIns?.length || 0;

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />

      <main className="container px-4 py-6 max-w-4xl mx-auto space-y-6">
        <div className="flex items-center gap-3 flex-wrap">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/manage-events")}
            data-testid="button-back"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Events
          </Button>
        </div>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-serif font-bold" data-testid="heading-check-in">
              Event Check-In
            </h1>
            {event && (
              <p className="text-muted-foreground mt-1">{event.title}</p>
            )}
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
            <CardDescription>
              Scan attendee QR codes to validate and check them in
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Scanner container */}
            <div className="relative">
              <div 
                id="qr-reader" 
                className={`${isScanning ? 'block' : 'hidden'} w-full rounded-md overflow-hidden`}
                data-testid="qr-reader"
              />
              {!isScanning && (
                <div className="flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-md">
                  <Camera className="h-12 w-12 text-muted-foreground mb-4" />
                  <p className="text-sm text-muted-foreground mb-4">
                    Click below to start scanning tickets
                  </p>
                  <Button
                    onClick={startScanning}
                    disabled={validateMutation.isPending}
                    data-testid="button-start-scan"
                  >
                    <Camera className="h-4 w-4 mr-2" />
                    Start Scanner
                  </Button>
                </div>
              )}
            </div>

            {isScanning && (
              <Button
                variant="destructive"
                onClick={stopScanning}
                className="w-full"
                data-testid="button-stop-scan"
              >
                Stop Scanner
              </Button>
            )}

            {/* Scan Result */}
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
                  <p className={`font-medium ${
                    scanResult.success 
                      ? "text-green-900 dark:text-green-100" 
                      : "text-red-900 dark:text-red-100"
                  }`}>
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
                <span className="ml-2">Validating ticket...</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Checked-In Attendees */}
        <Card>
          <CardHeader>
            <CardTitle>Checked-In Attendees</CardTitle>
            <CardDescription>
              {checkedInTickets.length} attendee{checkedInTickets.length !== 1 ? 's' : ''} checked in
            </CardDescription>
          </CardHeader>
          <CardContent>
            {checkedInTickets.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">
                No attendees checked in yet
              </p>
            ) : (
              <div className="space-y-3">
                {checkedInTickets.map((ticket) => (
                  <div
                    key={ticket.id}
                    className="flex items-center justify-between p-3 rounded-md border"
                    data-testid={`checked-in-${ticket.id}`}
                  >
                    <div>
                      <p className="font-medium">
                        {ticket.user.displayName || ticket.user.username}
                      </p>
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
                  Generate codes for bouncers — they use /scanner to check in guests
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
          <CardContent>
            {!staffCodes || staffCodes.length === 0 ? (
              <p className="text-center text-muted-foreground py-6 text-sm">
                No staff codes generated yet
              </p>
            ) : (
              <div className="space-y-3">
                {staffCodes.map((sc) => (
                  <div
                    key={sc.id}
                    className="flex items-center justify-between p-3 rounded-md border"
                    data-testid={`staff-code-${sc.id}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className="font-mono text-lg font-bold tracking-widest cursor-pointer select-all"
                          title="Click to copy"
                          onClick={() => {
                            navigator.clipboard.writeText(sc.code);
                            toast({ title: "Copied!", description: `Code ${sc.code} copied to clipboard.` });
                          }}
                        >
                          {sc.code}
                        </span>
                        <Badge
                          variant={sc.status === "active" ? "default" : sc.status === "revoked" ? "destructive" : "secondary"}
                        >
                          {sc.status === "active" ? "Active" : sc.status === "revoked" ? "Revoked" : "Pending"}
                        </Badge>
                        {sc.scanCount > 0 && (
                          <span className="text-xs text-muted-foreground">{sc.scanCount} scanned</span>
                        )}
                      </div>
                      {sc.validatedBy ? (
                        <p className="text-sm text-muted-foreground mt-0.5">
                          {sc.validatedBy} · redeemed {sc.redeemedAt ? format(new Date(sc.redeemedAt), "h:mm a") : ""}
                        </p>
                      ) : (
                        <p className="text-sm text-muted-foreground mt-0.5">
                          Not yet used · expires {format(new Date(sc.expiresAt), "h:mm a")}
                        </p>
                      )}
                    </div>
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
