import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Megaphone, Sparkles, Check } from "lucide-react";

interface PromoteEventDialogProps {
  eventId: string;
  eventTitle: string;
  isOpen: boolean;
  onClose: () => void;
}

const promotionOptions = [
  {
    days: 3,
    label: "3 Days",
    description: "Quick boost for upcoming events",
  },
  {
    days: 7,
    label: "1 Week",
    description: "Standard promotion period",
  },
  {
    days: 14,
    label: "2 Weeks",
    description: "Extended visibility",
  },
  {
    days: 30,
    label: "1 Month",
    description: "Maximum exposure",
  },
];

export function PromoteEventDialog({ eventId, eventTitle, isOpen, onClose }: PromoteEventDialogProps) {
  const [selectedDuration, setSelectedDuration] = useState<number>(7);
  const { toast } = useToast();

  const promoteMutation = useMutation({
    mutationFn: async (durationDays: number) => {
      const response = await apiRequest("POST", `/api/events/${eventId}/promote`, {
        durationDays,
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/events'] });
      queryClient.invalidateQueries({ queryKey: ['/api/events/my-events'] });
      toast({
        title: "Event Promoted!",
        description: `Your event will be featured for ${selectedDuration} days.`,
      });
      onClose();
    },
    onError: (error: Error) => {
      toast({
        title: "Promotion Failed",
        description: error.message || "Failed to promote event",
        variant: "destructive",
      });
    },
  });

  const handlePromote = () => {
    promoteMutation.mutate(selectedDuration);
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-promote-event">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Megaphone className="h-5 w-5 text-primary" />
            Promote Event
          </DialogTitle>
          <DialogDescription>
            Boost visibility for "{eventTitle}" by featuring it at the top of feeds and discover pages.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <RadioGroup
            value={selectedDuration.toString()}
            onValueChange={(value) => setSelectedDuration(parseInt(value))}
            className="space-y-3"
          >
            {promotionOptions.map((option) => (
              <div
                key={option.days}
                className="flex items-center space-x-3 rounded-lg border p-4 cursor-pointer hover-elevate"
                onClick={() => setSelectedDuration(option.days)}
                data-testid={`option-duration-${option.days}`}
              >
                <RadioGroupItem value={option.days.toString()} id={`duration-${option.days}`} />
                <Label
                  htmlFor={`duration-${option.days}`}
                  className="flex-1 cursor-pointer"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">{option.label}</p>
                      <p className="text-sm text-muted-foreground">{option.description}</p>
                    </div>
                    {selectedDuration === option.days && (
                      <Check className="h-5 w-5 text-primary" />
                    )}
                  </div>
                </Label>
              </div>
            ))}
          </RadioGroup>
        </div>

        <div className="bg-muted rounded-lg p-4">
          <div className="flex items-start gap-3">
            <Sparkles className="h-5 w-5 text-primary mt-0.5" />
            <div className="text-sm">
              <p className="font-medium">What you get:</p>
              <ul className="text-muted-foreground mt-1 space-y-1">
                <li>Featured placement in event feeds</li>
                <li>Priority in search results</li>
                <li>Special "Featured" badge</li>
                <li>Analytics to track performance</li>
              </ul>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} data-testid="button-cancel-promote">
            Cancel
          </Button>
          <Button
            onClick={handlePromote}
            disabled={promoteMutation.isPending}
            data-testid="button-confirm-promote"
          >
            {promoteMutation.isPending ? "Promoting..." : "Promote Event"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
