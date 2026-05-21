import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangleIcon, MapPinIcon, Loader2Icon } from "@/components/ui/icons";

interface Buddy {
  id: string;
  name: string;
  phoneNumber: string;
  confirmationStatus: "pending" | "confirmed" | "declined" | "expired";
}

interface BuddiesResponse {
  buddies: Buddy[];
}

interface SosResponse {
  message: string;
  alertIds: string[];
  buddiesNotified: number;
}

export function EmergencyButton() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [location, setLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locating, setLocating] = useState(false);

  const { data: buddiesData } = useQuery<BuddiesResponse>({
    queryKey: ["/api/safety/buddies"],
  });

  const confirmedBuddies = (buddiesData?.buddies ?? []).filter(
    (b) => b.confirmationStatus === "confirmed"
  );

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
      setOpen(false);
      setLocation(null);
      const count = data.buddiesNotified;
      toast({
        title: "SOS Alert Sent",
        description: `Alert sent to ${count} ${count === 1 ? "buddy" : "buddies"}.`,
      });
    },
    onError: (error: any) => {
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

  const handlePress = () => {
    if (confirmedBuddies.length === 0) {
      toast({
        title: "No Safety Buddy Set",
        description: "Set an emergency buddy in Safety Settings first.",
        variant: "destructive",
      });
      return;
    }
    setOpen(true);
    requestLocation();
  };

  const buddyNames =
    confirmedBuddies.length === 1
      ? confirmedBuddies[0].name
      : confirmedBuddies.map((b) => b.name).join(", ");

  return (
    <>
      <Button
        variant="destructive"
        size="icon"
        onClick={handlePress}
        className="relative"
        data-testid="button-emergency"
        title="Send SOS Alert"
      >
        <AlertTriangleIcon className="h-5 w-5" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="dialog-sos-confirm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangleIcon className="h-5 w-5" />
              Send SOS Alert?
            </DialogTitle>
            <DialogDescription className="space-y-2 pt-1">
              <p>
                This will send an emergency alert to:{" "}
                <strong>{buddyNames}</strong>
              </p>
              <div className="flex items-center gap-2 text-sm">
                {locating ? (
                  <>
                    <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
                    <span className="text-muted-foreground">Getting your location…</span>
                  </>
                ) : location ? (
                  <>
                    <MapPinIcon className="h-4 w-4 text-green-600" />
                    <span className="text-green-600">Location captured and will be included</span>
                  </>
                ) : (
                  <>
                    <MapPinIcon className="h-4 w-4 text-yellow-600" />
                    <span className="text-yellow-600">Location unavailable — alert will still be sent</span>
                  </>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setOpen(false); setLocation(null); }}
              disabled={sosMutation.isPending}
              data-testid="button-cancel-sos"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => sosMutation.mutate()}
              disabled={sosMutation.isPending || locating}
              data-testid="button-confirm-sos"
            >
              {sosMutation.isPending ? (
                <><Loader2Icon className="h-4 w-4 mr-2 animate-spin" />Sending…</>
              ) : "Send SOS Now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}