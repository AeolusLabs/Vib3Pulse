import { Express, Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { Pool } from "@neondatabase/serverless";
import { storage } from "./storage";
import { insertAdminUserSchema, adminRoles, type AdminRole } from "@shared/schema";
import { z } from "zod";
import { 
  authRateLimiter, 
  checkLoginThrottle, 
  recordLoginAttempt, 
  clearLoginAttempts, 
  logSecurityEvent 
} from "./security";

const pgSession = connectPgSimple(session);

// Extend session type for admin
declare module "express-session" {
  interface SessionData {
    adminId?: string;
    adminRole?: AdminRole;
  }
}

// Admin authentication middleware
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.adminId) {
    return res.status(401).json({ message: "Admin authentication required" });
  }
  next();
}

// Role-based access control middleware
export function requireRole(...allowedRoles: AdminRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.session?.adminId) {
      return res.status(401).json({ message: "Admin authentication required" });
    }
    if (!req.session.adminRole || !allowedRoles.includes(req.session.adminRole)) {
      return res.status(403).json({ message: "Insufficient permissions" });
    }
    next();
  };
}

// Super admin only middleware
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.adminId) {
    return res.status(401).json({ message: "Admin authentication required" });
  }
  if (req.session.adminRole !== "super_admin") {
    return res.status(403).json({ message: "Super admin access required" });
  }
  next();
}

// Helper to log admin activity
async function logActivity(adminId: string, action: string, targetType?: string, targetId?: string, details?: string, ipAddress?: string) {
  try {
    await storage.logAdminActivity({
      adminId,
      action,
      targetType,
      targetId,
      details,
      ipAddress,
    });
  } catch (error) {
    console.error("Failed to log admin activity:", error);
  }
}

export function setupAdminRoutes(app: Express) {
  // Create admin session store with separate table
  const adminPool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adminSessionStore = new pgSession({
    pool: adminPool as any,
    tableName: "admin_session",
    createTableIfMissing: true,
  });

  // Admin session middleware - separate from user sessions with strict security
  const adminSession = session({
    store: adminSessionStore,
    secret: process.env.SESSION_SECRET || "admin-secret-key-change-in-production",
    resave: false,
    saveUninitialized: false,
    name: "admin.sid",
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 8 * 60 * 60 * 1000, // 8 hours for admin sessions
      sameSite: "strict", // Strict for admin sessions
    },
  });

  // Apply admin session to all /api/admin routes
  app.use("/api/admin", adminSession);

  // ============================================
  // FIRST-TIME ADMIN SETUP
  // ============================================

  // Check if initial setup is needed (no admins exist)
  app.get("/api/admin/setup/status", async (req: Request, res: Response) => {
    try {
      const admins = await storage.getAllAdminUsers();
      res.json({ 
        setupRequired: admins.length === 0,
        message: admins.length === 0 
          ? "No admin accounts exist. Initial setup is available." 
          : "Admin accounts already exist. Setup is disabled."
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to check setup status" });
    }
  });

  // First-time Super Admin setup - only works when no admins exist
  const setupSchema = z.object({
    setupKey: z.string().min(1, "Setup key is required"),
    username: z.string().min(3, "Username must be at least 3 characters"),
    email: z.string().email("Valid email required"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    displayName: z.string().min(1, "Display name required"),
  });

  app.post("/api/admin/setup", async (req: Request, res: Response) => {
    try {
      // Check if any admins already exist
      const existingAdmins = await storage.getAllAdminUsers();
      if (existingAdmins.length > 0) {
        return res.status(403).json({ 
          message: "Setup is disabled. Admin accounts already exist." 
        });
      }

      // Validate input
      const validation = setupSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ 
          message: validation.error.errors[0].message 
        });
      }

      const { setupKey, username, email, password, displayName } = validation.data;

      // Verify setup key matches environment variable
      const expectedKey = process.env.ADMIN_SETUP_KEY;
      if (!expectedKey) {
        return res.status(500).json({ 
          message: "ADMIN_SETUP_KEY environment variable not configured. Please set it in your secrets." 
        });
      }

      if (setupKey !== expectedKey) {
        return res.status(401).json({ message: "Invalid setup key" });
      }

      // Check for existing username or email
      const existingByUsername = await storage.getAdminUserByUsername(username);
      if (existingByUsername) {
        return res.status(400).json({ message: "Username already taken" });
      }

      const existingByEmail = await storage.getAdminUserByEmail(email);
      if (existingByEmail) {
        return res.status(400).json({ message: "Email already registered" });
      }

      // Hash password and create the Super Admin
      const passwordHash = await bcrypt.hash(password, 12);
      
      // Use try-catch to handle race conditions - if another admin was created
      // between our initial check and now, the unique constraint will fail
      let newAdmin;
      try {
        newAdmin = await storage.createAdminUser({
          username,
          email,
          passwordHash,
          displayName,
          role: "super_admin",
        });
      } catch (createError: any) {
        // Re-check if another admin was created (race condition)
        const finalCheck = await storage.getAllAdminUsers();
        if (finalCheck.length > 0) {
          return res.status(403).json({ 
            message: "Setup is disabled. Another admin account was just created." 
          });
        }
        throw createError;
      }

      // Final verification - ensure this is truly the first admin
      const allAdmins = await storage.getAllAdminUsers();
      if (allAdmins.length > 1) {
        // Race condition occurred - more than one admin exists
        // This shouldn't happen with proper DB constraints, but extra safety
        return res.status(403).json({ 
          message: "Setup conflict detected. Please contact support." 
        });
      }

      // Log the initial setup
      await logActivity(newAdmin.id, "initial_setup", "admin", newAdmin.id, "Initial Super Admin account created", req.ip);

      const { passwordHash: _, ...adminWithoutPassword } = newAdmin;
      res.status(201).json({ 
        message: "Super Admin account created successfully! You can now log in.",
        admin: adminWithoutPassword 
      });
    } catch (error) {
      console.error("Admin setup error:", error);
      res.status(500).json({ message: "Setup failed" });
    }
  });

  // ============================================
  // ADMIN AUTHENTICATION
  // ============================================

  // Admin login
  app.post("/api/admin/login", authRateLimiter, async (req: Request, res: Response) => {
    try {
      const { username, password } = req.body;
      const ip = req.ip || req.headers["x-forwarded-for"] as string || "unknown";
      
      if (!username || !password) {
        return res.status(400).json({ message: "Username and password required" });
      }

      // Check login throttling
      const throttleCheck = checkLoginThrottle(`admin:${username}`, ip);
      if (!throttleCheck.allowed) {
        logSecurityEvent("lockout", { identifier: `admin:${username}`, ip, lockedUntil: throttleCheck.lockedUntil });
        return res.status(429).json({ 
          message: `Account temporarily locked. Try again after ${throttleCheck.lockedUntil?.toLocaleTimeString()}`,
          lockedUntil: throttleCheck.lockedUntil
        });
      }

      const admin = await storage.getAdminUserByUsername(username);
      if (!admin) {
        recordLoginAttempt(`admin:${username}`, ip, false);
        logSecurityEvent("login_failed", { identifier: `admin:${username}`, ip, type: "admin" });
        return res.status(401).json({ message: "Invalid credentials" });
      }

      if (!admin.isActive) {
        recordLoginAttempt(`admin:${username}`, ip, false);
        return res.status(401).json({ message: "Account is deactivated" });
      }

      const isValidPassword = await bcrypt.compare(password, admin.passwordHash);
      if (!isValidPassword) {
        recordLoginAttempt(`admin:${username}`, ip, false);
        logSecurityEvent("login_failed", { identifier: `admin:${username}`, ip, type: "admin" });
        return res.status(401).json({ message: "Invalid credentials" });
      }

      // Clear login attempts on successful login
      clearLoginAttempts(`admin:${username}`, ip);
      logSecurityEvent("login_success", { adminId: admin.id, ip, type: "admin" });

      // Set session
      req.session.adminId = admin.id;
      req.session.adminRole = admin.role as AdminRole;

      // Update last login
      await storage.updateAdminLastLogin(admin.id);

      // Log activity
      await logActivity(admin.id, "login", "admin", admin.id, "Admin logged in", req.ip);

      const { passwordHash, ...adminWithoutPassword } = admin;
      res.json({ admin: adminWithoutPassword });
    } catch (error) {
      console.error("Admin login error:", error);
      res.status(500).json({ message: "Login failed" });
    }
  });

  // Admin logout
  app.post("/api/admin/logout", requireAdmin, async (req: Request, res: Response) => {
    const adminId = req.session.adminId!;
    await logActivity(adminId, "logout", "admin", adminId, "Admin logged out", req.ip);
    
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ message: "Logout failed" });
      }
      res.clearCookie("admin.sid");
      res.json({ message: "Logged out successfully" });
    });
  });

  // Get current admin
  app.get("/api/admin/me", requireAdmin, async (req: Request, res: Response) => {
    try {
      const admin = await storage.getAdminUser(req.session.adminId!);
      if (!admin) {
        return res.status(404).json({ message: "Admin not found" });
      }
      const { passwordHash, ...adminWithoutPassword } = admin;
      res.json(adminWithoutPassword);
    } catch (error) {
      res.status(500).json({ message: "Failed to get admin" });
    }
  });

  // ============================================
  // ADMIN USER MANAGEMENT (Super Admin Only)
  // ============================================

  // Get all admin users
  app.get("/api/admin/users/admins", requireSuperAdmin, async (req: Request, res: Response) => {
    try {
      const admins = await storage.getAllAdminUsers();
      const adminsWithoutPasswords = admins.map(({ passwordHash, ...rest }) => rest);
      res.json(adminsWithoutPasswords);
    } catch (error) {
      res.status(500).json({ message: "Failed to get admins" });
    }
  });

  // Create new admin user
  app.post("/api/admin/users/admins", requireSuperAdmin, async (req: Request, res: Response) => {
    try {
      const createSchema = z.object({
        email: z.string().email(),
        username: z.string().min(3),
        password: z.string().min(8),
        displayName: z.string().min(1),
        role: z.enum(adminRoles),
      });

      const data = createSchema.parse(req.body);

      // Check if username or email already exists
      const existingByUsername = await storage.getAdminUserByUsername(data.username);
      if (existingByUsername) {
        return res.status(400).json({ message: "Username already exists" });
      }

      const existingByEmail = await storage.getAdminUserByEmail(data.email);
      if (existingByEmail) {
        return res.status(400).json({ message: "Email already exists" });
      }

      const passwordHash = await bcrypt.hash(data.password, 10);

      const admin = await storage.createAdminUser({
        email: data.email,
        username: data.username,
        passwordHash,
        displayName: data.displayName,
        role: data.role,
        isActive: true,
        createdBy: req.session.adminId,
      });

      await logActivity(
        req.session.adminId!,
        "create_admin",
        "admin",
        admin.id,
        `Created admin user: ${admin.username} with role: ${admin.role}`,
        req.ip
      );

      const { passwordHash: _, ...adminWithoutPassword } = admin;
      res.status(201).json(adminWithoutPassword);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid input", errors: error.errors });
      }
      console.error("Create admin error:", error);
      res.status(500).json({ message: "Failed to create admin" });
    }
  });

  // Update admin user
  app.patch("/api/admin/users/admins/:id", requireSuperAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const updateSchema = z.object({
        displayName: z.string().min(1).optional(),
        role: z.enum(adminRoles).optional(),
        isActive: z.boolean().optional(),
      });

      const data = updateSchema.parse(req.body);

      const admin = await storage.updateAdminUser(id, data);

      await logActivity(
        req.session.adminId!,
        "update_admin",
        "admin",
        id,
        `Updated admin user: ${JSON.stringify(data)}`,
        req.ip
      );

      const { passwordHash, ...adminWithoutPassword } = admin;
      res.json(adminWithoutPassword);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid input", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to update admin" });
    }
  });

  // Deactivate admin user
  app.post("/api/admin/users/admins/:id/deactivate", requireSuperAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      // Can't deactivate yourself
      if (id === req.session.adminId) {
        return res.status(400).json({ message: "Cannot deactivate your own account" });
      }

      const admin = await storage.deactivateAdminUser(id);

      await logActivity(
        req.session.adminId!,
        "deactivate_admin",
        "admin",
        id,
        `Deactivated admin user: ${admin.username}`,
        req.ip
      );

      const { passwordHash, ...adminWithoutPassword } = admin;
      res.json(adminWithoutPassword);
    } catch (error) {
      res.status(500).json({ message: "Failed to deactivate admin" });
    }
  });

  // ============================================
  // PLATFORM DASHBOARD
  // ============================================

  // Get platform stats
  app.get("/api/admin/stats", requireAdmin, async (req: Request, res: Response) => {
    try {
      const stats = await storage.getPlatformStats();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ message: "Failed to get stats" });
    }
  });

  // Get activity logs
  app.get("/api/admin/activity-logs", requireRole("super_admin", "user_support"), async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const logs = await storage.getAdminActivityLogs(limit);
      res.json(logs);
    } catch (error) {
      res.status(500).json({ message: "Failed to get activity logs" });
    }
  });

  // ============================================
  // USER MANAGEMENT
  // ============================================

  // Get all platform users
  app.get("/api/admin/users", requireRole("super_admin", "user_support", "content_moderator"), async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      const users = await storage.getAllUsers(limit, offset);
      const totalCount = await storage.getUserCount();
      
      // Remove password hashes
      const usersWithoutPasswords = users.map(({ passwordHash, ...rest }) => rest);
      
      res.json({ users: usersWithoutPasswords, total: totalCount });
    } catch (error) {
      res.status(500).json({ message: "Failed to get users" });
    }
  });

  // Suspend user
  app.post("/api/admin/users/:id/suspend", requireRole("super_admin", "user_support"), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const suspendSchema = z.object({
        reason: z.string().min(1),
        suspendedUntil: z.string().datetime().optional(),
        isPermanent: z.boolean().optional(),
      });

      const data = suspendSchema.parse(req.body);

      const suspension = await storage.suspendUser({
        userId: id,
        adminId: req.session.adminId!,
        reason: data.reason,
        suspendedUntil: data.suspendedUntil ? new Date(data.suspendedUntil) : null,
        isPermanent: data.isPermanent || false,
      });

      await logActivity(
        req.session.adminId!,
        "suspend_user",
        "user",
        id,
        `Suspended user: ${data.reason}`,
        req.ip
      );

      res.json(suspension);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid input", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to suspend user" });
    }
  });

  // Lift user suspension
  app.post("/api/admin/users/:userId/suspensions/:suspensionId/lift", requireRole("super_admin", "user_support"), async (req: Request, res: Response) => {
    try {
      const { suspensionId } = req.params;

      const suspension = await storage.liftSuspension(suspensionId);

      await logActivity(
        req.session.adminId!,
        "lift_suspension",
        "suspension",
        suspensionId,
        `Lifted suspension for user`,
        req.ip
      );

      res.json(suspension);
    } catch (error) {
      res.status(500).json({ message: "Failed to lift suspension" });
    }
  });

  // Get all suspensions
  app.get("/api/admin/suspensions", requireRole("super_admin", "user_support"), async (req: Request, res: Response) => {
    try {
      const suspensions = await storage.getAllSuspensions();
      res.json(suspensions);
    } catch (error) {
      res.status(500).json({ message: "Failed to get suspensions" });
    }
  });

  // Delete user (Super Admin only)
  app.delete("/api/admin/users/:id", requireSuperAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      await storage.deleteUser(id);

      await logActivity(
        req.session.adminId!,
        "delete_user",
        "user",
        id,
        `Deleted user`,
        req.ip
      );

      res.json({ message: "User deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete user" });
    }
  });

  // ============================================
  // EVENT MANAGEMENT
  // ============================================

  // Get all events
  app.get("/api/admin/events", requireRole("super_admin", "event_reviewer", "content_moderator"), async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      const events = await storage.getAllEventsAdmin(limit, offset);
      res.json(events);
    } catch (error) {
      res.status(500).json({ message: "Failed to get events" });
    }
  });

  // Moderate event
  app.post("/api/admin/events/:id/moderate", requireRole("super_admin", "event_reviewer", "content_moderator"), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const moderateSchema = z.object({
        action: z.enum(["approve", "reject", "flag"]),
        reason: z.string().optional(),
      });

      const data = moderateSchema.parse(req.body);

      const moderation = await storage.moderateEvent({
        eventId: id,
        adminId: req.session.adminId!,
        action: data.action,
        reason: data.reason,
      });

      await logActivity(
        req.session.adminId!,
        `${data.action}_event`,
        "event",
        id,
        `${data.action} event: ${data.reason || "No reason provided"}`,
        req.ip
      );

      res.json(moderation);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid input", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to moderate event" });
    }
  });

  // Delete event
  app.delete("/api/admin/events/:id", requireRole("super_admin", "content_moderator"), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      await storage.deleteEvent(id);

      await logActivity(
        req.session.adminId!,
        "delete_event",
        "event",
        id,
        `Deleted event`,
        req.ip
      );

      res.json({ message: "Event deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete event" });
    }
  });

  // Get event moderation history
  app.get("/api/admin/events/:id/moderations", requireRole("super_admin", "event_reviewer", "content_moderator"), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const moderations = await storage.getEventModerations(id);
      res.json(moderations);
    } catch (error) {
      res.status(500).json({ message: "Failed to get moderations" });
    }
  });

  // ============================================
  // CONTENT MODERATION
  // ============================================

  // Get all stories (for moderation)
  app.get("/api/admin/stories", requireRole("super_admin", "content_moderator"), async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const stories = await storage.getAllStoriesAdmin(limit);
      res.json(stories);
    } catch (error) {
      res.status(500).json({ message: "Failed to get stories" });
    }
  });

  // Delete story
  app.delete("/api/admin/stories/:id", requireRole("super_admin", "content_moderator"), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      await storage.deleteStoryAdmin(id);

      await logActivity(
        req.session.adminId!,
        "delete_story",
        "story",
        id,
        `Deleted story`,
        req.ip
      );

      res.json({ message: "Story deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete story" });
    }
  });

  // Get content reports
  app.get("/api/admin/reports", requireRole("super_admin", "content_moderator", "user_support"), async (req: Request, res: Response) => {
    try {
      const status = req.query.status as string | undefined;
      const reports = await storage.getContentReports(status);
      res.json(reports);
    } catch (error) {
      res.status(500).json({ message: "Failed to get reports" });
    }
  });

  // Review content report
  app.post("/api/admin/reports/:id/review", requireRole("super_admin", "content_moderator", "user_support"), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const reviewSchema = z.object({
        status: z.enum(["reviewed", "dismissed", "actioned"]),
        resolution: z.string().optional(),
      });

      const data = reviewSchema.parse(req.body);

      const report = await storage.updateContentReport(id, {
        status: data.status,
        reviewedBy: req.session.adminId!,
        resolution: data.resolution,
      });

      await logActivity(
        req.session.adminId!,
        "review_report",
        "report",
        id,
        `Reviewed report: ${data.status}`,
        req.ip
      );

      res.json(report);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid input", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to review report" });
    }
  });

  // ============================================
  // FINANCE (Finance Manager + Super Admin)
  // ============================================

  // Get payment/ticket overview (placeholder for Stripe integration)
  app.get("/api/admin/finance/overview", requireRole("super_admin", "finance_manager"), async (req: Request, res: Response) => {
    try {
      const stats = await storage.getPlatformStats();
      res.json({
        totalRevenue: stats.totalRevenue,
        totalTicketsSold: stats.totalTicketsSold,
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to get finance overview" });
    }
  });
}
