// Admin "Spray hosts" (finance roles): who can take spray money and who is stuck, with one support action. Registered from adminRoutes.ts.
// Usernames, yes/no checks, the bank's name and last four only: never the legal name, the full number, a birth date or a subaccount code.
import type { Express, Request, Response } from "express";
import { pool, storage } from "../storage";
import { requireRole } from "../services/adminSecurity";
import { resetPayoutMatch } from "../identity/payoutNameGuard";
import { AgeReviewError } from "../identity/ageReviewService";
import { PAYABLE_ACCOUNT_SQL } from "./payouts";

const FINANCE = ["super_admin", "finance_manager"] as const;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const SPRAY_HOST_FILTERS = ["all", "stuck", "ready", "spraying"] as const;
type Filter = (typeof SPRAY_HOST_FILTERS)[number];

export interface SprayHostRow {
  id: string; username: string;
  idVerified: boolean; hasName: boolean;
  bankName: string | null; last4: string | null; linked: boolean;
  /** Spray money can be paid to them now (a name-checked, payable account). */
  payable: boolean;
  /** Rooms that are not over and have spray switched on. */
  sprayRooms: number;
}

// One row per person who has done any part of it (ID check, a bank link, or a room with spray on).
const BASE = `
  select u.id, u.username,
    (u.age_verified_at is not null) as id_verified,
    exists(select 1 from user_verified_names n where n.user_id = u.id) as has_name,
    (select bank_name from organizer_payment_accounts a where a.user_id = u.id and a.provider = 'paystack' limit 1) as bank_name,
    (select account_last4 from organizer_payment_accounts a where a.user_id = u.id and a.provider = 'paystack' limit 1) as last4,
    exists(select 1 from organizer_payment_accounts a where a.user_id = u.id and a.provider = 'paystack') as linked,
    exists(select 1 from organizer_payment_accounts where user_id = u.id and ${PAYABLE_ACCOUNT_SQL}) as payable,
    (select count(*)::int from rooms r where r.host_id = u.id and r.spray_enabled = true and r.status <> 'ended') as spray_rooms
  from users u
  where u.deleted_at is null and ($1 = '' or u.username ilike $1)`;

const WHERE: Record<Filter, string> = {
  all: "id_verified or linked or spray_rooms > 0",
  // Did part of it but cannot be paid yet.
  stuck: "(id_verified or linked or spray_rooms > 0) and not payable",
  ready: "payable",
  // Has spray on in a room that is not over: the ones whose payouts matter most.
  spraying: "spray_rooms > 0",
};

export async function listSprayHosts(filter: Filter, q: string): Promise<SprayHostRow[]> {
  const like = q ? `%${q.replace(/[\\%_]/g, "\\$&")}%` : "";
  const { rows } = await pool.query(
    `select * from (${BASE}) h where ${WHERE[filter]} order by spray_rooms desc, payable asc, username limit 100`,
    [like],
  );
  return rows.map((r) => ({
    id: r.id, username: r.username, idVerified: r.id_verified, hasName: r.has_name,
    bankName: r.bank_name ?? null, last4: r.last4 ?? null, linked: r.linked, payable: r.payable, sprayRooms: r.spray_rooms,
  }));
}

/** A payout to this host is being sent: relinking now could redirect it, so support waits. */
async function payoutInFlight(userId: string): Promise<boolean> {
  const r = await pool.query(`select 1 from room_payouts where host_id = $1 and status = 'queued' and coalesce(last_error, '') <> 'NO_PAYOUT_ACCOUNT' limit 1`, [userId]);
  return (r.rowCount ?? 0) > 0;
}

export function registerSprayHostRoutes(app: Express): void {
  app.get("/api/admin/rooms/spray-hosts", requireRole(...FINANCE), async (req: Request, res: Response) => {
    try {
      const filter = (SPRAY_HOST_FILTERS as readonly string[]).includes(String(req.query.filter)) ? (String(req.query.filter) as Filter) : "stuck";
      const q = String(req.query.q ?? "").trim().slice(0, 40);
      res.json({ hosts: await listSprayHosts(filter, q) });
    } catch (e) {
      console.error("[ADMIN] spray hosts list failed:", (e as Error)?.message);
      res.status(500).json({ message: "Couldn't load the hosts." });
    }
  });

  // The account stays linked but cannot be paid until the host relinks it and passes the name check again.
  app.post("/api/admin/rooms/spray-hosts/:userId/reset-payout", requireRole(...FINANCE), async (req: Request, res: Response) => {
    const userId = String(req.params.userId ?? "");
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!ID.test(userId)) return res.status(404).json({ message: "Host not found" });
    if (reason.length < 3 || reason.length > 300) return res.status(400).json({ message: "Give a reason (3 to 300 characters).", code: "REASON_REQUIRED" });
    try {
      if (await payoutInFlight(userId)) return res.status(409).json({ message: "A payout to this host is being sent. Try again once it lands.", code: "PAYOUT_IN_FLIGHT" });
      await resetPayoutMatch(userId);
      await storage.logAdminActivity({ adminId: req.session.adminId!, action: "spray_host.reset_payout", targetType: "user", targetId: userId, details: reason.slice(0, 300) });
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof AgeReviewError) return res.status(e.status).json({ message: e.message, code: e.code });
      console.error("[ADMIN] spray host reset failed:", (e as Error)?.message);
      res.status(500).json({ message: "That did not work. Check the host's payout state before trying again." });
    }
  });
}
