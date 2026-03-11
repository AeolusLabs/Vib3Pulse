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
import { AlertTriangle, Shield } from "lucide-react";
import { User } from "@shared/schema";

export function EmergencyButton() {
  const { toast } = useToast();
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [location, setLocation] = useState<{ latitude: string; longitude: string } | null>(null);
  const [gettingLocation, setGettingLocation] = useState(false);

  const { data: buddyData } = useQuery<{ buddy: User | null; status: string | null }>({
    queryKey: ["/api/buddy"],
  });

  const triggerAlertMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/buddy/trigger-alert", {
        latitude: location?.latitude || null,
        longitude: location?.longitude || null,
      });
    },
    onSuccess: (data: any) => {
      setShowConfirmDialog(false);
      toast({
        title: "Alert Sent!",
        description: `Distress alert sent to ${data.buddy?.displayName || data.buddy?.username || "your buddy"}`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to send distress alert",
        variant: "destructive",
      });
    },
  });

  const requestLocation = () => {
    setGettingLocation(true);
    
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setLocation({
            latitude: position.coords.latitude.toString(),
            longitude: position.coords.longitude.toString(),
          });
          setGettingLocation(false);
          toast({
            title: "Location Captured",
            description: "Your current location will be sent with the alert",
          });
        },
        (error) => {
          setGettingLocation(false);
          console.error("Error getting location:", error);
          toast({
            title: "Location Error",
            description: "Could not get your location. Alert will be sent without location.",
            variant: "destructive",
          });
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 30000,
        }
      );
    } else {
      setGettingLocation(false);
      toast({
        title: "Location Not Available",
        description: "Geolocation is not supported by your browser",
        variant: "destructive",
      });
    }
  };

  const handleEmergencyClick = () => {
    if (!buddyData?.buddy) {
      toast({
        title: "No Buddy Set",
        description: "Please set an emergency buddy in your profile settings first",
        variant: "destructive",
      });
      return;
    }
    if (buddyData.status !== "accepted") {
      toast({
        title: "Buddy Not Accepted",
        description: "Your buddy hasn't accepted your request yet",
        variant: "destructive",
      });
      return;
    }

    setShowConfirmDialog(true);
    requestLocation();
  };

  const handleConfirmAlert = () => {
    triggerAlertMutation.mutate();
  };

  return (
    <>
      <Button
        variant="destructive"
        size="icon"
        onClick={handleEmergencyClick}
        className="relative"
        data-testid="button-emergency"
        title="Emergency Alert"
      >
        <AlertTriangle className="h-5 w-5" />
      </Button>

      <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <DialogContent data-testid="dialog-emergency-confirm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Send Distress Alert?
            </DialogTitle>
            <DialogDescription className="space-y-2">
              <p>
                This will send an emergency alert to your buddy:{" "}
                <strong>{buddyData?.buddy?.displayName || buddyData?.buddy?.username}</strong>
              </p>
              {gettingLocation && (
                <p className="text-sm text-muted-foreground">Getting your location...</p>
              )}
              {location && (
                <p className="text-sm text-green-600">
                  ✓ Location captured and will be included with the alert
                </p>
              )}
              {!gettingLocation && !location && (
                <p className="text-sm text-yellow-600">
                  Location not available - alert will be sent without location
                </p>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowConfirmDialog(false)}
              disabled={triggerAlertMutation.isPending}
              data-testid="button-cancel-alert"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmAlert}
              disabled={triggerAlertMutation.isPending}
              data-testid="button-confirm-alert"
            >
              {triggerAlertMutation.isPending ? "Sending..." : "Send Alert"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
