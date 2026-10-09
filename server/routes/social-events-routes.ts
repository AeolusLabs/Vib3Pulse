import type { Express, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth } from "../middleware";
import { sanitizeTextOnly, apiRateLimiter, inviteRsvpLimiter } from "../security";
import { deliverNotification } from "../notifications";
import { geocodeAddress } from "../utils/geo";
import { invalidateCache } from "../cache";
import { socialEventCreateDto, socialEventUpdateDto, socialRsvpDto, socialAppealDto, moderationAppeals, userStrikes, bans, userSuspensions, type Event } from "@shared/schema";
import { db } from "../storage";
import { and, desc, eq, isNull } from "drizzle-orm";
import { isBanned } from "../services/enforcement";
import { checkCanHostPublic, getTrustInfo, judgeContent, ageFromDob, minAgeFor } from "../services/eventAbuse";
import { removeGuestRsvp } from "../services/guestPrivacy";
import { getConfig } from "../services/moderationConfig";

// Free invite/RSVP events. An invitation is a price-0 `tickets` row (see
// storage.upsertSocialRsvp) - no parallel invite system. Sensitive fields
// (exactAddress, inviteToken, guestName, guestTokenHash) are stripped from every
// generic response by the global redaction middleware; this file is the only place
// that emits them, and only under different keys (address, inviteUrl, name) after
// an explicit access check.
//
//   private: invite-only. Never listed, never moderated. Guests need no account. A "yes"
//            reveals the exact address immediately.
//   public : listed in discovery once moderation allows. Creation is gated (verified phone,
//            account age, new-account rate limit, content rules). RSVPs need an account (so
//            age limits can be enforced and the host knows who is asking) and the exact
//            address is released only when the host approves that guest.

const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
const newToken = (bytes: number) => crypto.randomBytes(bytes).toString("base64url");
const clean = (v: string) => sanitizeTextOnly(v).trim();
const cleanOrNull = (v: string | null | undefined) => (v ? clean(v) || null : null);
const baseUrl = (req: Request) => process.env.APP_URL || `${req.protocol}://${req.headers.host}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HALF_DAY_MS = 12 * 60 * 60 * 1000;

function hasEnded(e: Event): boolean {
  const end = e.eventEndDate ? new Date(e.eventEndDate) : new Date(new Date(e.eventDate).getTime() + HALF_DAY_MS);
  return end.getTime() < Date.now();
}

// Deliberately vague: telling a host which rule flagged them is a how-to-evade guide.
const REVIEW_NOTE: Record<string, string> = {
  pending: "Your event is being reviewed. It will appear in discovery once approved.",
  hidden: "Your event is hidden while we review it. You can appeal below.",
  rejected: "Your event wasn't approved. You can appeal below.",
  removed: "Your event was removed. You can appeal below.",
  changes_requested: "We've asked for changes to your event. Edit it and it will be reviewed again.",
};

function hostView(e: Event, req: Request) {
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    socialType: e.socialType,
    visibility: e.visibility,
    eventDate: e.eventDate,
    eventEndDate: e.eventEndDate,
    location: e.location,
    city: e.city,
    address: e.exactAddress,
    capacity: e.ticketsAvailable,
    headcount: e.ticketsSold,
    maxPlusOnes: e.maxPlusOnes,
    dressCode: e.dressCode,
    schedule: e.lineup ?? [],
    ageRestriction: e.ageRestriction,
    servesAlcohol: e.servesAlcohol,
    imageUrl: e.imageUrl,
    isCancelled: e.isCancelled,
    moderationStatus: e.moderationStatus,
    reviewNote: REVIEW_NOTE[e.moderationStatus] ?? null,
    publicUrl: e.visibility === "public" ? `${baseUrl(req)}/i/${e.id}` : null,
    inviteUrl: e.inviteToken ? `${baseUrl(req)}/i/${e.inviteToken}` : null,
  };
}

// Any logged-in, non-deleted, non-banned account with a verified email may host.
async function requireSocialHost(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.isAuthenticated()) return res.status(401).json({ message: "Authentication required" });
    const user = await storage.getUser(req.user!.id);
    if (!user || user.deletedAt) return res.status(401).json({ message: "Authentication required" });
    if (await isBanned({ userId: user.id, verifiedPhone: user.verifiedPhone, deviceHash: req.deviceHash })) {
      return res.status(403).json({ message: "You can't host events on this account.", code: "BANNED" });
    }
    if (!user.isVerified) {
      return res.status(403).json({ message: "Verify your email to host events", code: "EMAIL_NOT_VERIFIED" });
    }
    next();
  } catch {
    res.status(500).json({ message: "Failed to check account" });
  }
}

const ALCOHOL_RULE = "Events serving alcohol must be 18+ or 21+.";
const BLOCKED_MSG = "Public events from new accounts can't include links, phone numbers, email addresses or messaging-app contact details. Remove them and try again.";

// Social events are managed ONLY through /api/social-events and reached by guests ONLY
// through /api/invite. The generic commercial /api/events/:id/* routes must not
// expose, edit or sell them, so they 404 for social events (public ones keep a
// read-only detail, report and click-tracking). Registered before the commercial routes.
export function registerSocialEventGate(app: Express): void {
  app.use("/api/events/:eventId", async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!UUID.test(req.params.eventId)) return next(); // "promoted", "my-events", ...
      const gate = await storage.getEventGate(req.params.eventId);
      if (!gate || gate.kind !== "social") return next();
      const publicReadable = gate.visibility === "public" && gate.moderationStatus === "approved";
      const sub = req.path;
      const allowed =
        publicReadable &&
        ((req.method === "GET" && sub === "/") || (req.method === "POST" && (sub === "/report" || sub === "/click")));
      if (allowed) return next();
      return res.status(404).json({ message: "Event not found" });
    } catch {
      res.status(500).json({ message: "Failed to load event" });
    }
  });
}

export function registerSocialEventRoutes(app: Express): void {
  // ---------------------------------------------------------------- host side
  app.post("/api/social-events", requireSocialHost, apiRateLimiter, async (req, res) => {
    try {
      const d = socialEventCreateDto.parse(req.body);
      if (d.eventDate.getTime() <= Date.now()) return res.status(400).json({ message: "Event date must be in the future" });
      if (d.eventEndDate && d.eventEndDate.getTime() <= d.eventDate.getTime()) {
        return res.status(400).json({ message: "End time must be after the start time" });
      }
      if (d.servesAlcohol && d.ageRestriction === "all") return res.status(400).json({ message: ALCOHOL_RULE, code: "ALCOHOL_NEEDS_AGE_LIMIT" });

      const isPublic = d.visibility === "public";
      let moderationStatus = "approved"; // private events never enter the moderation queue
      let queueReason: string | null = null;
      let autoFlags: string[] = [];
      let latitude: number | null = null;
      let longitude: number | null = null;
      let city = cleanOrNull(d.city);

      if (isPublic) {
        const user = (await storage.getUser(req.user!.id))!;
        const check = await checkCanHostPublic(user, req.deviceHash);
        if (!check.ok) return res.status(check.status).json({ message: check.message, code: check.code, ...(check.details ?? {}) });

        const schedule = d.schedule?.map((s) => ({ name: clean(s.name), ...(s.time ? { time: clean(s.time) } : {}) })) ?? null;
        const verdict = await judgeContent({ title: d.title, description: d.description, location: d.location, dressCode: d.dressCode, schedule }, check.trust);
        if (verdict.action === "block") return res.status(400).json({ message: BLOCKED_MSG, code: "CONTENT_BLOCKED" });
        if (verdict.action === "queue") {
          moderationStatus = "pending";
          queueReason = verdict.reason;
          autoFlags = verdict.flags;
        }

        // Area-level only: geocode the public area text, never the exact address.
        if (!process.env.DISABLE_GEOCODING) {
          try {
            const g = await geocodeAddress(clean(d.location));
            if (g) { latitude = g.latitude; longitude = g.longitude; city = city ?? g.city; }
          } catch { /* discovery proximity is best-effort */ }
        }
      }

      const event = await storage.createEvent({
        organizerId: req.user!.id,
        title: clean(d.title),
        description: clean(d.description),
        eventDate: d.eventDate,
        eventEndDate: d.eventEndDate ?? null,
        location: clean(d.location),
        city,
        latitude,
        longitude,
        category: "social",
        ticketPrice: 0,
        currency: "GBP",
        requiresRSVP: true,
        ticketsAvailable: d.capacity,
        imageUrl: d.imageUrl ?? null,
        isPublished: true,
        moderationStatus,
        queueReason,
        autoFlags,
        queuedAt: moderationStatus === "pending" ? new Date() : null,
        ageRestriction: d.ageRestriction,
        dressCode: cleanOrNull(d.dressCode),
        lineup: d.schedule?.map((s) => ({ name: clean(s.name), ...(s.time ? { time: clean(s.time) } : {}) })).filter((s) => s.name) ?? null,
        kind: "social",
        visibility: d.visibility,
        socialType: d.socialType,
        exactAddress: clean(d.exactAddress),
        maxPlusOnes: d.maxPlusOnes,
        inviteToken: newToken(18),
        servesAlcohol: d.servesAlcohol,
      });
      res.status(201).json(hostView(event, req));
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ message: "Invalid event data", errors: error.errors });
      console.error("[SocialEvents] create failed:", error);
      res.status(500).json({ message: "Failed to create event" });
    }
  });

  app.get("/api/social-events", requireAuth, async (req, res) => {
    try {
      const rows = await storage.getSocialEventsByHost(req.user!.id);
      res.json(rows.map((r) => ({ ...hostView(r, req), yesCount: r.yesCount, headcount: r.headcount, declinedCount: r.declinedCount })));
    } catch {
      res.status(500).json({ message: "Failed to load your events" });
    }
  });

  // Account notices: the host's own strikes / ban / suspension, each with an appeal button.
  app.get("/api/social-events/privacy-info", requireAuth, async (_req, res) => {
    res.json({ retentionDays: await getConfig("guest_data_retention_days") });
  });

  app.get("/api/social-events/notices", requireAuth, async (req, res) => {
    try {
      const uid = req.user!.id;
      const [strikes, banRows, susp, open] = await Promise.all([
        db.select().from(userStrikes).where(and(eq(userStrikes.userId, uid), isNull(userStrikes.revokedAt))).orderBy(desc(userStrikes.createdAt)),
        db.select().from(bans).where(and(eq(bans.userId, uid), eq(bans.kind, "user"), isNull(bans.liftedAt))).orderBy(desc(bans.createdAt)),
        db.select().from(userSuspensions).where(and(eq(userSuspensions.userId, uid), eq(userSuspensions.isActive, true))),
        db.select({ subjectId: moderationAppeals.subjectId }).from(moderationAppeals).where(and(eq(moderationAppeals.userId, uid), eq(moderationAppeals.status, "open"))),
      ]);
      const appealing = new Set(open.map((o) => o.subjectId));
      res.json({
        notices: [
          ...strikes.filter((s) => !s.expiresAt || new Date(s.expiresAt) > new Date()).map((s) => ({ subjectType: "strike", subjectId: s.id, kind: s.type, reason: s.reason, createdAt: s.createdAt, appealing: appealing.has(s.id) })),
          ...banRows.map((b) => ({ subjectType: "ban", subjectId: b.id, kind: "ban", reason: b.reason, createdAt: b.createdAt, appealing: appealing.has(b.id) })),
          ...susp.map((x) => ({ subjectType: "suspension", subjectId: x.id, kind: "suspension", reason: x.reason, createdAt: x.createdAt, appealing: appealing.has(x.id) })),
        ],
      });
    } catch {
      res.status(500).json({ message: "Couldn't load your notices" });
    }
  });

  app.get("/api/social-events/:id", requireAuth, async (req, res) => {
    try {
      const rows = await storage.getSocialEventsByHost(req.user!.id);
      const row = rows.find((r) => r.id === req.params.id);
      if (!row) return res.status(404).json({ message: "Event not found" });
      res.json({ ...hostView(row, req), yesCount: row.yesCount, headcount: row.headcount, declinedCount: row.declinedCount });
    } catch {
      res.status(500).json({ message: "Failed to load event" });
    }
  });

  app.patch("/api/social-events/:id", requireSocialHost, async (req, res) => {
    try {
      const event = await storage.getSocialEventForHost(req.params.id, req.user!.id);
      if (!event) return res.status(404).json({ message: "Event not found" });
      if (event.isCancelled) return res.status(400).json({ message: "This event has been cancelled" });
      if (event.moderationStatus === "removed") return res.status(400).json({ message: "This event was removed" });
      const d = socialEventUpdateDto.parse(req.body);

      if (d.capacity !== undefined && d.capacity < event.ticketsSold) {
        return res.status(400).json({ message: `Capacity can't be below the ${event.ticketsSold} guests already confirmed` });
      }
      if (d.maxPlusOnes !== undefined && d.maxPlusOnes < event.maxPlusOnes) {
        // Existing RSVPs may already exceed a lowered cap; only allow raising it.
        return res.status(400).json({ message: "Plus-one limit can only be raised once invitations are out" });
      }
      const start = d.eventDate ?? event.eventDate;
      const end = d.eventEndDate === undefined ? event.eventEndDate : d.eventEndDate;
      if (d.eventDate && d.eventDate.getTime() <= Date.now()) return res.status(400).json({ message: "Event date must be in the future" });
      if (end && new Date(end).getTime() <= new Date(start).getTime()) return res.status(400).json({ message: "End time must be after the start time" });
      const age = d.ageRestriction ?? event.ageRestriction;
      const alcohol = d.servesAlcohol ?? event.servesAlcohol;
      if (alcohol && age === "all") return res.status(400).json({ message: ALCOHOL_RULE, code: "ALCOHOL_NEEDS_AGE_LIMIT" });

      const patch: Parameters<typeof storage.updateEvent>[1] = {};
      if (d.title !== undefined) patch.title = clean(d.title);
      if (d.description !== undefined) patch.description = clean(d.description);
      if (d.eventDate !== undefined) patch.eventDate = d.eventDate;
      if (d.eventEndDate !== undefined) patch.eventEndDate = d.eventEndDate;
      if (d.location !== undefined) patch.location = clean(d.location);
      if (d.city !== undefined) patch.city = cleanOrNull(d.city);
      if (d.exactAddress !== undefined) patch.exactAddress = clean(d.exactAddress);
      if (d.capacity !== undefined) patch.ticketsAvailable = d.capacity;
      if (d.maxPlusOnes !== undefined) patch.maxPlusOnes = d.maxPlusOnes;
      if (d.dressCode !== undefined) patch.dressCode = cleanOrNull(d.dressCode);
      if (d.schedule !== undefined) {
        patch.lineup = d.schedule?.map((s) => ({ name: clean(s.name), ...(s.time ? { time: clean(s.time) } : {}) })).filter((s) => s.name) ?? null;
      }
      if (d.ageRestriction !== undefined) patch.ageRestriction = d.ageRestriction;
      if (d.servesAlcohol !== undefined) patch.servesAlcohol = d.servesAlcohol;
      if (d.imageUrl !== undefined) patch.imageUrl = d.imageUrl;

      // Public events: edits are re-judged, so an approved listing can't be swapped for a scam later.
      const textChanged = ["title", "description", "location", "dressCode", "lineup"].some((k) => (patch as Record<string, unknown>)[k] !== undefined);
      if (event.visibility === "public" && textChanged) {
        const user = (await storage.getUser(req.user!.id))!;
        const trust = await getTrustInfo(user);
        const verdict = await judgeContent(
          {
            title: patch.title ?? event.title,
            description: patch.description ?? event.description,
            location: patch.location ?? event.location,
            dressCode: patch.dressCode === undefined ? event.dressCode : patch.dressCode,
            schedule: (patch.lineup === undefined ? event.lineup : patch.lineup) ?? null,
          },
          trust,
        );
        if (verdict.action === "block") return res.status(400).json({ message: BLOCKED_MSG, code: "CONTENT_BLOCKED" });
        const reopened = event.moderationStatus === "changes_requested";
        if (verdict.action === "queue" || reopened || (trust.isNew && event.moderationStatus === "approved")) {
          patch.moderationStatus = "pending";
          patch.queueReason = verdict.action === "queue" ? verdict.reason : reopened ? "edit_requested" : "new_account_review";
          patch.autoFlags = verdict.flags;
          patch.queuedAt = new Date();
        }
      }

      if (Object.keys(patch).length === 0) return res.json(hostView(event, req)); // nothing editable was sent (e.g. only visibility)
      const updated = await storage.updateEvent(event.id, patch);
      res.json(hostView(updated, req));
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ message: "Invalid event data", errors: error.errors });
      console.error("[SocialEvents] update failed:", error);
      res.status(500).json({ message: "Failed to update event" });
    }
  });

  app.post("/api/social-events/:id/cancel", requireAuth, async (req, res) => {
    try {
      const event = await storage.getSocialEventForHost(req.params.id, req.user!.id);
      if (!event) return res.status(404).json({ message: "Event not found" });
      if (event.isCancelled) return res.json(hostView(event, req));
      const updated = await storage.updateEvent(event.id, { isCancelled: true, cancelledAt: new Date() });
      res.json(hostView(updated, req));
    } catch {
      res.status(500).json({ message: "Failed to cancel event" });
    }
  });

  // Replace the invite link (e.g. it leaked). Old link stops working immediately;
  // existing RSVPs are unaffected.
  app.post("/api/social-events/:id/rotate-invite", requireAuth, async (req, res) => {
    try {
      const event = await storage.getSocialEventForHost(req.params.id, req.user!.id);
      if (!event) return res.status(404).json({ message: "Event not found" });
      const updated = await storage.updateEvent(event.id, { inviteToken: newToken(18) });
      res.json(hostView(updated, req));
    } catch {
      res.status(500).json({ message: "Failed to rotate invite link" });
    }
  });

  // Guest list: host only, JSON only (no export), every read is audit-logged.
  app.get("/api/social-events/:id/guests", requireAuth, async (req, res) => {
    try {
      const event = await storage.getSocialEventForHost(req.params.id, req.user!.id);
      if (!event) return res.status(404).json({ message: "Event not found" });
      await storage.createGuestDataAudit({
        actorType: "host",
        actorUserId: req.user!.id,
        eventId: event.id,
        dataAccessed: "guest_list",
        ipAddress: req.ip ?? null,
      });
      const guests = await storage.getSocialGuests(event.id);
      res.setHeader("Cache-Control", "no-store");
      res.json({ guests });
    } catch (error) {
      console.error("[SocialEvents] guest list failed:", error);
      res.status(500).json({ message: "Failed to load guest list" });
    }
  });

  // Host decides who gets the exact address (public events) or evicts a guest.
  const guestAction = (action: "approve" | "remove") => async (req: Request, res: Response) => {
    try {
      const event = await storage.getSocialEventForHost(req.params.id, req.user!.id);
      if (!event) return res.status(404).json({ message: "Event not found" });
      const ticket = await storage.setSocialGuestStatus(event.id, req.params.ticketId, action);
      if (!ticket) return res.status(404).json({ message: "Guest not found" });
      if (event.visibility === "public") invalidateCache.events();
      if (ticket.userId) {
        deliverNotification({
          userId: ticket.userId,
          type: action === "approve" ? "rsvp_approved" : "rsvp_removed",
          title: action === "approve" ? "You're in" : "RSVP removed",
          message: action === "approve" ? `${event.title}: the host approved your RSVP. The address is now on the event page.` : `${event.title}: the host removed your RSVP.`,
          link: `/i/${event.visibility === "public" ? event.id : event.inviteToken}`,
          relatedEntityId: event.id,
        }).catch((e) => console.error("[SocialEvents] guest notification failed:", e));
      }
      res.json({ ok: true });
    } catch (error) {
      console.error("[SocialEvents] guest action failed:", error);
      res.status(500).json({ message: "Couldn't update that guest" });
    }
  };
  app.post("/api/social-events/:id/guests/:ticketId/approve", requireAuth, guestAction("approve"));
  app.post("/api/social-events/:id/guests/:ticketId/remove", requireAuth, guestAction("remove"));

  // Host appeals a takedown. Lands in the admin moderation queue (Phase 4).
  app.post("/api/social-events/:id/appeal", requireAuth, async (req, res) => {
    try {
      const event = await storage.getSocialEventForHost(req.params.id, req.user!.id);
      if (!event) return res.status(404).json({ message: "Event not found" });
      if (!["hidden", "rejected", "removed", "changes_requested"].includes(event.moderationStatus)) {
        return res.status(400).json({ message: "There's nothing to appeal on this event" });
      }
      const { message } = socialAppealDto.parse(req.body);
      const [open] = await db.select({ id: moderationAppeals.id }).from(moderationAppeals).where(and(eq(moderationAppeals.subjectType, "event"), eq(moderationAppeals.subjectId, event.id), eq(moderationAppeals.status, "open")));
      if (open) return res.status(409).json({ message: "You already have an appeal waiting for review" });
      await db.insert(moderationAppeals).values({ userId: req.user!.id, subjectType: "event", subjectId: event.id, message: clean(message) });
      res.status(201).json({ message: "Appeal sent. We'll review it and get back to you." });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ message: error.errors[0]?.message ?? "Please add a short message" });
      console.error("[SocialEvents] appeal failed:", error);
      res.status(500).json({ message: "Couldn't send your appeal" });
    }
  });

  // Appeal a strike / ban / suspension that belongs to YOU. (Event takedowns use /:id/appeal.)
  app.post("/api/social-events/appeals", requireAuth, async (req, res) => {
    try {
      const b = z.object({ subjectType: z.enum(["strike", "ban", "suspension"]), subjectId: z.string().min(1).max(64), message: socialAppealDto.shape.message }).parse(req.body);
      const uid = req.user!.id;
      const table = b.subjectType === "strike" ? userStrikes : b.subjectType === "ban" ? bans : userSuspensions;
      const [row] = await db.select({ userId: table.userId }).from(table).where(eq(table.id, b.subjectId));
      if (!row || row.userId !== uid) return res.status(404).json({ message: "Nothing to appeal" });
      const [open] = await db.select({ id: moderationAppeals.id }).from(moderationAppeals).where(and(eq(moderationAppeals.subjectType, b.subjectType), eq(moderationAppeals.subjectId, b.subjectId), eq(moderationAppeals.status, "open")));
      if (open) return res.status(409).json({ message: "You already have an appeal waiting for review" });
      await db.insert(moderationAppeals).values({ userId: uid, subjectType: b.subjectType, subjectId: b.subjectId, message: clean(b.message) });
      res.status(201).json({ message: "Appeal sent. We'll review it and get back to you." });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ message: error.errors[0]?.message ?? "Please add a short message" });
      console.error("[SocialEvents] account appeal failed:", error);
      res.status(500).json({ message: "Couldn't send your appeal" });
    }
  });

  // --------------------------------------------------------- invitee side
  // Private events: link-based, no account. Public events: reachable by event id (that URL is
  // what discovery links to). Everything here is no-store; private links are also noindex.
  // anyStatus: opting out (deleting your own data) must keep working even when moderation has taken the event down.
  const loadInvite = async (req: Request, res: Response, anyStatus = false): Promise<Event | null> => {
    res.setHeader("Cache-Control", "no-store");
    const token = req.params.token;
    let event: Event | undefined;
    if (token && UUID.test(token)) event = await storage.getPublicSocialEvent(token);
    else if (token && token.length >= 10 && token.length <= 64) event = await storage.getSocialEventByInviteToken(token);
    if (!event || (!anyStatus && event.moderationStatus !== "approved")) {
      res.status(404).json({ message: "This invitation link isn't valid" });
      return null;
    }
    if (event.visibility === "private") res.setHeader("X-Robots-Tag", "noindex, nofollow");
    return event;
  };

  const identity = (req: Request) => {
    const header = req.header("x-rsvp-token");
    return {
      userId: req.isAuthenticated() ? req.user!.id : null,
      tokenHash: !req.isAuthenticated() && header && header.length <= 100 ? sha256(header) : null,
    };
  };

  const rsvpView = (event: Event, t: { guestName: string | null; status: string; plusOneCount: number; addressApprovedAt: Date | null }) => {
    const attending = t.status === "confirmed";
    return {
      responded: true,
      name: t.guestName,
      attending,
      plusOneCount: t.plusOneCount,
      removed: t.status === "removed",
      // The exact address only after the host's approval (instant for private events on a "yes").
      address: attending && t.addressApprovedAt && !event.isCancelled ? event.exactAddress : null,
      addressPending: attending && !t.addressApprovedAt && !event.isCancelled,
    };
  };

  app.get("/api/invite/:token", inviteRsvpLimiter, async (req, res) => {
    try {
      const event = await loadInvite(req, res);
      if (!event) return;
      const host = await storage.getUser(event.organizerId);
      res.json({
        ...(event.visibility === "public" ? { id: event.id } : {}),
        visibility: event.visibility,
        requiresLogin: event.visibility === "public",
        title: event.title,
        description: event.description,
        socialType: event.socialType,
        eventDate: event.eventDate,
        eventEndDate: event.eventEndDate,
        area: event.location,
        dressCode: event.dressCode,
        schedule: event.lineup ?? [],
        ageRestriction: event.ageRestriction,
        servesAlcohol: event.servesAlcohol,
        imageUrl: event.imageUrl,
        maxPlusOnes: event.maxPlusOnes,
        hostName: host?.displayName || host?.username || "Your host",
        cancelled: event.isCancelled,
        closed: hasEnded(event),
        full: event.ticketsSold >= event.ticketsAvailable,
        privacy: { controller: "Vib3Pulse", retentionDays: await getConfig("guest_data_retention_days"), contactEmail: process.env.PRIVACY_CONTACT_EMAIL || null },
      });
    } catch {
      res.status(500).json({ message: "Failed to load invitation" });
    }
  });

  app.get("/api/invite/:token/rsvp", inviteRsvpLimiter, async (req, res) => {
    try {
      const event = await loadInvite(req, res);
      if (!event) return;
      const ticket = await storage.getSocialTicket(event.id, identity(req));
      res.json(ticket ? rsvpView(event, ticket) : { responded: false });
    } catch {
      res.status(500).json({ message: "Failed to load your RSVP" });
    }
  });

  // Opt out: delete my response, my name and my plus-one count for this event. Works for guests without
  // an account (they prove it is theirs with the private token only their browser holds) and for accounts.
  app.delete("/api/invite/:token/rsvp", inviteRsvpLimiter, async (req, res) => {
    try {
      const event = await loadInvite(req, res, true);
      if (!event) return;
      const who = identity(req);
      if (!who.userId && !who.tokenHash) return res.status(401).json({ message: "We can't tell which response is yours from this device.", code: "NOT_YOURS" });
      const removed = await removeGuestRsvp({ eventId: event.id, userId: who.userId, tokenHash: who.tokenHash });
      if (!removed) return res.status(404).json({ message: "No response found for you on this event.", code: "NOTHING_TO_DELETE" });
      res.json({ deleted: true });
    } catch (error) {
      console.error("[SocialEvents] opt-out failed:", (error as Error).message);
      res.status(500).json({ message: "Couldn't delete your response" });
    }
  });

  app.put("/api/invite/:token/rsvp", inviteRsvpLimiter, async (req, res) => {
    try {
      const event = await loadInvite(req, res);
      if (!event) return;
      if (event.isCancelled) return res.status(400).json({ message: "This event has been cancelled", code: "CANCELLED" });
      if (hasEnded(event)) return res.status(400).json({ message: "This event has already happened", code: "CLOSED" });

      const d = socialRsvpDto.parse(req.body);
      if (d.attending && d.plusOneCount > event.maxPlusOnes) {
        return res.status(400).json({ message: event.maxPlusOnes === 0 ? "This event doesn't allow plus-ones" : `You can bring up to ${event.maxPlusOnes} plus-one(s)` });
      }

      const isPublic = event.visibility === "public";
      const who = identity(req);
      if (isPublic) {
        if (!who.userId) return res.status(401).json({ message: "Log in to RSVP to this event", code: "LOGIN_REQUIRED" });
        if (d.attending) {
          const need = minAgeFor(event.ageRestriction);
          if (need > 0) {
            const guest = await storage.getUser(who.userId);
            const age = ageFromDob(guest?.dateOfBirth);
            if (age === null) return res.status(403).json({ message: `This event is ${event.ageRestriction}. Add your date of birth to your profile to RSVP.`, code: "DOB_REQUIRED" });
            if (age < need) return res.status(403).json({ message: `This event is ${event.ageRestriction} only.`, code: "UNDER_AGE" });
          }
        }
      }

      const freshToken = who.userId ? null : newToken(24);
      const result = await storage.upsertSocialRsvp({
        eventId: event.id,
        userId: who.userId,
        existingTokenHash: who.tokenHash,
        newTokenHash: freshToken ? sha256(freshToken) : null,
        name: clean(d.name),
        attending: d.attending,
        plusOneCount: d.plusOneCount,
        autoApproveAddress: !isPublic,
      });
      if (result.full) return res.status(409).json({ message: "Sorry, this event is full", code: "FULL" });
      if ("removed" in result && result.removed) return res.status(403).json({ message: "The host has removed your RSVP for this event.", code: "REMOVED" });
      if (!("ticket" in result)) return res.status(500).json({ message: "Failed to save your RSVP" });
      if (isPublic) invalidateCache.events(); // discovery cards show remaining spots

      if (result.attendingChanged) {
        // No guest name here on purpose: notifications are stored and pushed, and would outlive the
        // retention window. The host reads names in the guest list, which is access-logged and expires.
        const plus = result.ticket.plusOneCount > 0 ? ` (+${result.ticket.plusOneCount})` : "";
        deliverNotification({
          userId: event.organizerId,
          type: "event_rsvp",
          title: d.attending ? (isPublic ? "RSVP waiting for approval" : "New RSVP") : "RSVP update",
          message: d.attending ? `A guest${plus} ${isPublic ? "wants to come to" : "is coming to"} ${event.title}. Open your guest list to see who.` : `A guest can't make it to ${event.title}.`,
          link: `/social-events/${event.id}`,
          relatedEntityId: event.id,
        }).catch((e) => console.error("[SocialEvents] host notification failed:", e));
      }

      res.json({
        ...rsvpView(event, result.ticket),
        // Returned once, only when a brand-new no-account guest is created; the client keeps it
        // to edit this RSVP later. Only its hash is stored.
        ...(result.created && freshToken ? { manageToken: freshToken } : {}),
      });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ message: "Please check your answers", errors: error.errors });
      console.error("[SocialEvents] RSVP failed:", error);
      res.status(500).json({ message: "Failed to save your RSVP" });
    }
  });
}

// Guest lists can be READ by the host (JSON, access-logged) but never DOWNLOADED, by anyone. This is a
// safety net on top of simply having no export route: it refuses spreadsheet-style URLs and Accept
// headers, and makes it impossible for any handler on these paths to set a CSV / attachment header.
const GUEST_DATA_PATHS = ["/api/social-events", "/api/invite", "/api/admin/events", "/api/admin/moderation", "/api/admin/reveal-grants", "/api/admin/reveal-activity"];
const EXPORT_EXT = /\.(csv|tsv|xlsx?|ods|numbers)$/i;
const EXPORT_FORMAT = /^(csv|tsv|xlsx?|ods|excel|numbers)$/i;
const EXPORT_ACCEPT = /text\/csv|text\/tab-separated|spreadsheetml|ms-excel|opendocument\.spreadsheet/i;

export function registerGuestDataExportBlock(app: Express): void {
  app.use(GUEST_DATA_PATHS, (req: Request, res: Response, next: NextFunction) => {
    const wanted = String(req.query.format ?? req.query.export ?? req.query.as ?? "");
    if (EXPORT_EXT.test(req.path) || EXPORT_FORMAT.test(wanted)) return res.status(404).json({ message: "Not found" });
    if (EXPORT_ACCEPT.test(String(req.headers.accept ?? ""))) return res.status(406).json({ message: "Guest data can't be exported", code: "EXPORT_BLOCKED" });
    const set = res.setHeader.bind(res);
    res.setHeader = ((name: string, value: unknown) => {
      const n = String(name).toLowerCase();
      const v = String(Array.isArray(value) ? value.join(",") : value);
      if ((n === "content-type" && EXPORT_ACCEPT.test(v)) || (n === "content-disposition" && /attachment/i.test(v))) {
        throw new Error("Guest data can't be exported");
      }
      return set(name, value as never);
    }) as typeof res.setHeader;
    next();
  });
}
