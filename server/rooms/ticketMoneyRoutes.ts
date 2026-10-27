// Paid rooms, the money routes of lane S3: buyer refund, host cancel, host sales summary (phase 4, tasks 4.5 and 4.6).
// Registered from registerRoomRoutes. Every amount comes from stored rows (room_tickets / room_payouts), never a request.
//
// Flag: these routes work whatever roomFeatures.paidRooms says. They only give money back (refund, cancel) or show a host
// their own numbers; switching sales off later must never trap a buyer's money or hide a host's earnings.
import type { Express, Request, Response } from "express";
import { pool } from "../storage";
import { requireAuth } from "../middleware";
import { roomLimiter } from "../security";
import type { Room } from "@shared/schema";
import * as rs from "./roomStorage";
import { canViewRoom, viewerRoom } from "./roomAccess";
import { TokenBucket } from "./rateLimit";
import { MoneyLockBusy, moneyClock, refundAllForRoom, refundTicketDetailed } from "./refunds";
import { buyerRefundKobo, isAdminHold } from "@shared/roomRefunds";

const REFUSAL_MESSAGES: Record<string, string> = {
  ROOM_NOT_SCHEDULED: "This room has already started, so the ticket can't be refunded.",
  NO_REFUNDS: "The host turned off refunds for this room.",
  NO_START_TIME: "This room has no start time, so refunds are only given if the host cancels.",
  WINDOW_CLOSED: "Refunds close 1 hour before the room starts.",
  PAYOUT_RELEASED: "This ticket can't be refunded any more.",
  BAD_STATE: "This ticket can't be refunded.",
  NOT_FOUND: "You don't have a ticket for this room.",
};

const buckets = new Map<string, TokenBucket>();
const take = (key: string, rate: number, burst: number) => {
  let b = buckets.get(key);
  if (!b) { if (buckets.size > 5000) buckets.clear(); b = new TokenBucket(rate, burst); buckets.set(key, b); }
  return b.take();
};

const tokenOf = (req: Request) => (typeof req.query.token === "string" ? req.query.token : undefined);

/** 404 for a missing or invisible room (indistinguishable), 403 for someone who is not the host. Null once it has answered. */
async function hostRoom(req: Request, res: Response): Promise<Room | null> {
  const room = await rs.getRoom(req.params.id);
  if (!room || !(await canViewRoom(room, req.user!.id, tokenOf(req)))) { res.status(404).json({ message: "Room not found" }); return null; }
  if (room.hostId !== req.user!.id) { res.status(403).json({ message: "Only the host can do that." }); return null; }
  return room;
}

const isoOrNull = (ms: unknown) => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());

export function registerRoomMoneyRoutes(app: Express): void {
  // ------------------------------------------------------------ buyer refund (self only)
  app.post("/api/rooms/:id/tickets/refund", requireAuth, roomLimiter, async (req, res) => {
    try {
      if (!take(`refund:${req.user!.id}`, 1 / 10, 3)) return res.status(429).json({ message: "You're doing that too fast. Please try again in a bit.", code: "RATE_LIMITED" });
      const room = await rs.getRoom(req.params.id);
      if (!room || !(await canViewRoom(room, req.user!.id, tokenOf(req)))) return res.status(404).json({ message: "Room not found" });
      // The caller's own ticket only (a paid one first). The id never comes from the request.
      // A refused charge (lane S2 row, refund_reason auto_*) is NOT a ticket: it answers NO_TICKET, unless its money is still
      // owed (refunded_at NULL), in which case this call only finishes the provider step (refundTicketDetailed -> "already").
      const t = (await pool.query(
        `select t.id, t.amount_kobo, t.fee_kobo, t.platform_kobo from room_tickets t
          where t.room_id = $1 and t.user_id = $2
            and (coalesce(left(t.refund_reason, 5), '') <> 'auto_' or t.refunded_at is null)
          order by (t.status = 'paid') desc, (coalesce(left(t.refund_reason, 5), '') = 'auto_') asc, t.created_at desc
          limit 1`,
        [room.id, req.user!.id],
      )).rows[0] as { id: string; amount_kobo: number; fee_kobo: number; platform_kobo: number } | undefined;
      if (!t) return res.status(404).json({ result: "not_allowed", code: "NO_TICKET", message: REFUSAL_MESSAGES.NOT_FOUND });
      if (buyerRefundKobo({ amountKobo: Number(t.amount_kobo), feeKobo: Number(t.fee_kobo), platformKobo: Number(t.platform_kobo) }) <= 0) {
        return res.status(409).json({ result: "not_allowed", code: "NOTHING_LEFT", message: "Nothing would be left to refund after the service charge and platform fee." });
      }
      const o = await refundTicketDetailed(t.id, "buyer");
      if (o.result === "not_allowed") {
        const code = o.code ?? "BAD_STATE";
        return res.status(409).json({ result: "not_allowed", code, message: REFUSAL_MESSAGES[code] ?? REFUSAL_MESSAGES.BAD_STATE });
      }
      res.json({ result: o.result, settled: o.settled, ticket: { id: t.id, roomId: room.id, status: "refunded" } });
    } catch (e) {
      if (e instanceof MoneyLockBusy) return res.status(409).json({ result: "not_allowed", code: "REFUND_IN_PROGRESS", message: "Your refund is already being processed." });
      console.error("[rooms] ticket refund failed:", (e as Error)?.message ?? e);
      res.status(500).json({ message: "Failed to refund the ticket" });
    }
  });

  // ------------------------------------------------------------ host cancel (scheduled rooms only)
  app.post("/api/rooms/:id/cancel", requireAuth, roomLimiter, async (req, res) => {
    try {
      const room = await hostRoom(req, res);
      if (!room) return;
      // Cancelling a live room is not part of this phase: the host ends it (and the payout follows the normal 48 h hold).
      if (room.status === "live") return res.status(409).json({ message: "A live room can't be cancelled. End it instead.", code: "ROOM_LIVE" });
      if (room.status !== "scheduled") return res.status(409).json({ message: "This room has already ended.", code: "BAD_STATE" });
      // Checked in the write: a room that went live since we read it is not cancelled.
      const cancelled = await rs.cancelScheduledRoom(room.id, moneyClock.now());
      if (!cancelled) return res.status(409).json({ message: "This room can't be cancelled now.", code: "BAD_STATE" });
      const refunds = await refundAllForRoom(room.id, "host_cancelled");
      res.json({ room: viewerRoom(cancelled), refunds });
    } catch (e) {
      console.error("[rooms] cancel failed:", (e as Error)?.message ?? e);
      res.status(500).json({ message: "Failed to cancel the room" });
    }
  });

  // ------------------------------------------------------------ host sales summary
  // Counts and sums only: never who bought.
  app.get("/api/rooms/:id/tickets/summary", requireAuth, async (req, res) => {
    try {
      const room = await hostRoom(req, res);
      if (!room) return;
      // Refused charges (lane S2, auto_*) are a separate bucket: never a sale, never a refund of a ticket (M1).
      const [sums, payout] = await Promise.all([
        pool.query(
          `select case when coalesce(left(refund_reason, 5), '') = 'auto_' then 'refused' else status end as status, count(*)::int as n,
                  coalesce(sum(amount_kobo), 0)::bigint as gross, coalesce(sum(vat_kobo), 0)::bigint as vat,
                  coalesce(sum(fee_kobo), 0)::bigint as fee, coalesce(sum(reserve_kobo), 0)::bigint as reserve,
                  coalesce(sum(platform_kobo), 0)::bigint as platform, coalesce(sum(host_kobo), 0)::bigint as host
             from room_tickets where room_id = $1
            group by 1`,
          [room.id],
        ),
        pool.query(
          `select status, amount_kobo, round(extract(epoch from release_at) * 1000)::float8 as release_ms,
                  round(extract(epoch from paid_at) * 1000)::float8 as paid_ms
             from room_payouts where room_id = $1`,
          [room.id],
        ),
      ]);
      const by = new Map((sums.rows as any[]).map((r) => [r.status as string, r]));
      const paid = by.get("paid");
      const n = (v: unknown) => Number(v ?? 0);
      const p = payout.rows[0] as { status: string; amount_kobo: number; release_ms: number | null; paid_ms: number | null } | undefined;
      const onHold = !!p && p.status === "held" && isAdminHold(p.release_ms === null ? null : Number(p.release_ms));
      const refused = by.get("refused");
      res.json({
        summary: {
          sold: n(paid?.n),
          refunded: n(by.get("refunded")?.n),
          // Payments refused before they became tickets (sold out, amount mismatch...), returned to the payer. Count + gross.
          refusedCharges: { count: n(refused?.n), grossKobo: n(refused?.gross) },
          grossKobo: n(paid?.gross),
          vatKobo: n(paid?.vat),
          feeKobo: n(paid?.fee),
          reserveKobo: n(paid?.reserve),
          platformKobo: n(paid?.platform),
          hostKobo: n(paid?.host),
          // An admin hold shows as onHold with no release date (never the internal far-future sentinel).
          payout: p ? { status: p.status, amountKobo: n(p.amount_kobo), releaseAt: onHold ? null : isoOrNull(p.release_ms), paidAt: isoOrNull(p.paid_ms), onHold } : null,
        },
      });
    } catch (e) {
      console.error("[rooms] ticket summary failed:", (e as Error)?.message ?? e);
      res.status(500).json({ message: "Failed to load ticket sales" });
    }
  });
}
