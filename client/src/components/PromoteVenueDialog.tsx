import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Sparkles, Check, Zap, Crown, Rocket } from "lucide-react";

interface PromoteVenueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  venueId: string;
  venueName: string;
}

const promotionPackages = [
  {
    duration: 3,
    price: 9.99,
    label: "3 Days",
    icon: Zap,
    popular: false,
    description: "Quick visibility boost"
  },
  {
    duration: 7,
    price: 19.99,
    label: "1 Week",
    icon: Sparkles,
    popular: true,
    description: "Best for weekend events"
  },
  {
    duration: 14,
    price: 34.99,
    label: "2 Weeks",
    icon: Crown,
    popular: false,
    description: "Extended exposure"
  },
  {
    duration: 30,
    price: 59.99,
    label: "1 Month",
    icon: Rocket,
    popular: false,
    description: "Maximum impact"
  },
];

export function PromoteVenueDialog({ open, onOpenChange, venueId, venueName }: PromoteVenueDialogProps) {
  const [selectedPackage, setSelectedPackage] = useState(7);
  const { toast } = useToast();

  const promoteMutation = useMutation({
    mutationFn: async (durationDays: number) => {
      return await apiRequest("POST", `/api/venues/${venueId}/promote`, { durationDays });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/my-venues"] });
      queryClient.invalidateQueries({ queryKey: ["/api/venues/promoted"] });
      toast({ title: "Venue promoted successfully!", description: "Your venue is now featured." });
      onOpenChange(false);
    },
    onError: () => {
      toast({ title: "Failed to promote venue", variant: "destructive" });
    },
  });

  const handlePromote = () => {
    promoteMutation.mutate(selectedPackage);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-purple-500" />
            Promote Your Venue
          </DialogTitle>
          <DialogDescription>
            Feature "{venueName}" to reach more customers and increase visibility
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-3">
            {promotionPackages.map((pkg) => (
              <Card
                key={pkg.duration}
                className={`p-4 cursor-pointer transition-all hover-elevate ${
                  selectedPackage === pkg.duration
                    ? "ring-2 ring-purple-500 bg-purple-50/50 dark:bg-purple-950/20"
                    : ""
                }`}
                onClick={() => setSelectedPackage(pkg.duration)}
                data-testid={`card-promo-${pkg.duration}`}
              >
                <div className="flex items-start justify-between mb-2">
                  <pkg.icon className={`h-5 w-5 ${selectedPackage === pkg.duration ? "text-purple-500" : "text-muted-foreground"}`} />
                  {pkg.popular && (
                    <Badge className="bg-gradient-to-r from-purple-500 to-pink-500 text-white text-xs">
                      Popular
                    </Badge>
                  )}
                  {selectedPackage === pkg.duration && !pkg.popular && (
                    <Check className="h-4 w-4 text-purple-500" />
                  )}
                </div>
                <div className="font-semibold">{pkg.label}</div>
                <div className="text-2xl font-bold text-purple-600">£{pkg.price}</div>
                <div className="text-xs text-muted-foreground mt-1">{pkg.description}</div>
              </Card>
            ))}
          </div>

          <div className="bg-muted/50 rounded-lg p-4 space-y-2">
            <h4 className="font-semibold text-sm">What you get:</h4>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-green-500" />
                Featured placement on Discover page
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-green-500" />
                Priority in search results
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-green-500" />
                Special "Featured" badge
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-green-500" />
                Analytics dashboard access
              </li>
            </ul>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-promote">
            Cancel
          </Button>
          <Button
            onClick={handlePromote}
            disabled={promoteMutation.isPending}
            className="bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600"
            data-testid="button-confirm-promote"
          >
            {promoteMutation.isPending ? "Processing..." : `Promote for £${promotionPackages.find(p => p.duration === selectedPackage)?.price}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
