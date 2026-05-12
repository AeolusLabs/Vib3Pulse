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
import { AlertTriangle, MapPin, Loader2 } from "lucide-react";
import type { User } from "@shared/schema";

interface BuddyResponse {
  buddy: User | null;
  status: string | null;
}

export function EmergencyButton() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [location, setLocation] = useState<{ latitude: number; longitude: number; locationText?: string } | null>(null);
  const [locating, setLocating] = useState(false);

  const { data: buddyData } = useQuery<BuddyResponse>({ queryKey: ["/api/safety/buddy"] });

  const sosMutation = useMutation({
    mutationFn: async () =>
      apiRequest("POST", "/api/safety/sos", {
        latitude: location?.latitude ?? null,
        longitude: location?.longitude ?? null,
        locationText: location?.locationText ?? null,
      }),
    onSuccess: (data: any) => {
      setOpen(false);
      setLocation(null);
      toast({
        title: "SOS Alert Sent",
        description: `Alert sent to ${data.buddy?.displayName || data.buddy?.username || "your buddy"}`,
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
        setLocation({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        });
        setLocating(false);
      },
      () => {
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 }
    );
  };

  const handlePress = () => {
    if (!buddyData?.buddy) {
      toast({
        title: "No Safety Buddy Set",
        description: "Set an emergency buddy in Safety Settings first.",
        variant: "destructive",
      });
      return;
    }
    if (buddyData.status !== "accepted") {
      toast({
        title: "Buddy Hasn't Accepted Yet",
        description: "Your buddy request is still pending.",
        variant: "destructive",
      });
      return;
    }
    setOpen(true);
    requestLocation();
  };

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
        <AlertTriangle className="h-5 w-5" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="dialog-sos-confirm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Send SOS Alert?
            </DialogTitle>
            <DialogDescription className="space-y-2 pt-1">
              <p>
                This will send an emergency alert to your buddy:{" "}
                <strong>{buddyData?.buddy?.displayName || buddyData?.buddy?.username}</strong>
              </p>
              <div className="flex items-center gap-2 text-sm">
                {locating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    <span className="text-muted-foreground">Getting your location…</span>
                  </>
                ) : location ? (
                  <>
                    <MapPin className="h-4 w-4 text-green-600" />
                    <span className="text-green-600">Location captured and will be included</span>
                  </>
                ) : (
                  <>
                    <MapPin className="h-4 w-4 text-yellow-600" />
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
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Sending…</>
              ) : "Send SOS Now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
