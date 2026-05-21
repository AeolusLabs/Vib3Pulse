import { useState, useEffect, useRef, useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangleIcon, MapPinIcon, Loader2Icon, ShieldIcon } from "@/components/ui/icons";

interface Buddy {
  id: string;
  name: string;
  confirmationStatus: "pending" | "confirmed" | "declined" | "expired";
}

interface SafetyTimer {
  status: "active" | "grace_period" | "alerted" | "checked_in" | "cancelled";
}

interface SosResponse {
  message: string;
  alertIds: string[];
  buddiesNotified: number;
}

const HOLD_MS = 3000;
const RADIUS = 24;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
// Strong ease-out — starts immediately, feels responsive
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

export function EmergencyFAB() {
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [location, setLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [holdProgress, setHoldProgress] = useState(0);
  const holdStart = useRef<number | null>(null);
  const rafId = useRef<number | null>(null);
  const prefersReducedMotion = useRef(
    typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  const { data: buddiesData } = useQuery<{ buddies: Buddy[] }>({
    queryKey: ["/api/safety/buddies"],
  });

  const { data: timerData } = useQuery<{ timer: SafetyTimer | null }>({
    queryKey: ["/api/safety/timer"],
    refetchInterval: 30_000,
  });

  const confirmedBuddies = (buddiesData?.buddies ?? []).filter(
    (b) => b.confirmationStatus === "confirmed"
  );
  const hasConfirmedBuddy = confirmedBuddies.length > 0;
  const timerIsActive =
    timerData?.timer?.status === "active" ||
    timerData?.timer?.status === "grace_period";
  const timerInGrace = timerData?.timer?.status === "grace_period";

  const sosMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/safety/sos", {
        latitude: location?.latitude ?? null,
        longitude: location?.longitude ?? null,
        locationText: null,
      });
      return res.json() as Promise<SosResponse>;
    },
    onSuccess: (data) => {
      // Haptic confirmation pulse
      if ("vibrate" in navigator) navigator.vibrate([40, 30, 40]);
      setDialogOpen(false);
      setLocation(null);
      const count = data.buddiesNotified;
      toast({
        title: "SOS Alert Sent",
        description: `Alert sent to ${count} ${count === 1 ? "buddy" : "buddies"}.`,
      });
    },
    onError: (error: any) => {
      if ("vibrate" in navigator) navigator.vibrate(80);
      toast({
        title: "Failed to Send Alert",
        description: error.message || "Could not send SOS alert. Try again.",
        variant: "destructive",
      });
    },
  });

  const requestLocation = () => {
    if (!("geolocation" in navigator)) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
        setLocating(false);
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 }
    );
  };

  const handleFABClick = () => {
    if ("vibrate" in navigator) navigator.vibrate(10);
    setDialogOpen(true);
    if (hasConfirmedBuddy) requestLocation();
  };

  const fireSOS = useCallback(() => {
    holdStart.current = null;
    setHoldProgress(0);
    sosMutation.mutate();
  }, [sosMutation]);

  const startHold = useCallback((e: React.PointerEvent) => {
    if (sosMutation.isPending) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if ("vibrate" in navigator) navigator.vibrate(10);

    if (prefersReducedMotion.current) {
      // Reduced motion: skip animation, confirm after brief delay
      const id = setTimeout(fireSOS, 800);
      rafId.current = id as any;
      return;
    }

    holdStart.current = Date.now();
    const animate = () => {
      if (holdStart.current === null) return;
      const elapsed = Date.now() - holdStart.current;
      const progress = Math.min(elapsed / HOLD_MS, 1);
      setHoldProgress(progress);
      if (progress < 1) {
        rafId.current = requestAnimationFrame(animate);
      } else {
        fireSOS();
      }
    };
    rafId.current = requestAnimationFrame(animate);
  }, [sosMutation, fireSOS]);

  const cancelHold = useCallback(() => {
    if (prefersReducedMotion.current) {
      clearTimeout(rafId.current as any);
    } else if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
    }
    rafId.current = null;
    holdStart.current = null;
    setHoldProgress(0);
  }, []);

  useEffect(() => {
    if (!dialogOpen) {
      cancelHold();
      setLocation(null);
      setLocating(false);
    }
  }, [dialogOpen, cancelHold]);

  const buddyNames =
    confirmedBuddies.length === 1
      ? confirmedBuddies[0].name
      : confirmedBuddies.map((b) => b.name).join(", ");

  const strokeOffset = CIRCUMFERENCE * (1 - holdProgress);

  // FAB pulse classes: only when timer is in grace (urgent), subtle ring when active
  const fabPulseClass = timerInGrace
    ? "ring-4 ring-destructive/50 animate-pulse"
    : timerIsActive
    ? "ring-2 ring-destructive/25"
    : "";

  return (
    <>
      {/* Floating Action Button */}
      <button
        onClick={handleFABClick}
        aria-label="Send SOS Alert"
        data-testid="fab-emergency"
        style={{ touchAction: "manipulation" }}
        className={[
          "fixed bottom-[5.5rem] right-4 md:bottom-6 z-50",
          "h-14 w-14 rounded-full shadow-xl",
          "bg-destructive text-destructive-foreground",
          "flex items-center justify-center",
          "cursor-pointer select-none",
          "transition-transform duration-150 active:scale-95",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2",
          fabPulseClass,
        ].join(" ")}
      >
        <AlertTriangleIcon className="h-6 w-6" />
      </button>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          data-testid="dialog-sos"
          className="max-w-sm rounded-2xl"
          style={{ overscrollBehavior: "contain" }}
        >
          {!hasConfirmedBuddy ? (
            /* Onboarding state */
            <>
              <DialogHeader className="text-left">
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                  <ShieldIcon className="h-6 w-6 text-primary" />
                </div>
                <DialogTitle className="text-xl">Set up a Safety Buddy first</DialogTitle>
                <DialogDescription className="text-sm leading-relaxed pt-1">
                  Your Safety Buddy gets an SOS alert with your location if you need help —
                  no app needed on their end. Add someone you trust and they confirm by SMS.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2 pt-1">
                <Button asChild size="lg" className="rounded-full w-full">
                  <Link href="/buddy/settings" onClick={() => setDialogOpen(false)}>
                    Set up Safety Buddy
                  </Link>
                </Button>
                <Button variant="ghost" onClick={() => setDialogOpen(false)} className="w-full">
                  Later
                </Button>
              </div>
            </>
          ) : (
            /* SOS confirmation — hold to send */
            <>
              <DialogHeader className="text-left">
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
                  <AlertTriangleIcon className="h-6 w-6 text-destructive" />
                </div>
                <DialogTitle className="text-xl">Send SOS Alert?</DialogTitle>
                <DialogDescription asChild>
                  <div className="space-y-3 pt-1">
                    <p className="text-sm text-muted-foreground">
                      This will alert: <span className="font-semibold text-foreground">{buddyNames}</span>
                    </p>
                    <div className="flex items-center gap-2 text-sm rounded-lg bg-muted/50 px-3 py-2">
                      {locating ? (
                        <>
                          <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
                          <span className="text-muted-foreground">Getting your location…</span>
                        </>
                      ) : location ? (
                        <>
                          <MapPinIcon className="h-4 w-4 text-green-600 shrink-0" />
                          <span className="text-green-700 dark:text-green-400">Location captured</span>
                        </>
                      ) : (
                        <>
                          <MapPinIcon className="h-4 w-4 text-amber-600 shrink-0" />
                          <span className="text-amber-700 dark:text-amber-400">Location unavailable — alert will still send</span>
                        </>
                      )}
                    </div>
                  </div>
                </DialogDescription>
              </DialogHeader>

              <div className="flex items-center justify-between pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDialogOpen(false)}
                  disabled={sosMutation.isPending}
                  data-testid="button-cancel-sos"
                >
                  Cancel
                </Button>

                {/* Hold-to-send: SVG progress ring around circular button */}
                <div className="flex flex-col items-center gap-1.5">
                  <div
                    className="relative flex items-center justify-center select-none"
                    style={{ touchAction: "none" }}
                  >
                    {/* SVG ring — rotated so progress starts at top */}
                    <svg
                      width={64}
                      height={64}
                      className="absolute"
                      style={{ transform: "rotate(-90deg)" }}
                      aria-hidden="true"
                    >
                      {/* Track */}
                      <circle
                        cx={32}
                        cy={32}
                        r={RADIUS}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={3}
                        className="text-destructive/15"
                      />
                      {/* Progress */}
                      <circle
                        cx={32}
                        cy={32}
                        r={RADIUS}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={3}
                        strokeDasharray={CIRCUMFERENCE}
                        strokeDashoffset={strokeOffset}
                        strokeLinecap="round"
                        className="text-destructive"
                        style={{
                          transition:
                            holdProgress === 0
                              ? `stroke-dashoffset 0.2s ${EASE_OUT}`
                              : "none",
                        }}
                      />
                    </svg>

                    {/* Hold button */}
                    <button
                      onPointerDown={startHold}
                      onPointerUp={cancelHold}
                      onPointerLeave={cancelHold}
                      onPointerCancel={cancelHold}
                      disabled={sosMutation.isPending}
                      data-testid="button-hold-sos"
                      aria-label="Hold for 3 seconds to send SOS"
                      style={{ touchAction: "none" }}
                      className={[
                        "relative z-10 h-12 w-12 rounded-full",
                        "bg-destructive text-destructive-foreground",
                        "flex flex-col items-center justify-center gap-0.5",
                        "cursor-pointer select-none",
                        "transition-transform duration-100 active:scale-95",
                        "disabled:opacity-50",
                        "focus:outline-none",
                      ].join(" ")}
                    >
                      {sosMutation.isPending ? (
                        <Loader2Icon className="h-4 w-4 animate-spin" />
                      ) : (
                        <>
                          <AlertTriangleIcon className="h-4 w-4" />
                          <span className="text-[9px] font-semibold leading-none tracking-wide uppercase">
                            Hold
                          </span>
                        </>
                      )}
                    </button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Hold 3 seconds to send
                  </p>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}