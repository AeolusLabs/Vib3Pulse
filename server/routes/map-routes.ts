import type { Express } from "express";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { and, eq, gte, lte, lt, gt, or, isNull, isNotNull, sql, inArray, type SQL } from "drizzle-orm";
import { db } from "../storage";
import { requireAuth } from "../middleware";
import { blockedWith } from "../utils/blocks";
import { events, venues, users, follows, userLocations, tickets, rsvps, mapSharingPrefs, mapAllowedViewers } from "@shared/schema";

const STALE_MINUTES = 30;
const MAX_RADIUS_KM = 25;
// 3 decimal places ≈ 111 m. Only the rounded value is ever stored or returned.
const round100m = (n: number) => Math.round(n * 1000) / 1000;

// Mutual follows, minus anyone blocked in either direction.
async function friendIdsOf(meId: string): Promise<string[]> {
  const [mutual, blocked] = await Promise.all([
    db.select({ id: follows.followingId }).from(follows).where(and(
      eq(follows.followerId, meId),
      sql`EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id = ${follows.followingId} AND f2.following_id = ${meId})`,
    )),
    blockedWith(meId),
  ]);
  return mutual.map((r) => r.id).filter((id) => !blocked.has(id));
}

export function registerMapRoutes(app: Express): void {
  const staleCutoff = sql`now() - interval '${sql.raw(String(STALE_MINUTES))} minutes'`;
  const fresh = () => sql`${userLocations.updatedAt} > ${staleCutoff}`;

  // The one definition of "a friend who is sharing their position with me right now": mutual follows (not blocked), a position
  // fresher than 30 minutes, and their audience setting (everyone, or selected with me on the list). The nearby map adds a
  // bounding box; the friends strip and friend search do not (a friend in another city is still a friend on the map).
  const friendsSharingWithMe = (meId: string, friendIds: string[], within?: SQL) => friendIds.length ? db.select({
    id: users.id, username: users.username, displayName: users.displayName, avatarUrl: users.avatarUrl, avatar: users.avatar,
    latitude: userLocations.latitude, longitude: userLocations.longitude, updatedAt: userLocations.updatedAt,
  }).from(userLocations)
    .innerJoin(users, eq(users.id, userLocations.userId))
    .leftJoin(mapSharingPrefs, eq(mapSharingPrefs.userId, userLocations.userId))
    .where(and(
      inArray(userLocations.userId, friendIds), fresh(), within,
      or(
        isNull(mapSharingPrefs.audience),
        eq(mapSharingPrefs.audience, "friends"),
        sql`EXISTS (SELECT 1 FROM ${mapAllowedViewers} v WHERE v.user_id = ${userLocations.userId} AND v.viewer_id = ${meId})`,
      ),
    )) : Promise.resolve([] as never[]);

  // Is the current user sharing right now?
  app.get("/api/map/me", requireAuth, async (req, res) => {
    try {
      const [row] = await db.select({ updatedAt: userLocations.updatedAt }).from(userLocations)
        .where(and(eq(userLocations.userId, req.user!.id), fresh()));
      res.json({ sharing: !!row });
    } catch (error) {
      console.error("Map me error:", error);
      res.status(500).json({ message: "Failed to load sharing status" });
    }
  });

  // Start / refresh sharing. Upsert of a single rounded point.
  app.put("/api/map/location", requireAuth, async (req, res) => {
    try {
      const { latitude, longitude } = z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      }).parse(req.body);
      const values = { latitude: round100m(latitude), longitude: round100m(longitude), updatedAt: new Date() };
      await db.insert(userLocations).values({ userId: req.user!.id, ...values })
        .onConflictDoUpdate({ target: userLocations.userId, set: values });
      res.json({ sharing: true });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ message: "Invalid location" });
      console.error("Map location error:", error);
      res.status(500).json({ message: "Failed to update location" });
    }
  });

  // Stop sharing: delete the row. Idempotent. The audience choice is kept separately.
  app.delete("/api/map/location", requireAuth, async (req, res) => {
    try {
      await db.delete(userLocations).where(eq(userLocations.userId, req.user!.id));
      res.json({ sharing: false });
    } catch (error) {
      console.error("Map stop sharing error:", error);
      res.status(500).json({ message: "Failed to stop sharing" });
    }
  });

  // Who can see me: all mutual friends, or a chosen subset. Also returns the pickable friends.
  app.get("/api/map/audience", requireAuth, async (req, res) => {
    try {
      const meId = req.user!.id;
      const friendIds = await friendIdsOf(meId);
      const [[prefs], allowed, friends] = await Promise.all([
        db.select().from(mapSharingPrefs).where(eq(mapSharingPrefs.userId, meId)),
        db.select({ viewerId: mapAllowedViewers.viewerId }).from(mapAllowedViewers).where(eq(mapAllowedViewers.userId, meId)),
        friendIds.length
          ? db.select({ id: users.id, username: users.username, displayName: users.displayName, avatarUrl: users.avatarUrl })
              .from(users).where(inArray(users.id, friendIds))
          : Promise.resolve([]),
      ]);
      const pickable = new Set(friendIds);
      res.json({
        audience: prefs?.audience === "selected" ? "selected" : "friends",
        viewerIds: allowed.map((a) => a.viewerId).filter((id) => pickable.has(id)),
        friends,
      });
    } catch (error) {
      console.error("Map audience error:", error);
      res.status(500).json({ message: "Failed to load sharing settings" });
    }
  });

  app.put("/api/map/audience", requireAuth, async (req, res) => {
    try {
      const body = z.object({
        audience: z.enum(["friends", "selected"]),
        viewerIds: z.array(z.string()).max(500).default([]),
      }).parse(req.body);
      const meId = req.user!.id;
      const pickable = new Set(await friendIdsOf(meId));
      const viewerIds = Array.from(new Set(body.viewerIds)).filter((id) => pickable.has(id));

      await db.transaction(async (tx) => {
        await tx.insert(mapSharingPrefs).values({ userId: meId, audience: body.audience })
          .onConflictDoUpdate({ target: mapSharingPrefs.userId, set: { audience: body.audience } });
        await tx.delete(mapAllowedViewers).where(eq(mapAllowedViewers.userId, meId));
        if (viewerIds.length) await tx.insert(mapAllowedViewers).values(viewerIds.map((viewerId) => ({ userId: meId, viewerId })));
      });
      res.json({ audience: body.audience, viewerIds });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ message: "Invalid sharing settings" });
      console.error("Map audience update error:", error);
      res.status(500).json({ message: "Failed to save sharing settings" });
    }
  });

  // Every friend sharing with me right now, however far away: feeds the friends strip and friend search on the map.
  app.get("/api/map/friends", requireAuth, async (req, res) => {
    try {
      const meId = req.user!.id;
      const friends = await friendsSharingWithMe(meId, await friendIdsOf(meId));
      friends.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      res.json({ friends: friends.slice(0, 200) });
    } catch (error) {
      console.error("Map friends error:", error);
      res.status(500).json({ message: "Failed to load friends" });
    }
  });

  // Friends sharing with me now + public upcoming events (with friends going) + venues in a bounding box.
  app.get("/api/map/nearby", requireAuth, async (req, res) => {
    try {
      const q = z.object({
        lat: z.coerce.number().min(-90).max(90),
        lng: z.coerce.number().min(-180).max(180),
        radiusKm: z.coerce.number().min(0.1).max(MAX_RADIUS_KM).default(5),
      }).parse(req.query);
      const meId = req.user!.id;
      const dLat = q.radiusKm / 111;
      const dLng = q.radiusKm / (111 * Math.max(Math.cos((q.lat * Math.PI) / 180), 0.01));
      const box = (lat: AnyPgColumn, lng: AnyPgColumn) => and(
        isNotNull(lat), isNotNull(lng),
        gte(lat, q.lat - dLat), lte(lat, q.lat + dLat),
        gte(lng, q.lng - dLng), lte(lng, q.lng + dLng),
      );

      // Housekeeping: stale rows are never served, so drop them.
      await db.delete(userLocations).where(lt(userLocations.updatedAt, staleCutoff));

      const friendIds = await friendIdsOf(meId);

      const [friends, nearEvents, nearVenues] = await Promise.all([
        friendsSharingWithMe(meId, friendIds, box(userLocations.latitude, userLocations.longitude)),

        db.select({
          id: events.id, title: events.title, eventDate: events.eventDate, eventEndDate: events.eventEndDate,
          latitude: events.latitude, longitude: events.longitude, imageUrl: events.imageUrl,
          location: events.location, category: events.category, ticketPrice: events.ticketPrice, currency: events.currency,
          building: events.building, isPromoted: events.isPromoted,
        }).from(events)
          .where(and(
            eq(events.isPublished, true), eq(events.moderationStatus, "approved"), eq(events.visibility, "public"),
            eq(events.isCancelled, false),
            // still on or starting later (3 h grace when no end date)
            or(gt(events.eventEndDate, sql`now()`), and(isNull(events.eventEndDate), gt(events.eventDate, sql`now() - interval '3 hours'`))),
            box(events.latitude, events.longitude),
          )).orderBy(events.eventDate).limit(60),

        db.select({
          id: venues.id, name: venues.name, category: venues.category, imageUrl: venues.imageUrl,
          address: venues.address, latitude: venues.latitude, longitude: venues.longitude,
          building: venues.building, isVerified: venues.isVerified, isPromoted: venues.isPromoted,
        }).from(venues).where(box(venues.latitude, venues.longitude)).limit(60),
      ]);

      // Mutual friends holding a confirmed ticket or RSVP for each event.
      type Going = { id: string; displayName: string | null; username: string; avatarUrl: string | null };
      const going = new Map<string, Map<string, Going>>();
      if (friendIds.length && nearEvents.length) {
        const eventIds = nearEvents.map((e) => e.id);
        const [fromTickets, fromRsvps] = await Promise.all([
          db.select({ eventId: tickets.eventId, userId: users.id, displayName: users.displayName, username: users.username, avatarUrl: users.avatarUrl })
            .from(tickets).innerJoin(users, eq(users.id, tickets.userId))
            .where(and(inArray(tickets.eventId, eventIds), inArray(tickets.userId, friendIds), eq(tickets.status, "confirmed"), isNull(tickets.purgedAt), isNull(tickets.optedOutAt), eq(users.showAttendanceToFriends, true))),
          db.select({ eventId: rsvps.eventId, userId: users.id, displayName: users.displayName, username: users.username, avatarUrl: users.avatarUrl })
            .from(rsvps).innerJoin(users, eq(users.id, rsvps.userId))
            .where(and(inArray(rsvps.eventId, eventIds), inArray(rsvps.userId, friendIds), eq(rsvps.status, "confirmed"), eq(users.showAttendanceToFriends, true))),
        ]);
        for (const r of [...fromTickets, ...fromRsvps]) {
          const m = going.get(r.eventId) ?? new Map<string, Going>();
          m.set(r.userId, { id: r.userId, displayName: r.displayName, username: r.username, avatarUrl: r.avatarUrl });
          going.set(r.eventId, m);
        }
      }

      res.json({
        friends,
        events: nearEvents.map((e) => {
          const g = Array.from(going.get(e.id)?.values() ?? []);
          return { ...e, friendsGoing: { count: g.length, sample: g.slice(0, 3) } };
        }),
        venues: nearVenues,
      });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ message: "Invalid map query" });
      console.error("Map nearby error:", error);
      res.status(500).json({ message: "Failed to load map" });
    }
  });
}
