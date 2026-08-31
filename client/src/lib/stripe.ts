import { loadStripe, type Stripe } from "@stripe/stripe-js";

let stripePromise: Promise<Stripe | null> | null = null;
let configPromise: Promise<PaymentConfig> | null = null;

export interface PaymentConfig {
  stripePublishableKey: string | null;
  paystackPublicKey: string | null;
  stripeConfigured: boolean;
  paystackConfigured: boolean;
}

export function getPaymentConfig(): Promise<PaymentConfig> {
  if (!configPromise) {
    configPromise = fetch("/api/payments/config", { credentials: "include" }).then((res) => {
      if (!res.ok) throw new Error("Failed to load payment configuration");
      return res.json();
    });
  }
  return configPromise;
}

export function getStripe(): Promise<Stripe | null> {
  if (!stripePromise) {
    stripePromise = getPaymentConfig().then((config) => {
      if (!config.stripePublishableKey) return null;
      return loadStripe(config.stripePublishableKey);
    });
  }
  return stripePromise;
}
