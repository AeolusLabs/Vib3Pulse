import { useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { AlertLocationMap } from "@/components/safety/AlertLocationMap";
import { AlertTriangleIcon, MapPinIcon, PhoneIcon } from "@/components/ui/icons";
import { EMERGENCY_FALLBACK } from "@/lib/emergencyNumbers";

// No locale context on a no-auth public page — default to the UK primary
// market's number for the tel: link, show the full multi-region fallback text.
const DEFAULT_EMERGENCY_TEL = "999";

interface PublicAlert {
  status: string;
  senderDisplayName: string;
  senderAvatarUrl: string | null;
  message: string;
  alertType: "manual_sos" | "timer_expiry";
  latitude: number | null;
  longitude: number | null;
  locationText: string | null;
  createdAt: string;
}

function elapsedLabel(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
}

function copyToClipboard(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
}

export default function PublicAlertPage() {
  const [, params] = useRoute("/safety/alert/:token");
  const token = params?.token;

  const { data: alert, isLoading, isError } = useQuery<PublicAlert>({
    queryKey: [`/api/safety/public-alert/${token}`],
    queryFn: async () => {
      const res = await fetch(`/api/safety/public-alert/${token}`);
      if (!res.ok) throw new Error("This alert link has expired or doesn't exist.");
      return res.json();
    },
    enabled: !!token,
    refetchInterval: 20_000,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (isError || !alert) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6 text-center">
        <div>
          <AlertTriangleIcon className="h-8 w-8 mx-auto mb-3 text-muted-foreground opacity-50" />
          <p className="font-medium">This alert link has expired or doesn't exist.</p>
          <p className="text-sm text-muted-foreground mt-1">Links stay active for 7 days after an alert fires.</p>
        </div>
      </div>
    );
  }

  const hasLocation = alert.latitude !== null && alert.longitude !== null;
  const emergencyClipboardText = hasLocation
    ? `My friend needs help. Last known location: ${alert.latitude}, ${alert.longitude}`
    : `My friend needs help. ${alert.message}`;

  return (
    <div className="min-h-screen bg-background flex flex-col items-center py-10 px-4">
      <div className="w-full max-w-md space-y-5">
        <div className="flex items-center gap-3">
          <Avatar className="h-12 w-12">
            <AvatarImage src={alert.senderAvatarUrl ?? ""} />
            <AvatarFallback>{alert.senderDisplayName.charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div>
            <p className="font-semibold text-lg">{alert.senderDisplayName}</p>
            <p className="text-sm text-destructive flex items-center gap-1">
              <AlertTriangleIcon className="h-3.5 w-3.5" />
              {alert.alertType === "manual_sos" ? "SOS alert" : "Missed check-in"} · {elapsedLabel(alert.createdAt)}
            </p>
          </div>
        </div>

        <p className="text-sm leading-relaxed bg-muted rounded-xl p-4">{alert.message}</p>

        {hasLocation ? (
          <div className="space-y-2">
            <AlertLocationMap latitude={alert.latitude!} longitude={alert.longitude!} />
            <a
              href={`https://maps.google.com/?q=${alert.latitude},${alert.longitude}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-primary hover:underline w-fit"
            >
              <MapPinIcon className="h-3.5 w-3.5" />
              {alert.locationText ?? `${alert.latitude!.toFixed(5)}, ${alert.longitude!.toFixed(5)}`}
              <span className="text-muted-foreground">— open in maps</span>
            </a>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No location was shared with this alert.</p>
        )}

        <div className="flex flex-col gap-2 pt-1">
          <a
            href={`tel:${DEFAULT_EMERGENCY_TEL}`}
            onClick={() => copyToClipboard(emergencyClipboardText)}
            className="flex items-center justify-center gap-2 w-full rounded-full h-12 bg-destructive text-destructive-foreground font-semibold"
            data-testid="button-call-emergency"
          >
            <PhoneIcon className="h-4 w-4" />
            Call Emergency Services ({DEFAULT_EMERGENCY_TEL})
          </a>
          <p className="text-center text-xs text-muted-foreground">
            Outside the UK? {EMERGENCY_FALLBACK}. Location copied to your clipboard — paste it when you call.
          </p>
        </div>
      </div>
    </div>
  );
}
