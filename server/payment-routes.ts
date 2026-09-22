import type { Express, Request, Response } from "express";
import { z } from "zod";
import { storage } from "./storage.js";
import {
  createCheckout,
  verifyCheckoutSession,
  createPaymentIntent,
  verifyPaymentIntent,
  refundPayment,
  asSupportedCurrency,
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
import { insertTicketSchema, SOCIAL_PLATFORMS, type SocialPlatform } from "@shared/schema";
import { postEventToSocials } from "./services/socialPromotionService.js";
import { sensitiveOperationLimiter } from "./security.js";
import { recordTransaction } from "./payments/ledger.js";
import { computeFeeSplit } from "./payments/fees.js";
import type { OrganizerSplit } from "./payments/types.js";
import { sendTicketPurchaseEmail } from "./emailService.js";
import { MAX_GROUP_MEMBERS } from "./routes/messages-routes.js";
import { deliverNotification } from "./notifications.js";

function requireAuth(req: Request, res: Response, next: Function) {
  if (!req.isAuthenticated() || !req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
}

class PayoutNotConnectedError extends Error {
  constructor() {
    super("The organiser hasn't finished payout setup yet, so this event can't accept payments right now.");
  }
}

// Resolves how a paid charge should split between the platform and the
// organizer. Returns { buyerCharge } unchanged with no split for any
// provider/currency that doesn't have a payout mechanism wired in yet (GBP/
// Stripe today — Connect isn't built, so those charges behave exactly as
// before). For NGN/Paystack, throws PayoutNotConnectedError if the organizer
// has no connected payout account — money is never accepted for an organizer
// the platform has no way to pay out.
async function resolveOrganizerSplit(params: {
  organizerId: string;
  currency: "GBP" | "NGN";
  baseAmount: number;
  passthroughToBuyer: boolean;
}): Promise<{ buyerCharge: number; organizerSplit?: OrganizerSplit }> {
  if (params.currency !== "NGN") {
    return { buyerCharge: params.baseAmount };
  }

  const payoutAccount = await storage.getOrganizerPaymentAccount(params.organizerId, "paystack");
  if (!payoutAccount?.payoutsEnabled || !payoutAccount.paystackSubaccountCode) {
    throw new PayoutNotConnectedError();
  }

  const commissionBps = await storage.getPlatformCommissionBps();
  const feeSplit = computeFeeSplit({
    baseAmount: params.baseAmount,
    commissionBps,
    passthroughToBuyer: params.passthroughToBuyer,
  });

  return {
    buyerCharge: feeSplit.buyerCharge,
    organizerSplit: {
      paystackSubaccountCode: payoutAccount.paystackSubaccountCode,
      platformFeeAmount: feeSplit.platformFee,
      // Platform absorbs Paystack's own processing fee so the organizer's
      // payout is exactly base-minus-platformFee, not a variable amount.
      bearer: "account",
    },
  };
}

// Issues however many event tickets a single (possibly multi-quantity) charge
// covers. Shared by the client-driven /verify endpoint and both webhook
// handlers so the oversell guard, idempotency check, and per-ticket ledger
// split behave identically no matter which path actually completes the
// purchase first — those three previously reimplemented this logic separately
// (single-ticket only), which risked the same fix landing in one path but not
// the others.
interface IssueEventTicketsParams {
  eventId: string;
  ticketTierId: string | null;
  userId: string;
  providerPaymentId: string;
  provider: "stripe" | "paystack";
  currency: "GBP" | "NGN";
  totalAmountPaid: number; // smallest currency unit, across all `quantity` tickets
  totalPlatformFee: number;
  quantity: number;
  logPrefix: string;
}

interface IssueEventTicketsResult {
  tickets: Awaited<ReturnType<typeof storage.createTicket>>[];
  alreadyIssued: boolean;
  oversold: boolean;
}

async function issueEventTickets(params: IssueEventTicketsParams): Promise<IssueEventTicketsResult> {
  const existing = await storage.getTicketsByPaymentIntent(params.providerPaymentId);
  if (existing.length > 0) {
    // Idempotent replay — the verify call and a webhook retry can both reach
    // here for the same payment; only the first should issue tickets.
    return { tickets: existing, alreadyIssued: true, oversold: false };
  }

  const slotsClaimed = await storage.claimEventTicketSlot(params.eventId, params.ticketTierId, params.quantity);
  if (!slotsClaimed) {
    try {
      await refundPayment(params.providerPaymentId, params.provider);
      console.error(`${params.logPrefix} Oversell: event ${params.eventId}${params.ticketTierId ? ` tier ${params.ticketTierId}` : ""} can't fit ${params.quantity} ticket(s). Payment ${params.providerPaymentId} for user ${params.userId} auto-refunded.`);
    } catch (refundError) {
      console.error(`${params.logPrefix} Oversell: event ${params.eventId}${params.ticketTierId ? ` tier ${params.ticketTierId}` : ""} can't fit ${params.quantity} ticket(s). Payment ${params.providerPaymentId} for user ${params.userId} — REFUND FAILED, requires manual refund:`, refundError);
      await storage.createPaymentIssue({
        providerPaymentId: params.providerPaymentId,
        provider: params.provider,
        reason: "refund_failed",
        errorMessage: refundError instanceof Error ? refundError.message : String(refundError),
      });
    }
    return { tickets: [], alreadyIssued: false, oversold: true };
  }

  const event = await storage.getEvent(params.eventId);

  // Split the total evenly across tickets; any rounding remainder lands on
  // the last ticket so per-ticket amounts always sum back to the exact total.
  const baseShare = Math.floor(params.totalAmountPaid / params.quantity);
  const baseFeeShare = Math.floor(params.totalPlatformFee / params.quantity);

  const tickets = [];
  for (let i = 0; i < params.quantity; i++) {
    const isLast = i === params.quantity - 1;
    const amountPaid = isLast ? params.totalAmountPaid - baseShare * (params.quantity - 1) : baseShare;
    const platformFeeAmount = isLast ? params.totalPlatformFee - baseFeeShare * (params.quantity - 1) : baseFeeShare;

    const ticket = await storage.createTicket(insertTicketSchema.parse({
      userId: params.userId,
      eventId: params.eventId,
      ticketTierId: params.ticketTierId,
      providerPaymentId: params.providerPaymentId,
      paymentProvider: params.provider,
      currency: params.currency,
      amountPaid,
      status: "confirmed",
    }));
    tickets.push(ticket);

    if (event) {
      await recordTransaction({
        type: "ticket_sale",
        provider: params.provider,
        providerPaymentId: params.providerPaymentId,
        currency: params.currency,
        buyerUserId: params.userId,
        organizerId: event.organizerId,
        eventId: event.id,
        ticketId: ticket.id,
        grossAmount: amountPaid,
        platformFeeAmount,
        netToOrganizerAmount: amountPaid - platformFeeAmount,
        status: "succeeded",
      });
    }
  }

  // Fires exactly once per order — this branch only runs the first time a
  // payment's tickets are issued, regardless of whether /verify or one of the
  // two webhooks got here first (see the idempotency check above).
  if (event) {
    const buyer = await storage.getUser(params.userId);
    if (buyer?.email) {
      const tier = params.ticketTierId ? await storage.getTicketTier(params.ticketTierId) : undefined;
      const baseUrl = process.env.APP_URL || "";
      await sendTicketPurchaseEmail({
        to: buyer.email,
        userName: buyer.displayName || buyer.username,
        eventTitle: event.title,
        eventDate: new Date(event.eventDate),
        eventLocation: event.location,
        tierName: tier?.name,
        quantity: params.quantity,
        amountPaid: params.totalAmountPaid,
        currency: params.currency,
        walletLink: `${baseUrl}/ticket-wallet`,
      });
    }

    // Auto-fill the event's group chat, if the organiser has created one —
    // one add per buyer regardless of ticket quantity in this order.
    const eventGroupChat = await storage.getConversationByEventId(event.id);
    if (eventGroupChat) {
      await storage.addConversationParticipantIfRoom(eventGroupChat.id, params.userId, MAX_GROUP_MEMBERS);
    }
  }

  return { tickets, alreadyIssued: false, oversold: false };
}

// ============================================================
// EVENT TICKET PAYMENTS (Stripe Checkout / Paystack redirect)
// ============================================================

export function registerPaymentRoutes(app: Express): void {

  // Start a checkout session for an event ticket
  app.post("/api/payments/event/checkout", requireAuth, sensitiveOperationLimiter, async (req, res) => {
    try {
      const { eventId, ticketTierId, quantity } = z.object({
        eventId: z.string().min(1),
        ticketTierId: z.string().optional(),
        quantity: z.number().int().min(1).max(10).optional().default(1),
      }).parse(req.body);

      const userId = req.user!.id;
      const event = await storage.getEvent(eventId);

      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }

      if (event.moderationStatus !== 'approved') {
        return res.status(403).json({ message: "This event is not yet available for ticket purchase" });
      }

      let perTicketAmount = event.ticketPrice;
      let tierName = event.title;

      if (ticketTierId) {
        const tier = await storage.getTicketTier(ticketTierId);
        if (!tier || tier.eventId !== eventId) {
          return res.status(400).json({ message: "Invalid ticket tier" });
        }
        perTicketAmount = tier.priceSmallestUnit;
        tierName = `${event.title} — ${tier.name}`;
      }

      if (perTicketAmount === 0) {
        return res.status(400).json({ message: "Free events use RSVP, not payment" });
      }

      if (quantity > 1) {
        tierName = `${tierName} × ${quantity}`;
      }

      const currency = asSupportedCurrency(event.currency);

      const { buyerCharge, organizerSplit } = await resolveOrganizerSplit({
        organizerId: event.organizerId,
        currency,
        baseAmount: perTicketAmount * quantity,
        passthroughToBuyer: event.feePassthroughToBuyer,
      });

      // Use APP_URL env var when set; fall back to the request host.
      // Never use req.headers.origin — it is user-controlled and would allow
      // an attacker to redirect victims to a phishing site after payment.
      const baseUrl = process.env.APP_URL || `${req.protocol}://${req.headers.host}`;

      const session = await createCheckout({
        itemId: eventId,
        itemType: "event",
        userId,
        email: req.user!.email,
        title: tierName,
        description: event.description,
        amountSmallestUnit: buyerCharge,
        currency,
        successUrl: `${baseUrl}/ticket-wallet?success=true&session_id={CHECKOUT_SESSION_ID}&provider=${providerForCurrency(currency)}`,
        cancelUrl: `${baseUrl}/event/${eventId}?cancelled=true`,
        ticketTierId,
        organizerSplit,
        quantity,
      });

      res.json({
        sessionId: session.sessionId,
        url: session.url,
        provider: session.provider,
        currency: session.currency,
        amount: formatAmount(buyerCharge, currency),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "eventId is required" });
      }
      if (error instanceof PayoutNotConnectedError) {
        return res.status(409).json({ message: error.message });
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

      const quantity = meta.quantity ? parseInt(meta.quantity, 10) : 1;

      const { tickets, alreadyIssued, oversold } = await issueEventTickets({
        eventId: meta.eventId,
        ticketTierId: meta.ticketTierId ?? null,
        userId: meta.userId,
        providerPaymentId: verified.providerPaymentId,
        provider: verified.provider as "stripe" | "paystack",
        currency: verified.currency,
        totalAmountPaid: verified.amountSmallestUnit,
        totalPlatformFee: Number(meta.platformFeeAmount ?? 0),
        quantity,
        logPrefix: "[Payment]",
      });

      if (oversold) {
        return res.status(409).json({ message: "This event is now sold out. Your payment will be refunded." });
      }

      if (alreadyIssued) {
        return res.json({ message: "Ticket already issued", ticket: tickets[0], tickets, event: await storage.getEvent(meta.eventId) });
      }

      const event = await storage.getEvent(meta.eventId);
      if (event) {
        const buyer = await storage.getUser(meta.userId);
        // Was a direct storage.createNotification() call — meant this
        // notification silently never got real-time WebSocket push or a
        // browser push notification, only ever appearing on the bell's next
        // poll. deliverNotification() does all three, matching every other
        // trigger point in the app.
        await deliverNotification({
          userId: event.organizerId,
          type: "ticket_purchase",
          title: "Ticket Sold",
          message: quantity > 1
            ? `${buyer?.displayName || buyer?.username || "Someone"} purchased ${quantity} tickets for ${event.title}`
            : `${buyer?.displayName || buyer?.username || "Someone"} purchased a ticket for ${event.title}`,
          link: `/event/${event.id}`,
          relatedUserId: meta.userId,
          relatedEntityId: tickets[0].id,
        });
      }

      res.json({ message: "Ticket issued", ticket: tickets[0], tickets, event });
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
      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }
      const currency = asSupportedCurrency(venue.currency);

      const { buyerCharge, organizerSplit } = await resolveOrganizerSplit({
        organizerId: venue.ownerId,
        currency,
        baseAmount: night.coverPriceCents,
        passthroughToBuyer: night.feePassthroughToBuyer,
      });

      const intent = await createPaymentIntent({
        amountSmallestUnit: buyerCharge,
        currency,
        userId,
        email: req.user!.email,
        metadata: {
          type: "venue_entry",
          venueEntryNightId,
          venueId: night.venueId,
          userId,
        },
        organizerSplit,
      });

      res.json({
        clientSecret: intent.clientSecret,
        paymentIntentId: intent.paymentIntentId,
        provider: intent.provider,
        currency: intent.currency,
        amount: formatAmount(buyerCharge, currency),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "venueEntryNightId is required" });
      }
      if (error instanceof PayoutNotConnectedError) {
        return res.status(409).json({ message: error.message });
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

      const slotClaimed = await storage.claimVenueTicketSlot(venueEntryNightId);
      if (!slotClaimed) {
        try {
          await refundPayment(verified.providerPaymentId, provider);
          console.error(`[Payment] Oversell: venue entry night ${venueEntryNightId} is at capacity. Payment ${paymentIntentId} by user ${userId} auto-refunded.`);
        } catch (refundError) {
          console.error(`[Payment] Oversell: venue entry night ${venueEntryNightId} is at capacity. Payment ${paymentIntentId} by user ${userId} — REFUND FAILED, requires manual refund:`, refundError);
          await storage.createPaymentIssue({
            providerPaymentId: verified.providerPaymentId,
            provider,
            reason: "refund_failed",
            errorMessage: refundError instanceof Error ? refundError.message : String(refundError),
          });
        }
        return res.status(409).json({ message: "This entry is now sold out. Your payment will be refunded." });
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

      const night = await storage.getVenueEntryNight(venueEntryNightId);
      const venue = night ? await storage.getVenue(night.venueId) : undefined;
      if (venue) {
        const platformFeeAmount = Number(meta.platformFeeAmount ?? 0);
        await recordTransaction({
          type: "venue_ticket_sale",
          provider: verified.provider,
          providerPaymentId: verified.providerPaymentId,
          currency: verified.currency,
          buyerUserId: userId,
          organizerId: venue.ownerId,
          venueId: venue.id,
          venueEntryNightId,
          ticketId: ticket.id,
          grossAmount: verified.amountSmallestUnit,
          platformFeeAmount,
          netToOrganizerAmount: verified.amountSmallestUnit - platformFeeAmount,
          status: "succeeded",
        });
      }

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
  // VENUE PROMOTION PAYMENT
  // ============================================================

  const PROMOTION_PRICES_PENCE: Record<number, number> = {
    3: 999,
    7: 1999,
    14: 3499,
    30: 5999,
  };
  // Naira pricing — round, sensible starting price points (not an FX conversion
  // of the GBP table, which would drift with exchange rates anyway). The old
  // heuristic reused the GBP pence numbers verbatim as kobo, charging ~₦9.99
  // for a "3-day promotion" — a placeholder bug, not a real price. Adjust
  // these to actual pricing strategy whenever that's decided.
  const PROMOTION_PRICES_KOBO: Record<number, number> = {
    3: 250000,   // ₦2,500
    7: 499900,   // ₦4,999
    14: 899900,  // ₦8,999
    30: 1499900, // ₦14,999
  };

  function getPromotionPrice(durationDays: number, currency: "GBP" | "NGN"): number {
    return currency === "NGN" ? PROMOTION_PRICES_KOBO[durationDays] : PROMOTION_PRICES_PENCE[durationDays];
  }

  // Flat fee per social blast, regardless of how many platforms are selected —
  // Zernio's own per-post cost is trivial (bundled "unlimited posts", the one
  // metered case is X/Twitter at $0.015-$0.20/post). Matches the 3-day in-app
  // promotion price exactly — a familiar price point that comfortably covers
  // the real cost driver (the $6/mo-per-connected-account Zernio fee, amortized
  // across expected usage) plus margin.
  const SOCIAL_PROMOTION_PRICE_PENCE = 999;   // £9.99
  const SOCIAL_PROMOTION_PRICE_KOBO  = 250000; // ₦2,500

  function getSocialPromotionPrice(currency: "GBP" | "NGN"): number {
    return currency === "NGN" ? SOCIAL_PROMOTION_PRICE_KOBO : SOCIAL_PROMOTION_PRICE_PENCE;
  }

  app.post("/api/payments/venue/promote/intent", requireAuth, sensitiveOperationLimiter, async (req, res) => {
    try {
      const { venueId, durationDays } = z.object({
        venueId: z.string().min(1),
        durationDays: z.number().int().refine(d => d in PROMOTION_PRICES_PENCE, {
          message: "Invalid promotion duration",
        }),
      }).parse(req.body);

      const venue = await storage.getVenue(venueId);
      if (!venue) return res.status(404).json({ message: "Venue not found" });
      if (venue.ownerId !== req.user!.id) return res.status(403).json({ message: "You can only promote your own venues" });

      const usedFreeCredit = await storage.claimFreePromotionCredit(req.user!.id);
      if (usedFreeCredit) {
        const promotedVenue = await storage.promoteVenue(venueId, durationDays);
        return res.json({ free: true, venue: promotedVenue });
      }

      const currency = asSupportedCurrency(venue.currency);
      const amount = getPromotionPrice(durationDays, currency);

      const intent = await createPaymentIntent({
        amountSmallestUnit: amount,
        currency,
        userId: req.user!.id,
        email: req.user!.email,
        metadata: {
          type: "venue_promotion",
          venueId,
          durationDays: String(durationDays),
          userId: req.user!.id,
        },
      });

      res.json({
        clientSecret: intent.clientSecret,
        paymentIntentId: intent.paymentIntentId,
        provider: intent.provider,
        currency: intent.currency,
        amount: formatAmount(amount, currency),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: error.errors[0]?.message ?? "Invalid request" });
      }
      console.error("[Payment] Venue promote intent error:", error);
      res.status(500).json({ message: "Failed to create promotion payment" });
    }
  });

  app.post("/api/payments/venue/promote/confirm", requireAuth, async (req, res) => {
    try {
      const { venueId, durationDays, paymentIntentId, provider } = z.object({
        venueId: z.string().min(1),
        durationDays: z.number().int().refine(d => d in PROMOTION_PRICES_PENCE),
        paymentIntentId: z.string().min(1),
        provider: z.enum(["stripe", "paystack"]),
      }).parse(req.body);

      const venue = await storage.getVenue(venueId);
      if (!venue) return res.status(404).json({ message: "Venue not found" });
      if (venue.ownerId !== req.user!.id) return res.status(403).json({ message: "You can only promote your own venues" });

      const verified = await verifyPaymentIntent(paymentIntentId, provider);
      if (!verified || !verified.paid) {
        return res.status(402).json({ message: "Payment not confirmed" });
      }

      if (verified.metadata?.userId !== req.user!.id) {
        return res.status(403).json({ message: "Payment does not belong to this account" });
      }

      const promotedVenue = await storage.promoteVenue(venueId, durationDays);

      // Promotion revenue is 100% platform's — no organizer split applies.
      await recordTransaction({
        type: "venue_promotion",
        provider: verified.provider,
        providerPaymentId: verified.providerPaymentId,
        currency: verified.currency,
        buyerUserId: req.user!.id,
        venueId,
        grossAmount: verified.amountSmallestUnit,
        platformFeeAmount: verified.amountSmallestUnit,
        netToOrganizerAmount: 0,
        status: "succeeded",
      });

      res.json({ message: "Venue promoted successfully", venue: promotedVenue });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "venueId, durationDays, paymentIntentId, and provider are required" });
      }
      console.error("[Payment] Venue promote confirm error:", error);
      res.status(500).json({ message: "Failed to confirm venue promotion" });
    }
  });

  // ============================================================
  // EVENT PROMOTION PAYMENT
  // ============================================================

  app.post("/api/payments/event/promote/intent", requireAuth, sensitiveOperationLimiter, async (req, res) => {
    try {
      const { eventId, durationDays } = z.object({
        eventId: z.string().min(1),
        durationDays: z.number().int().refine(d => d in PROMOTION_PRICES_PENCE, {
          message: "Invalid promotion duration",
        }),
      }).parse(req.body);

      const event = await storage.getEvent(eventId);
      if (!event) return res.status(404).json({ message: "Event not found" });
      if (event.organizerId !== req.user!.id) return res.status(403).json({ message: "You can only promote your own events" });

      const usedFreeCredit = await storage.claimFreePromotionCredit(req.user!.id);
      if (usedFreeCredit) {
        const promotedEvent = await storage.promoteEvent(eventId, durationDays);
        return res.json({ free: true, event: promotedEvent });
      }

      const currency = asSupportedCurrency(event.currency);
      const amount = getPromotionPrice(durationDays, currency);

      const intent = await createPaymentIntent({
        amountSmallestUnit: amount,
        currency,
        userId: req.user!.id,
        email: req.user!.email,
        metadata: {
          type: "event_promotion",
          eventId,
          durationDays: String(durationDays),
          userId: req.user!.id,
        },
      });

      res.json({
        clientSecret: intent.clientSecret,
        paymentIntentId: intent.paymentIntentId,
        provider: intent.provider,
        currency: intent.currency,
        amount: formatAmount(amount, currency),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: error.errors[0]?.message ?? "Invalid request" });
      }
      console.error("[Payment] Event promote intent error:", error);
      res.status(500).json({ message: "Failed to create promotion payment" });
    }
  });

  app.post("/api/payments/event/promote/confirm", requireAuth, async (req, res) => {
    try {
      const { eventId, durationDays, paymentIntentId, provider } = z.object({
        eventId: z.string().min(1),
        durationDays: z.number().int().refine(d => d in PROMOTION_PRICES_PENCE),
        paymentIntentId: z.string().min(1),
        provider: z.enum(["stripe", "paystack"]),
      }).parse(req.body);

      const event = await storage.getEvent(eventId);
      if (!event) return res.status(404).json({ message: "Event not found" });
      if (event.organizerId !== req.user!.id) return res.status(403).json({ message: "You can only promote your own events" });

      const verified = await verifyPaymentIntent(paymentIntentId, provider);
      if (!verified || !verified.paid) {
        return res.status(402).json({ message: "Payment not confirmed" });
      }

      if (verified.metadata?.userId !== req.user!.id) {
        return res.status(403).json({ message: "Payment does not belong to this account" });
      }

      const promotedEvent = await storage.promoteEvent(eventId, durationDays);

      // Promotion revenue is 100% platform's — no organizer split applies.
      await recordTransaction({
        type: "event_promotion",
        provider: verified.provider,
        providerPaymentId: verified.providerPaymentId,
        currency: verified.currency,
        buyerUserId: req.user!.id,
        eventId,
        grossAmount: verified.amountSmallestUnit,
        platformFeeAmount: verified.amountSmallestUnit,
        netToOrganizerAmount: 0,
        status: "succeeded",
      });

      res.json({ message: "Event promoted successfully", event: promotedEvent });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "eventId, durationDays, paymentIntentId, and provider are required" });
      }
      console.error("[Payment] Event promote confirm error:", error);
      res.status(500).json({ message: "Failed to confirm event promotion" });
    }
  });

  // ============================================================
  // EVENT SOCIAL PROMOTION PAYMENT (Zernio cross-posting)
  // ============================================================
  // Unlike in-app promotion, this has no free-credit path — it's unconditionally
  // paid. Platforms are chosen at /intent time, then re-read from the payment
  // intent's own metadata at /confirm rather than trusted from the confirm
  // body, so a tampered request can't post to platforms that weren't paid for.

  app.post("/api/payments/event/promote-social/intent", requireAuth, sensitiveOperationLimiter, async (req, res) => {
    try {
      const { eventId, platforms } = z.object({
        eventId: z.string().min(1),
        platforms: z.array(z.enum(SOCIAL_PLATFORMS)).min(1, "Select at least one platform"),
      }).parse(req.body);

      const event = await storage.getEvent(eventId);
      if (!event) return res.status(404).json({ message: "Event not found" });
      if (event.organizerId !== req.user!.id) return res.status(403).json({ message: "You can only promote your own events" });
      if (event.moderationStatus !== "approved") return res.status(403).json({ message: "Event must be approved before it can be promoted" });

      // Don't charge for a platform that's guaranteed to fail — the dialog UI
      // should already prevent this, this is the server-side backstop.
      const unconnected: SocialPlatform[] = [];
      for (const platform of platforms) {
        const account = await storage.getConnectedSocial(req.user!.id, platform);
        if (!account) unconnected.push(platform);
      }
      if (unconnected.length > 0) {
        return res.status(400).json({
          message: `Connect these platforms before promoting: ${unconnected.join(", ")}`,
          unconnected,
        });
      }

      const currency = asSupportedCurrency(event.currency);
      const amount = getSocialPromotionPrice(currency);

      const intent = await createPaymentIntent({
        amountSmallestUnit: amount,
        currency,
        userId: req.user!.id,
        email: req.user!.email,
        metadata: {
          type: "social_promotion",
          eventId,
          userId: req.user!.id,
          platforms: JSON.stringify(platforms),
        },
      });

      res.json({
        clientSecret: intent.clientSecret,
        paymentIntentId: intent.paymentIntentId,
        provider: intent.provider,
        currency: intent.currency,
        amount: formatAmount(amount, currency),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: error.errors[0]?.message ?? "Invalid request" });
      }
      console.error("[Payment] Event social promote intent error:", error);
      res.status(500).json({ message: "Failed to create social promotion payment" });
    }
  });

  app.post("/api/payments/event/promote-social/confirm", requireAuth, async (req, res) => {
    try {
      const { eventId, paymentIntentId, provider } = z.object({
        eventId: z.string().min(1),
        paymentIntentId: z.string().min(1),
        provider: z.enum(["stripe", "paystack"]),
      }).parse(req.body);

      const verified = await verifyPaymentIntent(paymentIntentId, provider);
      if (!verified || !verified.paid) {
        return res.status(402).json({ message: "Payment not confirmed" });
      }
      if (verified.metadata?.userId !== req.user!.id) {
        return res.status(403).json({ message: "Payment does not belong to this account" });
      }
      if (verified.metadata?.eventId !== eventId) {
        return res.status(403).json({ message: "Payment does not match this event" });
      }

      const event = await storage.getEvent(eventId);
      if (!event) return res.status(404).json({ message: "Event not found" });
      if (event.organizerId !== req.user!.id) return res.status(403).json({ message: "You can only promote your own events" });
      if (event.moderationStatus !== "approved") return res.status(403).json({ message: "Event must be approved before it can be promoted" });

      const platforms = JSON.parse(verified.metadata.platforms ?? "[]") as SocialPlatform[];
      const result = await postEventToSocials(event, req.user!.id, platforms);

      // Promotion revenue is 100% platform's — no organizer split applies.
      await recordTransaction({
        type: "social_promotion",
        provider: verified.provider,
        providerPaymentId: verified.providerPaymentId,
        currency: verified.currency,
        buyerUserId: req.user!.id,
        eventId,
        grossAmount: verified.amountSmallestUnit,
        platformFeeAmount: verified.amountSmallestUnit,
        netToOrganizerAmount: 0,
        status: "succeeded",
      });

      res.json({ message: "Event promoted to social media", ...result });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "eventId, paymentIntentId, and provider are required" });
      }
      console.error("[Payment] Event social promote confirm error:", error);
      res.status(500).json({ message: "Failed to confirm social promotion" });
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
            await issueEventTickets({
              eventId: meta.itemId,
              ticketTierId: meta.ticketTierId ?? null,
              userId: meta.userId,
              providerPaymentId: session.payment_intent,
              provider: "stripe",
              currency: (session.currency?.toUpperCase() ?? "GBP") as "GBP" | "NGN",
              totalAmountPaid: session.amount_total ?? 0,
              totalPlatformFee: Number(meta.platformFeeAmount ?? 0),
              quantity: meta.quantity ? parseInt(meta.quantity, 10) : 1,
              logPrefix: "[Stripe Webhook]",
            });
          }
          break;
        }

        case "payment_intent.succeeded": {
          const intent = event.data.object as any;
          const meta = intent.metadata ?? {};
          if (meta.type === "venue_entry") {
            const night = await storage.getVenueEntryNight(meta.venueEntryNightId);
            if (night) {
              const slotClaimed = await storage.claimVenueTicketSlot(meta.venueEntryNightId);
              if (!slotClaimed) {
                try {
                  await refundPayment(intent.id, "stripe");
                  console.error(`[Stripe Webhook] Oversell: venue entry night ${meta.venueEntryNightId} at capacity. Payment ${intent.id} for user ${meta.userId} auto-refunded.`);
                } catch (refundError) {
                  console.error(`[Stripe Webhook] Oversell: venue entry night ${meta.venueEntryNightId} at capacity. Payment ${intent.id} for user ${meta.userId} — REFUND FAILED, requires manual refund:`, refundError);
                  await storage.createPaymentIssue({
                    providerPaymentId: intent.id,
                    provider: "stripe",
                    reason: "refund_failed",
                    errorMessage: refundError instanceof Error ? refundError.message : String(refundError),
                  });
                }
              } else {
                const ticket = await storage.createVenueTicket({
                  userId: meta.userId,
                  venueEntryNightId: meta.venueEntryNightId,
                  providerPaymentId: intent.id,
                  paymentProvider: "stripe",
                  currency: (intent.currency?.toUpperCase() ?? "GBP"),
                  amountPaid: intent.amount,
                  status: "confirmed",
                });
                const venue = await storage.getVenue(night.venueId);
                if (venue) {
                  const platformFeeAmount = Number(meta.platformFeeAmount ?? 0);
                  await recordTransaction({
                    type: "venue_ticket_sale",
                    provider: "stripe",
                    providerPaymentId: intent.id,
                    currency: (intent.currency?.toUpperCase() ?? "GBP"),
                    buyerUserId: meta.userId,
                    organizerId: venue.ownerId,
                    venueId: venue.id,
                    venueEntryNightId: meta.venueEntryNightId,
                    ticketId: ticket.id,
                    grossAmount: intent.amount,
                    platformFeeAmount,
                    netToOrganizerAmount: intent.amount - platformFeeAmount,
                    status: "succeeded",
                  });
                }
              }
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
              await issueEventTickets({
                eventId: meta.eventId,
                ticketTierId: meta.ticketTierId ?? null,
                userId: meta.userId,
                providerPaymentId: reference,
                provider: "paystack",
                currency: verified.currency,
                totalAmountPaid: verified.amountSmallestUnit,
                totalPlatformFee: Number(meta.platformFeeAmount ?? 0),
                quantity: meta.quantity ? parseInt(meta.quantity, 10) : 1,
                logPrefix: "[Paystack Webhook]",
              });
            } else if (meta.venueEntryNightId) {
              const slotClaimed = await storage.claimVenueTicketSlot(meta.venueEntryNightId);
              if (!slotClaimed) {
                try {
                  await refundPayment(reference, "paystack");
                  console.error(`[Paystack Webhook] Oversell: venue entry night ${meta.venueEntryNightId} at capacity. Reference ${reference} for user ${meta.userId} auto-refunded.`);
                } catch (refundError) {
                  console.error(`[Paystack Webhook] Oversell: venue entry night ${meta.venueEntryNightId} at capacity. Reference ${reference} for user ${meta.userId} — REFUND FAILED, requires manual refund:`, refundError);
                  await storage.createPaymentIssue({
                    providerPaymentId: reference,
                    provider: "paystack",
                    reason: "refund_failed",
                    errorMessage: refundError instanceof Error ? refundError.message : String(refundError),
                  });
                }
              } else {
                const ticket = await storage.createVenueTicket({
                  userId: meta.userId!,
                  venueEntryNightId: meta.venueEntryNightId,
                  providerPaymentId: reference,
                  paymentProvider: "paystack",
                  currency: verified.currency,
                  amountPaid: verified.amountSmallestUnit,
                  status: "confirmed",
                });
                const night = await storage.getVenueEntryNight(meta.venueEntryNightId);
                const venue = night ? await storage.getVenue(night.venueId) : undefined;
                if (venue) {
                  const platformFeeAmount = Number(meta.platformFeeAmount ?? 0);
                  await recordTransaction({
                    type: "venue_ticket_sale",
                    provider: "paystack",
                    providerPaymentId: reference,
                    currency: verified.currency,
                    buyerUserId: meta.userId!,
                    organizerId: venue.ownerId,
                    venueId: venue.id,
                    venueEntryNightId: meta.venueEntryNightId,
                    ticketId: ticket.id,
                    grossAmount: verified.amountSmallestUnit,
                    platformFeeAmount,
                    netToOrganizerAmount: verified.amountSmallestUnit - platformFeeAmount,
                    status: "succeeded",
                  });
                }
              }
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

  // Single source of truth for promotion pricing, by currency — the promote
  // dialogs fetch this instead of hardcoding a price table client-side, so
  // the price shown before checkout can never drift from what's actually
  // charged (which is exactly what happened before: the dialogs hardcoded a
  // GBP-only table and would show "£59.99" even for an NGN event/venue that
  // was actually about to be charged ₦14,999).
  app.get("/api/payments/promotion-prices", (req, res) => {
    res.json({
      GBP: { ...PROMOTION_PRICES_PENCE, social: SOCIAL_PROMOTION_PRICE_PENCE },
      NGN: { ...PROMOTION_PRICES_KOBO, social: SOCIAL_PROMOTION_PRICE_KOBO },
    });
  });
}
