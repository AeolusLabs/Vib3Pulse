// GET /api/rooms/:id/spray/quote?tier=&target= (or &side=A|B for a team): what this spray pays out, shown on the confirm sheet
// before the payer pays. Same split functions and saved rates as the real spray; for someone in the room only. Names are the
// ones the room already shows; no rate, fee formula or account detail is sent, only the rupee amounts.
import type { Express, Request, Response } from "express";
import { requireAuth } from "../middleware";
import { roomLimiter } from "../security";
import { storage } from "../storage";
import { isSprayTier } from "@shared/money";
import { teamSprayTiers } from "@shared/money";
import { singleQuote, teamQuote, type SprayQuote } from "@shared/sprayQuote";
import * as rs from "./roomStorage";
import { roomHub } from "./RoomHub";
import { roomFeatures } from "./features";
import { getRates } from "./roomRates";
import { isGamePlayer } from "./stage";

const nameOf = async (id: string): Promise<string> => {
  const u = await storage.getUser(id);
  return u?.displayName || u?.username || "Someone";
};

export function registerSprayQuoteRoute(app: Express): void {
  app.get("/api/rooms/:id/spray/quote", requireAuth, roomLimiter, async (req: Request, res: Response) => {
    try {
      if (!roomFeatures.spray) return res.status(404).json({ message: "Not found" });
      const roomId = String(req.params.id ?? "");
      const tier = req.query.tier;
      const room = await rs.getRoom(roomId);
      if (!room || !roomHub.get(roomId, req.user!.id) || !isSprayTier(tier)) return res.status(404).json({ message: "Not found" });
      const rates = await getRates();
      let quote: SprayQuote;
      if (req.query.side === "A" || req.query.side === "B") {
        if (!roomFeatures.gaming || !roomHub.gameOn(roomId)) return res.status(404).json({ message: "Not found" });
        const game = roomHub.gameOf(roomId);
        const present = game.teams[req.query.side].filter((id) => isGamePlayer(roomId, id) && !roomHub.get(roomId, id)?.away);
        if (present.length === 0 || !teamSprayTiers(present.length).includes(tier)) return res.status(404).json({ message: "Not found" });
        const featured = game.featured[req.query.side];
        quote = teamQuote(tier, room.hostId, present.map((id) => ({ userId: id, isHost: id === room.hostId })), featured && present.includes(featured) ? featured : null, rates);
      } else {
        const target = String(req.query.target ?? "");
        if (!target || !roomHub.get(roomId, target)) return res.status(404).json({ message: "Not found" });
        quote = singleQuote(tier, room.hostId, target, rates);
      }
      const names = new Map<string, string>();
      for (const p of quote.parts) if (!names.has(p.userId)) names.set(p.userId, await nameOf(p.userId));
      res.json({ ...quote, parts: quote.parts.map((p) => ({ ...p, name: names.get(p.userId) })) });
    } catch (e) {
      console.error("[rooms:spray] quote failed:", (e as Error)?.message ?? e);
      res.status(500).json({ message: "Failed to load the breakdown" });
    }
  });
}
