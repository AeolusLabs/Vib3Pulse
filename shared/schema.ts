import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  userType: text("user_type").notNull(),
  displayName: text("display_name"),
  dateOfBirth: text("date_of_birth"),
  bio: text("bio"),
  interests: text("interests").array().default(sql`'{}'`),
  organizationName: text("organization_name"),
  contactEmail: text("contact_email"),
  socialMediaLinks: text("social_media_links").array().default(sql`'{}'`),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
