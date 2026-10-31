import type { Express } from "express";
import { storage } from "../storage";
import { publicLandingLimiter } from "../security";

// The only data the anonymous landing page loads. Built field by field (never `...event`), so a column added to
// the events table later can't reach the public by accident. No organizer, no coordinates, no tokens.
export interface PublicLandingEvent {
  id: string;
  title: string;
  category: string;
  eventDate: string;
  venue: string;
  city: string | null;
  minPrice: number; // smallest currency unit
  currency: string;
  imageUrl: string | null;
  externalTicketUrl: string | null;
  ageRestriction: string;
  description: string;
}

const TTL_MS = 60_000;
const MAX_PER_CATEGORY = 3;
const MAX_EVENTS = 18;

let memo: { at: number; events: PublicLandingEvent[] } | null = null;

const clip = (s: string | null | undefined, n: number) => (s ?? "").slice(0, n);
// Organiser-supplied URLs reach the page only if they are plain https links.
const httpsOnly = (u: string | null | undefined) => (u && /^https:\/\/[^\s]+$/i.test(u) ? u.slice(0, 500) : null);
const imageOnly = (u: string | null | undefined) => (u && (/^https:\/\/[^\s]+$/i.test(u) || /^\/[^\s/]/.test(u)) ? u.slice(0, 500) : null);

async function build(): Promise<PublicLandingEvent[]> {
  const now = Date.now();
  const upcoming = (await storage.getEvents())
    // getEvents() already limits to published + approved + public. Social (private-host) events never go on the landing page.
    .filter((e) => !e.isCancelled && e.kind !== "social" && new Date(e.eventDate).getTime() >= now)
    .sort((a, b) => new Date(a.eventDate).getTime() - new Date(b.eventDate).getTime());

  const perCategory = new Map<string, number>();
  const out: PublicLandingEvent[] = [];
  for (const e of upcoming) {
    const cat = clip(e.category, 40).toLowerCase();
    const seen = perCategory.get(cat) ?? 0;
    if (seen >= MAX_PER_CATEGORY) continue;
    perCategory.set(cat, seen + 1);
    out.push({
      id: e.id,
      title: clip(e.title, 120),
      category: cat,
      eventDate: new Date(e.eventDate).toISOString(),
      venue: clip(e.venueName || e.location, 120),
      city: e.city ? clip(e.city, 60) : null,
      minPrice: e.minPrice,
      currency: e.currency,
      imageUrl: imageOnly(e.imageUrl),
      externalTicketUrl: httpsOnly(e.externalTicketUrl),
      ageRestriction: e.ageRestriction,
      description: clip(e.description, 240),
    });
    if (out.length >= MAX_EVENTS) break;
  }
  return out;
}

export function registerPublicLandingRoutes(app: Express): void {
  app.get("/api/public/landing", publicLandingLimiter, async (_req, res) => {
    try {
      if (!memo || Date.now() - memo.at > TTL_MS) memo = { at: Date.now(), events: await build() };
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json({ events: memo.events });
    } catch (error) {
      console.error("Error building public landing events:", error);
      res.status(500).json({ message: "Failed to load events" });
    }
  });
}
