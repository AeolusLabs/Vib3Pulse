import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { TimerIcon } from "@/components/ui/icons";

interface AutoSetupTimerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventId: string;
  eventName: string;
  defaultExpiry: Date;
}

export function AutoSetupTimerDialog({ open, onOpenChange, eventId, eventName, defaultExpiry }: AutoSetupTimerDialogProps) {
  const { toast } = useToast();

  const setupMutation = useMutation({
    mutationFn: () => {
      const durationMinutes = Math.max(1, Math.round((defaultExpiry.getTime() - Date.now()) / 60_000));
      return apiRequest("POST", "/api/safety/timer", { durationMinutes, eventId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/timer"] });
      toast({ title: "Check-in time set", description: "We'll remind you to check in after the event." });
      onOpenChange(false);
    },
    onError: (e: any) => {
      toast({ title: "Couldn't set up check-in", description: e.message, variant: "destructive" });
      onOpenChange(false);
    },
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="dialog-auto-setup-timer">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <TimerIcon className="h-5 w-5" />
            Set up a safety check-in?
          </AlertDialogTitle>
          <AlertDialogDescription>
            You're going to {eventName}. We'll check in with you around{" "}
            {defaultExpiry.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })} —
            if you don't respond, your confirmed safety buddy is alerted automatically.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-skip-auto-timer">Skip</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); setupMutation.mutate(); }}
            disabled={setupMutation.isPending}
            data-testid="button-confirm-auto-timer"
          >
            {setupMutation.isPending ? "Setting up…" : "Set up"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
