import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Minus, Plus, ShoppingCart } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";

interface TicketTier {
  id: string;
  name: string;
  price: number;
  description: string;
  available: number;
}

interface TicketSelectorProps {
  tiers: TicketTier[];
  onPurchase?: (selections: Record<string, number>) => void;
}

export default function TicketSelector({ tiers, onPurchase }: TicketSelectorProps) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  const updateQuantity = (tierId: string, delta: number) => {
    const tier = tiers.find(t => t.id === tierId);
    if (!tier) return;

    const current = quantities[tierId] || 0;
    const newQuantity = Math.max(0, Math.min(current + delta, tier.available));
    
    setQuantities(prev => ({
      ...prev,
      [tierId]: newQuantity
    }));
  };

  const total = tiers.reduce((sum, tier) => {
    const quantity = quantities[tier.id] || 0;
    return sum + (tier.price * quantity);
  }, 0);

  const totalTickets = Object.values(quantities).reduce((sum, q) => sum + q, 0);

  const handlePurchase = () => {
    onPurchase?.(quantities);
    console.log('Purchase initiated:', quantities, 'Total:', total);
  };

  return (
    <Card className="sticky top-20">
      <CardHeader>
        <CardTitle className="font-serif">Select Tickets</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {tiers.map((tier) => (
          <div
            key={tier.id}
            className="border rounded-md p-4 space-y-3"
            data-testid={`ticket-tier-${tier.id}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <h4 className="font-sans font-semibold text-lg" data-testid="text-tier-name">
                  {tier.name}
                </h4>
                <p className="text-sm text-muted-foreground" data-testid="text-tier-description">
                  {tier.description}
                </p>
              </div>
              <div className="font-serif text-xl font-semibold text-primary" data-testid="text-tier-price">
                ${tier.price}
              </div>
            </div>

            <div className="flex items-center justify-between">
              <Badge variant="outline" data-testid="text-available">
                {tier.available} available
              </Badge>

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => updateQuantity(tier.id, -1)}
                  disabled={(quantities[tier.id] || 0) === 0}
                  data-testid={`button-decrease-${tier.id}`}
                >
                  <Minus className="h-4 w-4" />
                </Button>
                <span className="w-8 text-center font-semibold" data-testid={`text-quantity-${tier.id}`}>
                  {quantities[tier.id] || 0}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => updateQuantity(tier.id, 1)}
                  disabled={(quantities[tier.id] || 0) >= tier.available}
                  data-testid={`button-increase-${tier.id}`}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        ))}

        {totalTickets > 0 && (
          <div className="pt-4 border-t space-y-3">
            <div className="flex justify-between text-lg font-semibold">
              <span>Total</span>
              <span className="font-serif text-primary" data-testid="text-total">
                ${total.toFixed(2)}
              </span>
            </div>
            <Button
              className="w-full"
              size="lg"
              onClick={handlePurchase}
              data-testid="button-purchase"
            >
              <ShoppingCart className="h-4 w-4 mr-2" />
              Purchase Tickets ({totalTickets})
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
