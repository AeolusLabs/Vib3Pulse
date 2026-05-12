import type { Express, Request, Response } from "express";
import { z } from "zod";
import { storage } from "./storage.js";
import { wsManager } from "./websocket.js";
import {
  createCheckout,
  verifyCheckoutSession,
  createPaymentIntent,
  verifyPaymentIntent,
  resolveCurrency,
  providerForCurrency,
  formatAmount,
} from "./payments/index.js";
import {
  constructStripeWebhookEvent,
} from "./payments/stripe.js";
import {
  verifyPaystackWebhookSignature,
  verifyPaystackTransaction,
} from "./payments/paystack.js";
import { insertTicketSchema } from "@shared/schema";
import { sensitiveOperationLimiter } from "./security.js";

function requireAuth(req: Request, res: Response, next: Function) {
  if (!req.isAuthenticated() || !req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
}

// ============================================================
// EVENT TICKET PAYMENTS (Stripe Checkout / Paystack redirect)
// ============================================================

export function registerPaymentRoutes(app: Express): void {

  // Start a checkout session for an event ticket
  app.post("/api/payments/event/checkout", requireAuth, sensitiveOperationLimiter, async (req, res) => {
    try {
      const { eventId, ticketTierId } = z.object({
        eventId: z.string().min(1),
        ticketTierId: z.string().optional(),
      }).parse(req.body);

      const userId = req.user!.id;
      const event = await storage.getEvent(eventId);

      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }

      let amountSmallestUnit = event.ticketPrice;
      let tierName = event.title;

      if (ticketTierId) {
        const tier = await storage.getTicketTier(ticketTierId);
        if (!tier || tier.eventId !== eventId) {
          return res.status(400).json({ message: "Invalid ticket tier" });
        }
        amountSmallestUnit = tier.priceSmallestUnit;
        tierName = `${event.title} — ${tier.name}`;
      }

      if (amountSmallestUnit === 0) {
        return res.status(400).json({ message: "Free events use RSVP, not payment" });
      }

      const currency = resolveCurrency(event.city);
      const origin = req.headers.origin || `https://${req.headers.host}`;

      const session = await createCheckout({
        itemId: eventId,
        itemType: "event",
        userId,
        title: tierName,
        description: event.description,
        amountSmallestUnit,
        currency,
        successUrl: `${origin}/ticket-wallet?success=true&session_id={CHECKOUT_SESSION_ID}&provider=${providerForCurrency(currency)}`,
        cancelUrl: `${origin}/event/${eventId}?cancelled=true`,
      });

      res.json({
        sessionId: session.sessionId,
        url: session.url,
        provider: session.provider,
        currency: session.currency,
        amount: formatAmount(amountSmallestUnit, currency),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "eventId is required" });
      }
      console.error("[Payment] Event checkout error:", error);
      res.status(500).json({ message: "Failed to create checkout session" });
    }
  });

  // Verify payment and issue ticket (called from success redirect)
  app.post("/api/payments/event/verify", requireAuth, async (req, res) => {
    try {
      const { sessionId, provider } = z.object({
        sessionId: z.string().min(1),
        provider: z.enum(["stripe", "paystack"]),
      }).parse(req.body);

      const userId = req.user!.id;

      const verified = await verifyCheckoutSession(sessionId, provider);
      if (!verified) {
        return res.status(400).json({ message: "Could not verify payment session" });
      }
      if (!verified.paid) {
        return res.status(402).json({ message: "Payment not completed" });
      }

      const meta = verified.metadata;
      if (!meta.eventId || !meta.userId) {
        return res.status(400).json({ message: "Invalid session metadata" });
      }
      if (meta.userId !== userId) {
        console.error(`[Payment] Security: user ${userId} claimed session for user ${meta.userId}`);
        return res.status(403).json({ message: "Session does not belong to this account" });
      }

      const existing = await storage.getTicketByPaymentIntent(verified.providerPaymentId);
      if (existing) {
        return res.json({ message: "Ticket already issued", ticket: existing });
      }

      const ticket = await storage.createTicket(insertTicketSchema.parse({
        userId: meta.userId,
        eventId: meta.eventId,
        providerPaymentId: verified.providerPaymentId,
        paymentProvider: verified.provider,
        currency: verified.currency,
        amountPaid: verified.amountSmallestUnit,
        status: "confirmed",
      }));

      const event = await storage.getEvent(meta.eventId);
      if (event) {
        const buyer = await storage.getUser(meta.userId);
        await storage.createNotification({
          userId: event.organizerId,
          type: "ticket_purchase",
          title: "Ticket Sold",
          message: `${buyer?.displayName || buyer?.username || "Someone"} purchased a ticket for ${event.title}`,
          link: `/event/${event.id}`,
          relatedUserId: meta.userId,
          relatedEntityId: ticket.id,
        });
        wsManager.sendToUser(event.organizerId, {
          type: "notification",
          data: { type: "ticket_purchase" },
        });
      }

      res.json({ message: "Ticket issued", ticket });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "sessionId and provider are required" });
      }
      console.error("[Payment] Verify event payment error:", error);
      res.status(500).json({ message: "Failed to verify payment" });
    }
  });

  // ============================================================
  // VENUE ENTRY TICKET PAYMENTS (inline Payment Intent)
  // ============================================================

  app.post("/api/payments/venue/intent", requireAuth, sensitiveOperationLimiter, async (req, res) => {
    try {
      const { venueEntryNightId } = z.object({
        venueEntryNightId: z.string().min(1),
      }).parse(req.body);

      const userId = req.user!.id;
      const night = await storage.getVenueEntryNight(venueEntryNightId);

      if (!night) {
        return res.status(404).json({ message: "Entry night not found" });
      }
      if (!night.isActive) {
        return res.status(400).json({ message: "This entry night is no longer active" });
      }
      if (night.capacity !== null && night.ticketsSold >= night.capacity) {
        return res.status(400).json({ message: "This entry night is sold out" });
      }

      const venue = await storage.getVenue(night.venueId);
      const currency = resolveCurrency(venue?.city ?? null);

      const intent = await createPaymentIntent({
        amountSmallestUnit: night.coverPriceCents,
        currency,
        userId,
        metadata: {
          type: "venue_entry",
          venueEntryNightId,
          venueId: night.venueId,
          userId,
        },
      });

      res.json({
        clientSecret: intent.clientSecret,
        paymentIntentId: intent.paymentIntentId,
        provider: intent.provider,
        currency: intent.currency,
        amount: formatAmount(night.coverPriceCents, currency),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "venueEntryNightId is required" });
      }
      console.error("[Payment] Venue intent error:", error);
      res.status(500).json({ message: "Failed to create payment" });
    }
  });

  app.post("/api/payments/venue/confirm", requireAuth, async (req, res) => {
    try {
      const { paymentIntentId, provider, venueEntryNightId } = z.object({
        paymentIntentId: z.string().min(1),
        provider: z.enum(["stripe", "paystack"]),
        venueEntryNightId: z.string().min(1),
      }).parse(req.body);

      const userId = req.user!.id;

      const existing = await storage.getVenueTicketByValidationCode(paymentIntentId).catch(() => null);
      if (existing) {
        return res.json({ message: "Ticket already issued", ticket: existing });
      }

      const verified = await verifyPaymentIntent(paymentIntentId, provider);
      if (!verified || !verified.paid) {
        return res.status(402).json({ message: "Payment not confirmed" });
      }

      const meta = verified.metadata;
      if (meta.userId !== userId) {
        return res.status(403).json({ message: "Payment does not belong to this account" });
      }

      const ticket = await storage.createVenueTicket({
        userId,
        venueEntryNightId,
        providerPaymentId: verified.providerPaymentId,
        paymentProvider: verified.provider,
        currency: verified.currency,
        amountPaid: verified.amountSmallestUnit,
        status: "confirmed",
      });

      await storage.incrementVenueEntryNightTicketsSold(venueEntryNightId);

      res.json({ message: "Ticket issued", ticket });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "paymentIntentId, provider, and venueEntryNightId are required" });
      }
      console.error("[Payment] Confirm venue payment error:", error);
      res.status(500).json({ message: "Failed to confirm payment" });
    }
  });

  // ============================================================
  // STRIPE WEBHOOK
  // ============================================================

  // Raw body required for Stripe signature verification — mount before JSON middleware
  app.post("/api/webhooks/stripe", async (req, res) => {
    const sig = req.headers["stripe-signature"] as string;
    if (!sig) return res.status(400).json({ message: "Missing stripe-signature header" });

    let event;
    try {
      const rawBody = (req as any).rawBody as Buffer;
      event = constructStripeWebhookEvent(rawBody, sig);
    } catch (err: any) {
      console.error("[Stripe Webhook] Signature verification failed:", err.message);
      return res.status(400).json({ message: `Webhook signature invalid: ${err.message}` });
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as any;
          if (session.payment_status !== "paid") break;

          const meta = session.metadata ?? {};
          if (meta.itemType === "event") {
            const existing = await storage.getTicketByPaymentIntent(session.payment_intent);
            if (!existing) {
              await storage.createTicket(insertTicketSchema.parse({
                userId: meta.userId,
                eventId: meta.itemId,
                providerPaymentId: session.payment_intent,
                paymentProvider: "stripe",
                currency: (session.currency?.toUpperCase() ?? "GBP"),
                amountPaid: session.amount_total ?? 0,
                status: "confirmed",
              }));
            }
          }
          break;
        }

        case "payment_intent.succeeded": {
          const intent = event.data.object as any;
          const meta = intent.metadata ?? {};
          if (meta.type === "venue_entry") {
            const night = await storage.getVenueEntryNight(meta.venueEntryNightId);
            if (night) {
              await storage.createVenueTicket({
                userId: meta.userId,
                venueEntryNightId: meta.venueEntryNightId,
                providerPaymentId: intent.id,
                paymentProvider: "stripe",
                currency: (intent.currency?.toUpperCase() ?? "GBP"),
                amountPaid: intent.amount,
                status: "confirmed",
              });
              await storage.incrementVenueEntryNightTicketsSold(meta.venueEntryNightId);
            }
          }
          break;
        }

        default:
          // Ignore unhandled event types
          break;
      }

      res.json({ received: true });
    } catch (err) {
      console.error("[Stripe Webhook] Processing error:", err);
      res.status(500).json({ message: "Webhook processing failed" });
    }
  });

  // ============================================================
  // PAYSTACK WEBHOOK
  // ============================================================

  app.post("/api/webhooks/paystack", async (req, res) => {
    const sig = req.headers["x-paystack-signature"] as string;
    if (!sig) return res.status(400).json({ message: "Missing x-paystack-signature header" });

    const rawBody = (req as any).rawBody?.toString?.() ?? JSON.stringify(req.body);
    if (!verifyPaystackWebhookSignature(rawBody, sig)) {
      console.error("[Paystack Webhook] Signature verification failed");
      return res.status(400).json({ message: "Invalid webhook signature" });
    }

    const payload = req.body as { event: string; data: any };

    try {
      if (payload.event === "charge.success") {
        const reference = payload.data?.reference as string;
        if (reference) {
          const verified = await verifyPaystackTransaction(reference);
          if (verified && verified.paid) {
            const meta = verified.metadata;

            if (meta.eventId) {
              const existing = await storage.getTicketByPaymentIntent(reference);
              if (!existing) {
                await storage.createTicket(insertTicketSchema.parse({
                  userId: meta.userId,
                  eventId: meta.eventId,
                  providerPaymentId: reference,
                  paymentProvider: "paystack",
                  currency: verified.currency,
                  amountPaid: verified.amountSmallestUnit,
                  status: "confirmed",
                }));
              }
            } else if (meta.venueEntryNightId) {
              await storage.createVenueTicket({
                userId: meta.userId!,
                venueEntryNightId: meta.venueEntryNightId,
                providerPaymentId: reference,
                paymentProvider: "paystack",
                currency: verified.currency,
                amountPaid: verified.amountSmallestUnit,
                status: "confirmed",
              });
              await storage.incrementVenueEntryNightTicketsSold(meta.venueEntryNightId);
            }
          }
        }
      }

      res.json({ received: true });
    } catch (err) {
      console.error("[Paystack Webhook] Processing error:", err);
      res.status(500).json({ message: "Webhook processing failed" });
    }
  });

  // Payment config info for frontend
  app.get("/api/payments/config", (req, res) => {
    res.json({
      stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? null,
      paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY ?? null,
      stripeConfigured: !!process.env.STRIPE_SECRET_KEY,
      paystackConfigured: !!process.env.PAYSTACK_SECRET_KEY,
    });
  });
}
