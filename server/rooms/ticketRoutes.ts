// REST for buying a room ticket: checkout (start a Paystack payment) and verify (finish it after the redirect back).
// Registered from registerRoomRoutes (roomRoutes.ts), so the merge with other lanes touches one line there.
// The webhook branch lives in server/payment-routes.ts; both finish through issueRoomTicket (tickets.ts).
import type { Express, Response } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth } from "../middleware";
import { roomLimiter } from "../security";
import { isBlockedEitherWay } from "../utils/blocks";
import { checkPurchase, type PurchaseBlock, type RoomTicketRefusal } from "@shared/roomTickets";
import { createCheckout, verifyCheckoutSession } from "../payments/index";
import * as rs from "./roomStorage";
import { canViewRoom } from "./roomAccess";
import { roomFeatures } from "./features";
import { TokenBucket } from "./rateLimit";
import { handleRoomTicketCharge, IssueQueueFullError, replayRoomTicket, ticketCountsFor, toTicketView, type IssueRoomTicketResult } from "./tickets";
import { hostCanSellNow } from "./ticketStorage";
import { ticketCheckoutBaseUrl } from "./checkoutUrl";
import { looksLikeTicketReference, makeTicketReference, ticketReferenceBelongsTo, ticketReferenceSecret } from "./ticketReference";

// Checkout refusals. Everyone the buyer checks refuse (not verified, under 18, under the room's limit, banned, blocked)
// gets the same 404-style answer with no price, whether or not the room sells tickets.
const NOT_ELIGIBLE = [404, "NOT_ELIGIBLE", "Tickets for this room aren't available to you."] as const;
const NOT_TICKETED = [409, "NOT_TICKETED", "This room doesn't sell tickets."] as const;
const SALES_PAUSED = [409, "SALES_PAUSED", "Ticket sales for this room are paused right now. Try again later."] as const;
const CHECKOUT_REFUSAL: Record<PurchaseBlock, readonly [number, string, string]> = {
  NOT_BOUND: NOT_ELIGIBLE, // not reachable at checkout (no payment yet)
  BUYER_GONE: NOT_ELIGIBLE,
  NOT_VERIFIED_ADULT: NOT_ELIGIBLE,
  BANNED_OR_BLOCKED: NOT_ELIGIBLE,
  BELOW_AGE_LIMIT: NOT_ELIGIBLE,
  IS_HOST: [409, "IS_HOST", "You host this room, so you don't need a ticket."],
  ROOM_NOT_ADULT: NOT_TICKETED,
  NOT_TICKETED: NOT_TICKETED,
  PRICE_INVALID: SALES_PAUSED, // a stored price outside the limits: the host is told (GET /api/rooms/:id ticketSales), never the buyer why
  SALES_PAUSED: SALES_PAUSED,  // the host lost ID verification or their payout account
  IS_COHOST: [409, "IS_COHOST", "You're a co-host here, so you don't need a ticket."],
  AMOUNT_MISMATCH: NOT_TICKETED, // not reachable at checkout (no payment yet)
  ROOM_NOT_OPEN: [409, "ROOM_ENDED", "This room has ended."],
  ROOM_NOT_APPROVED: [409, "NOT_ON_SALE", "Tickets for this room aren't on sale right now."],
  ALREADY_TICKETED: [409, "ALREADY_TICKETED", "You already have a ticket for this room."],
  SOLD_OUT: [409, "SOLD_OUT", "Tickets for this room are sold out."],
};

const REFUND_MESSAGE: Record<RoomTicketRefusal, string> = {
  SOLD_OUT: "The last ticket went just before your payment came through. Your payment is being refunded.",
  AMOUNT_MISMATCH: "The amount paid didn't match the ticket price. Your payment is being refunded.",
  INELIGIBLE: "We couldn't give you a ticket for this room. Your payment is being refunded.",
};

const PAYMENT_NOT_FOUND = { message: "Payment not found", code: "PAYMENT_NOT_FOUND" } as const;

/** Seconds a caller (Paystack, or the client's verify) should wait when the room's issue queue is full. */
export const ISSUE_RETRY_AFTER_SEC = 5;

function sendOutcome(res: Response, result: IssueRoomTicketResult) {
  if ("ticket" in result) {
    return res.json({ ticket: toTicketView(result.ticket), ...(result.duplicateRefunded ? { duplicateRefunded: true } : {}) });
  }
  return res.status(409).json({ message: REFUND_MESSAGE[result.reason], code: result.reason, refunded: true });
}

export function registerRoomTicketRoutes(app: Express): void {
  // Per buyer, on top of roomLimiter: a few checkouts in a burst (double-click Pay, a retry), then one every 20 seconds.
  const checkoutBuckets = new Map<string, TokenBucket>();
  const takeCheckout = (userId: string) => {
    let b = checkoutBuckets.get(userId);
    if (!b) { if (checkoutBuckets.size > 5000) checkoutBuckets.clear(); b = new TokenBucket(1 / 20, 5); checkoutBuckets.set(userId, b); }
    return b.take();
  };

  // ------------------------------------------------------------ checkout
  // Body is ignored on purpose: the amount is the room's stored price, never anything the client sends.
  app.post("/api/rooms/:id/tickets/checkout", requireAuth, roomLimiter, async (req, res) => {
    const uid = req.user!.id;
    try {
      if (!roomFeatures.paidRooms) return res.status(403).json({ message: "Paid rooms aren't available yet.", code: "FEATURE_OFF" });
      if (!takeCheckout(uid)) return res.status(429).json({ message: "Too many tries. Wait a moment and try again.", code: "RATE_LIMITED" });

      const room = await rs.getRoom(req.params.id);
      const token = typeof req.query.token === "string" ? req.query.token : undefined;
      // The view and minors' room gate first: a room the caller cannot see is not found, with nothing about it.
      if (!room || !(await canViewRoom(room, uid, token))) return res.status(404).json({ message: "Room not found" });

      const [buyer, member, blocked, counts, hostCanSell] = await Promise.all([
        storage.getUser(uid), rs.getMember(room.id, uid), isBlockedEitherWay(uid, room.hostId), ticketCountsFor(room.id, uid),
        hostCanSellNow(room.hostId),
      ]);
      const check = checkPurchase({
        buyerId: uid, buyer, room, bannedOrBlocked: !!member?.banned || blocked,
        buyerIsCohost: !!member && !member.banned && member.role === "cohost",
        hostCanSell,
        paidCount: counts.paid, buyerHasPaid: counts.mine > 0,
      });
      if (!check.ok) {
        const [status, code, message] = CHECKOUT_REFUSAL[check.code];
        return res.status(status).json({ message, code });
      }
      if (room.locked) return res.status(409).json({ message: "The host has locked this room, so tickets are paused.", code: "ROOM_LOCKED" });

      // checkPurchase proved this a sellable integer price. The buyer pays exactly it (VAT included); the split is
      // computed from it by ticketBreakdown when the ticket is issued.
      const price = room.ticketPriceKobo as number;
      // Never the Host or Origin header in production (caller-controlled): APP_URL only.
      const baseUrl = ticketCheckoutBaseUrl(process.env, `${req.protocol}://${req.headers.host}`);
      if (!baseUrl) {
        console.error(`[rooms:tickets] room=${room.id} user=${uid} outcome=checkout_no_app_url (set APP_URL to the site's https origin)`);
        return res.status(500).json({ message: "Payment couldn't be started. Try again.", code: "CHECKOUT_FAILED" });
      }
      const reference = makeTicketReference(room.id, uid, ticketReferenceSecret());
      const session = await createCheckout({
        itemId: room.id,
        itemType: "room",
        userId: uid,
        email: req.user!.email,
        title: `Room ticket: ${room.title}`,
        description: room.title,
        amountSmallestUnit: price,
        currency: "NGN",
        // The invite token (if any) is NOT put in the return URL: it would be handed to Paystack. The client keeps it.
        successUrl: `${baseUrl}/rooms/${room.id}?ref={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${baseUrl}/rooms/${room.id}`,
        reference,
      });
      if (session.sessionId !== reference || session.provider !== "paystack") {
        console.error(`[rooms:tickets] ref=${reference} room=${room.id} user=${uid} outcome=checkout_reference_mismatch`);
        return res.status(502).json({ message: "Payment couldn't be started. Try again.", code: "CHECKOUT_FAILED" });
      }
      console.log(`[rooms:tickets] ref=${reference} room=${room.id} user=${uid} outcome=checkout_started`);
      res.json({ url: session.url, reference });
    } catch (e) {
      console.error(`[rooms:tickets] room=${req.params.id} user=${uid} outcome=checkout_error`, e instanceof Error ? e.message : e);
      res.status(500).json({ message: "Payment couldn't be started. Try again.", code: "CHECKOUT_FAILED" });
    }
  });

  // ------------------------------------------------------------ verify
  // Called by the client after Paystack sends the buyer back (?ref=...). Safe to call any number of times, before or
  // after the webhook. Not gated by the paidRooms flag: a charge that was taken must still become a ticket or a refund.
  app.post("/api/rooms/:id/tickets/verify", requireAuth, roomLimiter, async (req, res) => {
    const uid = req.user!.id;
    try {
      const parsed = z.object({ reference: z.string().max(100) }).safeParse(req.body);
      if (!parsed.success || !looksLikeTicketReference(parsed.data.reference)) {
        return res.status(400).json({ message: "Invalid reference", field: "reference" });
      }
      const reference = parsed.data.reference;
      const room = await rs.getRoom(req.params.id);
      // The reference must have been made by checkout for THIS user and THIS room (MAC). Another user's reference, or
      // this user's reference for a different room, is simply not found. (A charge whose room was deleted is refunded
      // by the webhook.) No view check here: the MAC proves this buyer passed checkout for this room.
      if (!room || !ticketReferenceBelongsTo(reference, room.id, uid, ticketReferenceSecret())) {
        console.warn(`[rooms:tickets] ref=${reference} room=${req.params.id} user=${uid} outcome=verify_reference_not_bound`);
        return res.status(404).json(PAYMENT_NOT_FOUND);
      }

      // Already processed (webhook first, or a second verify): answer from the stored row, no provider call.
      const replay = await replayRoomTicket(reference, room.id, uid);
      if (replay) return sendOutcome(res, replay);

      // Re-verify with the provider. The amount used is the provider's, never anything in this request.
      const verified = await verifyCheckoutSession(reference, "paystack");
      if (!verified) return res.status(502).json({ message: "We couldn't check your payment just now. Try again in a moment.", code: "VERIFY_FAILED" });
      if (!verified.paid) return res.status(402).json({ message: "Payment not completed.", code: "NOT_PAID" });
      if (verified.providerPaymentId !== reference || verified.metadata.roomId !== room.id || verified.metadata.userId !== uid) {
        console.error(`[rooms:tickets] ref=${reference} room=${room.id} user=${uid} outcome=verify_metadata_mismatch`);
        return res.status(404).json(PAYMENT_NOT_FOUND);
      }

      const result = await handleRoomTicketCharge(reference, verified);
      if (!result) return res.status(404).json(PAYMENT_NOT_FOUND);
      return sendOutcome(res, result);
    } catch (e) {
      if (e instanceof IssueQueueFullError) {
        res.setHeader("Retry-After", String(ISSUE_RETRY_AFTER_SEC));
        return res.status(503).json({ message: "Lots of people are buying right now. Your payment is safe: try again in a moment.", code: "BUSY" });
      }
      console.error(`[rooms:tickets] room=${req.params.id} user=${uid} outcome=verify_error`, e instanceof Error ? e.message : e);
      res.status(500).json({ message: "We couldn't finish your ticket just now. Try again in a moment.", code: "VERIFY_ERROR" });
    }
  });
}
