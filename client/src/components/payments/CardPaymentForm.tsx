import { useState } from "react";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { Button } from "@/components/ui/button";
import { getStripe } from "@/lib/stripe";
import { openPaystackPopup } from "@/lib/paystack";

interface CardPaymentFormProps {
  clientSecret: string;
  provider: string;
  amountLabel: string;
  itemLabel: string;
  onSuccess: () => void;
  onCancel: () => void;
}

function StripeInnerForm({
  amountLabel,
  onSuccess,
  onCancel,
}: {
  amountLabel: string;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;

    setSubmitting(true);
    setError(null);

    const { error: confirmError, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
    });

    if (confirmError) {
      setError(confirmError.message ?? "Payment failed. Please try a different card.");
      setSubmitting(false);
      return;
    }

    if (paymentIntent?.status === "succeeded") {
      onSuccess();
    } else {
      setError("Payment was not completed. Please try again.");
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-3 justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={!stripe || !elements || submitting} data-testid="button-confirm-payment">
          {submitting ? "Processing..." : `Pay ${amountLabel}`}
        </Button>
      </div>
    </form>
  );
}

function PaystackPayButton({
  clientSecret,
  amountLabel,
  onSuccess,
  onCancel,
}: {
  clientSecret: string;
  amountLabel: string;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePay = async () => {
    setProcessing(true);
    setError(null);
    try {
      await openPaystackPopup(clientSecret, {
        onSuccess: () => onSuccess(),
        onCancel: () => setProcessing(false),
        onError: (message) => {
          setError(message);
          setProcessing(false);
        },
      });
    } catch {
      setError("Could not open Paystack. Please try again.");
      setProcessing(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-3 justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={processing}>
          Cancel
        </Button>
        <Button onClick={handlePay} disabled={processing} data-testid="button-confirm-payment">
          {processing ? "Waiting for Paystack..." : `Pay ${amountLabel}`}
        </Button>
      </div>
    </div>
  );
}

export function CardPaymentForm({
  clientSecret,
  provider,
  amountLabel,
  itemLabel,
  onSuccess,
  onCancel,
}: CardPaymentFormProps) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{itemLabel}</span>
          <span>{amountLabel}</span>
        </div>
        <div className="border-t pt-3 flex justify-between font-medium">
          <span>Total</span>
          <span>{amountLabel}</span>
        </div>
      </div>

      {provider === "paystack" ? (
        <PaystackPayButton
          clientSecret={clientSecret}
          amountLabel={amountLabel}
          onSuccess={onSuccess}
          onCancel={onCancel}
        />
      ) : (
        <Elements stripe={getStripe()} options={{ clientSecret }}>
          <StripeInnerForm amountLabel={amountLabel} onSuccess={onSuccess} onCancel={onCancel} />
        </Elements>
      )}
    </div>
  );
}
