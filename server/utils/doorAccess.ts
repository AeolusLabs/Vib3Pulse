// Shared door logic for events and venue nights: who is at the door (staff token or owning
// organiser), staff code redemption (64-char code OR 6-digit PIN), and ticket validation.
// events-routes.ts and venue-routes.ts delegate here so the two flows cannot drift apart.
import type { Request, Response } from "express";
import crypto from "crypto";
import { z } from "zod";
import { storage } from "../storage";
import { toPublicUser } from "../auth";
import { normalizeShortCode, isCompleteShortCode } from "@shared/ticketCode";
import {
  admitTicket,
  buildTicketInfo,
  findTicketsByShortCode,
  type DoorActor,
  type DoorKind,
  type DoorTicket,
} from "../doorStorage";

// ── PIN lockout ──────────────────────────────────────────────────────────────
// A PIN has only 1M values, and authRateLimiter is per-IP, so a botnet (or a patient phone-hopper)
// could still walk the space. This is a second, per-event/night limiter that counts WRONG PINs
// across ALL IPs: PIN_MAX_FAILURES within PIN_WINDOW_MS locks PIN login for that event/night
// (429, reason "locked") until the oldest failure ages out. The 64-char code link is unaffected,
// so the organiser can always hand a link over. In-memory on purpose: one Node process, state
// only needs to outlive an attack burst, and a restart resets it (the IP limiter still applies).
// Trade-off: someone can lock out PIN login for one event by spamming wrong PINs; that is
// preferable to letting them guess.
export const PIN_MAX_FAILURES = 10;
export const PIN_WINDOW_MS = 15 * 60 * 1000;
const pinFailures = new Map<string, number[]>();

function liveFailures(key: string, now: number): number[] {
  const recent = (pinFailures.get(key) ?? []).filter((t) => now - t < PIN_WINDOW_MS);
  if (recent.length) pinFailures.set(key, recent); else pinFailures.delete(key);
  return recent;
}

/** Seconds until PIN login unlocks, or 0 when not locked. */
export function pinLockedFor(key: string, now = Date.now()): number {
  const recent = liveFailures(key, now);
  if (recent.length < PIN_MAX_FAILURES) return 0;
  return Math.max(1, Math.ceil((recent[0] + PIN_WINDOW_MS - now) / 1000));
}

function recordPinFailure(key: string, now = Date.now()): number {
  // Keys are only recorded for events/nights that exist, but sweep anyway so the map cannot grow forever.
  if (pinFailures.size > 5000) for (const k of Array.from(pinFailures.keys())) liveFailures(k, now);
  const recent = liveFailures(key, now);
  recent.push(now);
  pinFailures.set(key, recent);
  return Math.max(0, PIN_MAX_FAILURES - recent.length);
}

/** Test hook. */
export function resetPinLockouts(): void { pinFailures.clear(); }

// ── Scope + staff-code adapters ──────────────────────────────────────────────

export interface DoorScope {
  id: string;
  title: string;
  date: Date | null;
  organizerId: string;
  capacity: number | null;
}

export async function getDoorScope(kind: DoorKind, id: string): Promise<DoorScope | null> {
  if (kind === "event") {
    const event = await storage.getEvent(id);
    if (!event) return null;
    return {
      id: event.id, title: event.title, date: event.eventDate ?? null, organizerId: event.organizerId,
      capacity: event.ticketsAvailable > 0 ? event.ticketsAvailable : null,
    };
  }
  const night = await storage.getVenueEntryNight(id);
  if (!night) return null;
  const venue = await storage.getVenue(night.venueId);
  if (!venue) return null;
  return { id: night.id, title: night.name, date: night.date ?? null, organizerId: venue.ownerId, capacity: night.capacity ?? null };
}

interface StaffRow {
  id: string;
  scopeId: string;
  status: string;
  expiresAt: Date;
  validatedBy: string | null;
  scanCount: number;
  scannerToken: string | null;
}

function normStaff(kind: DoorKind, r: any): StaffRow | null {
  if (!r) return null;
  return {
    id: r.id, scopeId: kind === "event" ? r.eventId : r.venueEntryNightId, status: r.status,
    expiresAt: r.expiresAt, validatedBy: r.validatedBy, scanCount: r.scanCount, scannerToken: r.scannerToken,
  };
}

async function staffByToken(kind: DoorKind, token: string) {
  return normStaff(kind, kind === "event"
    ? await storage.getStaffCodeByScannerToken(token)
    : await storage.getVenueStaffCodeByScannerToken(token));
}

/** Resolves an X-Scanner-Token to its staff code (event or venue), or an error to send. */
export async function resolveScannerToken(token: string):
  Promise<{ ok: true; kind: DoorKind; staff: StaffRow } | { ok: false; status: number; body: any }> {
  for (const kind of ["event", "venue"] as DoorKind[]) {
    const staff = await staffByToken(kind, token);
    if (!staff) continue;
    if (staff.status !== "active") return { ok: false, status: 401, body: { message: "Invalid or expired scanner token" } };
    if (new Date() > staff.expiresAt) return { ok: false, status: 401, body: { message: "Scanner token has expired" } };
    return { ok: true, kind, staff };
  }
  return { ok: false, status: 401, body: { message: "Invalid or expired scanner token" } };
}

export type ActorResult =
  | { ok: true; actor: DoorActor; scope: DoorScope }
  | { ok: false; status: number; body: any };

/** Staff token (scoped to this event/night) or the owning organiser's session. */
export async function resolveDoorActor(req: Request, kind: DoorKind, scopeId: string): Promise<ActorResult> {
  const token = req.headers["x-scanner-token"] as string | undefined;
  const noun = kind === "event" ? "event" : "venue event";
  if (token) {
    const staff = normStaff(kind, kind === "event"
      ? await storage.getStaffCodeByScannerToken(token)
      : await storage.getVenueStaffCodeByScannerToken(token));
    if (!staff || staff.status !== "active") return { ok: false, status: 401, body: { message: "Invalid or expired scanner token" } };
    if (new Date() > staff.expiresAt) return { ok: false, status: 401, body: { message: "Scanner token has expired" } };
    if (staff.scopeId !== scopeId) return { ok: false, status: 403, body: { message: `Scanner not authorised for this ${noun}` } };
    const scope = await getDoorScope(kind, scopeId);
    if (!scope) return { ok: false, status: 404, body: { message: kind === "event" ? "Event not found" : "Venue not found" } };
    return { ok: true, scope, actor: { type: "staff", staffCodeId: staff.id, name: staff.validatedBy || "Staff", organizerId: scope.organizerId } };
  }
  if (req.isAuthenticated()) {
    const scope = await getDoorScope(kind, scopeId);
    if (!scope) return { ok: false, status: 404, body: { message: kind === "event" ? "Event not found" : "Entry night not found" } };
    if (scope.organizerId !== req.user!.id) {
      return { ok: false, status: 403, body: { message: kind === "event" ? "Not authorised to validate tickets for this event" : "You can only validate tickets for your own venues" } };
    }
    const u = req.user as any;
    return { ok: true, scope, actor: { type: "organizer", staffCodeId: null, name: u.displayName || u.username || "Organiser", organizerId: u.id } };
  }
  return { ok: false, status: 401, body: { message: "Authentication required" } };
}

// ── Staff code redemption ────────────────────────────────────────────────────

const redeemSchema = z.object({
  staffName: z.string().min(1).max(80),
  code: z.string().length(64).optional(),
  pin: z.string().regex(/^\d{6}$/, "PIN must be 6 digits").optional(),
}).refine((d) => (d.code === undefined) !== (d.pin === undefined), {
  message: "Send either a 64-character code or a 6-digit pin",
});

const REDEEM_FAIL = {
  invalid: (viaPin: boolean) => ({ status: 404, reason: "invalid", message: viaPin ? "That PIN isn't right. Check it with the organiser and try again." : "That code isn't valid for this event. Check it and try again." }),
  revoked: { status: 403, reason: "revoked", message: "This code was revoked by the organiser. Ask them for a new one." },
  in_use: { status: 409, reason: "in_use", message: "This code is already signed in on another device. Ask the organiser for a new one." },
  expired: { status: 410, reason: "expired", message: "This code has expired. Ask the organiser for a fresh one." },
} as const;

function failRedeem(res: Response, f: { status: number; reason: string; message: string }, extra: object = {}) {
  return res.status(f.status).json({ message: f.message, reason: f.reason, ...extra });
}

/**
 * POST .../staff-access/validate. Body: { staffName, code } or { staffName, pin }, scoped to the
 * event / night in the URL. Same statuses as before (404 invalid, 403 revoked, 409 in use,
 * 410 expired) plus `reason`; 429 reason "locked" once the per-event PIN lockout trips.
 */
export async function handleStaffRedeem(kind: DoorKind, scopeId: string, req: Request, res: Response) {
  try {
    const parsed = redeemSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid request", reason: "bad_request", errors: parsed.error.errors });
    }
    const { code, pin, staffName } = parsed.data;

    const scope = await getDoorScope(kind, scopeId);
    if (!scope) return failRedeem(res, REDEEM_FAIL.invalid(pin !== undefined));

    const lockKey = `${kind}:${scopeId}`;
    let row: StaffRow | null;
    if (pin !== undefined) {
      const wait = pinLockedFor(lockKey);
      if (wait) {
        res.setHeader("Retry-After", String(wait));
        return res.status(429).json({
          message: "Too many wrong PINs for this event. PIN sign-in is paused for a few minutes. Use the staff link or ask the organiser.",
          reason: "locked",
          retryAfterSeconds: wait,
        });
      }
      row = normStaff(kind, kind === "event" ? await storage.getStaffCodeByPin(scopeId, pin) : await storage.getVenueStaffCodeByPin(scopeId, pin));
      if (!row) {
        const left = recordPinFailure(lockKey);
        return failRedeem(res, REDEEM_FAIL.invalid(true), { attemptsLeft: left });
      }
    } else {
      // Scoped: a code from another event/night is indistinguishable from an unknown one.
      row = normStaff(kind, kind === "event" ? await storage.getStaffCodeByCode(code!) : await storage.getVenueStaffCodeByCode(code!));
      if (!row || row.scopeId !== scopeId) return failRedeem(res, REDEEM_FAIL.invalid(false));
    }

    if (row.status === "revoked") return failRedeem(res, REDEEM_FAIL.revoked);
    if (row.status === "active") return failRedeem(res, REDEEM_FAIL.in_use);
    if (new Date() > row.expiresAt) return failRedeem(res, REDEEM_FAIL.expired);

    const scannerToken = crypto.randomBytes(32).toString("hex");
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "";
    const ua = req.headers["user-agent"] || "";
    const redeemed: any = kind === "event"
      ? await storage.redeemStaffCode(row.id, staffName, ip, ua, scannerToken)
      : await storage.redeemVenueStaffCode(row.id, staffName, ip, ua, scannerToken);

    res.json({
      scannerToken: redeemed.scannerToken,
      eventId: scopeId,
      eventTitle: scope.title,
      staffName: redeemed.validatedBy,
      expiresAt: redeemed.expiresAt,
    });
  } catch (error: any) {
    if (error.message === "Code already redeemed or revoked") return failRedeem(res, REDEEM_FAIL.in_use);
    console.error("Staff access validate error:", error);
    res.status(500).json({ message: "Failed to authenticate" });
  }
}

// ── Ticket validation ────────────────────────────────────────────────────────

const validateSchema = z.object({
  validationCode: z.string().min(1).optional(),
  shortCode: z.string().min(1).max(40).optional(),
  eventId: z.string().min(1), // events.id, or venue_entry_nights.id for kind 'venue'
}).refine((d) => (d.validationCode === undefined) !== (d.shortCode === undefined), {
  message: "Send either validationCode or shortCode",
});

/** The ticket object kept on validate responses (as before) minus the guest-token hash. */
function publicTicket(ticket: any, user: any) {
  const { guestTokenHash, ...rest } = ticket;
  return { ...rest, user: user ? toPublicUser(user) : undefined };
}

/**
 * POST /api/tickets/validate and /api/venue-tickets/validate.
 * HTTP status: every outcome the scanner shows as a result card is 200 (valid, already_used,
 * not_confirmed, wrong_event, not_found) with `valid:false` + `reason`; 409 reason "ambiguous"
 * for a short-code prefix hit on 2+ tickets; 400/401/403/404 only for request/auth problems.
 */
export async function handleTicketValidate(kind: DoorKind, req: Request, res: Response) {
  try {
    const parsed = validateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid request data", reason: "bad_request", errors: parsed.error.errors });
    }
    const { validationCode, shortCode, eventId } = parsed.data;

    const auth = await resolveDoorActor(req, kind, eventId);
    if (!auth.ok) return res.status(auth.status).json(auth.body);
    const { actor, scope } = auth;

    let ticket: DoorTicket | undefined;
    if (shortCode !== undefined) {
      if (!isCompleteShortCode(shortCode)) {
        return res.status(400).json({ message: "Enter all 8 characters of the code under the QR.", reason: "bad_request" });
      }
      const matches = await findTicketsByShortCode(kind, eventId, normalizeShortCode(shortCode));
      if (matches.length > 1) {
        return res.status(409).json({
          valid: false, alreadyCheckedIn: false, reason: "ambiguous",
          message: "That short code matches more than one ticket. Ask the guest for the full code or scan the QR.",
        });
      }
      ticket = matches[0];
    } else {
      const full = validationCode!.trim();
      ticket = kind === "event" ? await storage.getTicketByValidationCode(full) : await storage.getVenueTicketByValidationCode(full);
    }

    if (!ticket) {
      return res.json({ valid: false, alreadyCheckedIn: false, reason: "not_found", message: "No ticket matches that code." });
    }

    const ticketScope = kind === "event" ? (ticket as any).eventId : (ticket as any).venueEntryNightId;
    if (ticketScope !== eventId) {
      const other = await getDoorScope(kind, ticketScope);
      return res.json({
        valid: false, alreadyCheckedIn: false, reason: "wrong_event",
        message: kind === "event" ? "This ticket is for a different event." : "This ticket is for a different night.",
        ticketLabel: other?.title ?? null,
        ticketDate: other?.date ?? null,
      });
    }

    const user = ticket.userId ? await storage.getUser(ticket.userId) : undefined;
    const alreadyUsed = async (t: DoorTicket) => res.json({
      valid: false, alreadyCheckedIn: true, reason: "already_used", message: "Ticket already used",
      checkedInAt: t.checkedInAt, ticketInfo: await buildTicketInfo(kind, t), ticket: publicTicket(t, user),
    });

    // Events check status first (a refund after entry still reads as refunded); venue tickets flip
    // to status 'checked_in' on admit, so for them a check-in is tested first.
    if (kind === "venue" && ticket.checkedInAt) return alreadyUsed(ticket);
    const live = kind === "event" ? ticket.status === "confirmed" : ["confirmed", "checked_in"].includes(ticket.status);
    if (!live) {
      return res.json({
        valid: false, alreadyCheckedIn: false, reason: "not_confirmed",
        message: `Ticket is ${ticket.status} and cannot be used`,
        ticket: publicTicket(ticket, user),
      });
    }
    if (ticket.checkedInAt) return alreadyUsed(ticket);

    const updated = await admitTicket(kind, eventId, ticket, actor);
    if (!updated) {
      // Lost a race with a concurrent scan.
      const fresh = kind === "event" ? await storage.getTicket(ticket.id) : await storage.getVenueTicket(ticket.id);
      return alreadyUsed(fresh ?? ticket);
    }

    res.json({
      valid: true,
      alreadyCheckedIn: false,
      message: "Ticket validated successfully",
      ticketInfo: await buildTicketInfo(kind, updated),
      ticket: publicTicket(updated, user),
    });
  } catch (error) {
    console.error("Error validating ticket:", error);
    res.status(500).json({ message: "Failed to validate ticket" });
  }
}
