import type { Express } from "express";
import passport from "passport";
import { storage } from "../storage";
import { requireAuth } from "../middleware";
import {
  authRateLimiter,
  sensitiveOperationLimiter,
  verificationEmailLimiter,
  checkLoginThrottle,
  recordLoginAttempt,
  clearLoginAttempts,
  sanitizeTextOnly,
  logSecurityEvent,
  rotateCsrfToken,
} from "../security";
import { hashPassword, comparePassword, userToSessionUser } from "../auth";
import { insertUserSchema } from "@shared/schema";
import { z } from "zod";
import { deliverNotification } from "../notifications";
import { resolveUserId } from "../utils/users";
import { fileTypeFromBuffer } from "file-type";

class MediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaValidationError';
  }
}

const passwordSchema = z.string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[0-9]/, "Password must contain at least one number")
  .regex(/[^A-Za-z0-9]/, "Password must contain at least one special character");

const signupSchema = insertUserSchema.omit({ passwordHash: true }).extend({
  password: passwordSchema,
});

export function registerUsersRoutes(app: Express): void {

  // Helper: store base64 data URL in DB, return /api/media/{id} URL
  async function storeMedia(data: string, ownerId: string): Promise<string> {
    const base64Data = data.includes(',') ? data.split(',')[1] : data;
    const buffer = Buffer.from(base64Data, 'base64');

    const detected = await fileTypeFromBuffer(buffer);
    if (!detected || (!detected.mime.startsWith('image/') && !detected.mime.startsWith('video/'))) {
      throw new MediaValidationError(
        `File type not allowed: ${detected?.mime ?? 'unknown'}`
      );
    }

    const safeData = `data:${detected.mime};base64,${base64Data}`;
    const id = await storage.saveMedia(safeData, detected.mime, ownerId);
    return `/api/media/${id}`;
  }

  // ==================== CONFIG ROUTES ====================

  // Expose app configuration (safe public info only)
  app.get("/api/config", (req, res) => {
    res.json({
      stripeConfigured: !!process.env.STRIPE_SECRET_KEY,
      paystackConfigured: !!process.env.PAYSTACK_SECRET_KEY,
    });
  });

  // ==================== AUTHENTICATION ROUTES ====================

  app.post("/api/auth/signup", authRateLimiter, async (req, res) => {
    try {
      const { password, ...rawUserData } = signupSchema.parse(req.body);
      const userData = { ...rawUserData, email: rawUserData.email.toLowerCase() };

      const existingUsername = await storage.getUserByUsername(userData.username);
      if (existingUsername) {
        return res.status(400).json({ message: "Username already exists" });
      }

      const existingEmail = await storage.getUserByEmail(userData.email);
      if (existingEmail) {
        return res.status(400).json({ message: "Email already exists" });
      }

      const passwordHash = await hashPassword(password);

      // If gender is provided during signup, set genderEditedAt to lock it
      const userDataWithGenderTimestamp = userData.gender
        ? { ...userData, genderEditedAt: new Date() }
        : userData;

      const user = await storage.createUser({
        ...userDataWithGenderTimestamp,
        passwordHash,
      } as any);

      // Send verification email — fire-and-forget so signup never blocks on email delivery
      (async () => {
        try {
          const crypto = await import("crypto");
          const rawToken = crypto.randomBytes(32).toString("hex");
          const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
          const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
          await storage.setEmailVerificationToken(user.id, tokenHash, expires);
          const baseUrl = (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
          const verifyLink = `${baseUrl}/verify-email?token=${rawToken}`;
          const { sendVerificationEmail } = await import("../emailService");
          await sendVerificationEmail({ to: user.email, verifyLink, userName: user.displayName || user.username });
        } catch (err) {
          console.error("[AUTH] Failed to send verification email:", err);
        }
      })();

      req.login(userToSessionUser(user), (err) => {
        if (err) {
          return res.status(500).json({ message: "Failed to login after signup" });
        }
        res.json({ user: userToSessionUser(user) });
      });
    } catch (error) {
      res.status(400).json({ message: "Invalid user data" });
    }
  });

  app.post("/api/auth/login", authRateLimiter, async (req, res, next) => {
    const identifier = req.body.username || "";
    const ip = req.ip || req.headers["x-forwarded-for"] as string || "unknown";

    try {
      const throttleCheck = await checkLoginThrottle(identifier, ip);
      if (!throttleCheck.allowed) {
        logSecurityEvent("lockout", { identifier, ip, lockedUntil: throttleCheck.lockedUntil });
        return res.status(429).json({
          message: `Account temporarily locked. Try again after ${throttleCheck.lockedUntil?.toLocaleTimeString()}`,
          lockedUntil: throttleCheck.lockedUntil,
        });
      }
    } catch (err) {
      console.error("[AUTH] throttle check failed:", err);
    }

    passport.authenticate("local", async (err: any, user: Express.User | false, info: any) => {
      if (err) {
        return res.status(500).json({ message: "Login failed" });
      }
      if (!user) {
        try {
          await recordLoginAttempt(identifier, ip, false);
          const postAttemptCheck = await checkLoginThrottle(identifier, ip);
          if (!postAttemptCheck.allowed) {
            logSecurityEvent("lockout", { identifier, ip, lockedUntil: postAttemptCheck.lockedUntil });
            return res.status(429).json({
              message: `Too many failed attempts. Account temporarily locked. Try again after ${postAttemptCheck.lockedUntil?.toLocaleTimeString()}`,
              lockedUntil: postAttemptCheck.lockedUntil,
            });
          }
          logSecurityEvent("login_failed", { identifier, ip, remainingAttempts: postAttemptCheck.remainingAttempts || 0 });
        } catch (throttleErr) {
          console.error("[AUTH] throttle record failed:", throttleErr);
        }
        return res.status(401).json({ message: info?.message || "Invalid credentials" });
      }

      req.session.regenerate((regenerateErr) => {
        if (regenerateErr) {
          return res.status(500).json({ message: "Login failed" });
        }

        req.login(user, async (loginErr) => {
          if (loginErr) {
            return res.status(500).json({ message: "Login failed" });
          }

          try {
            await clearLoginAttempts(identifier, ip);
            // Clear the alternate identifier too so a prior email-lockout
            // doesn't survive a successful username login (and vice-versa)
            const altIdentifier = identifier.includes('@') ? user.username : user.email;
            if (altIdentifier && altIdentifier !== identifier) {
              await clearLoginAttempts(altIdentifier, ip);
            }
          } catch (clearErr) {
            console.error("[AUTH] clear login attempts failed:", clearErr);
          }
          logSecurityEvent("login_success", { userId: user.id, ip });

          // Rotate CSRF token on successful login for security
          const newCsrfToken = rotateCsrfToken(res);

          res.json({ user, csrfToken: newCsrfToken });
        });
      });
    })(req, res, next);
  });

  app.post("/api/auth/logout", (req, res) => {
    req.logout((err) => {
      if (err) {
        return res.status(500).json({ message: "Logout failed" });
      }
      res.json({ message: "Logged out successfully" });
    });
  });

  // Google OAuth — only registered when credentials are present
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    app.get("/api/auth/google",
      passport.authenticate("google", { scope: ["profile", "email"] })
    );

    app.get(
      "/api/auth/google/callback",
      passport.authenticate("google", { failureRedirect: "/login?error=google_auth_failed" }),
      (req, res) => {
        rotateCsrfToken(res);
        res.redirect("/discover");
      }
    );
  }

  app.get("/api/auth/session", async (req, res) => {
    if (req.isAuthenticated()) {
      return res.json({ user: req.user });
    }

    // Distinguish a suspended account from a plain unauthenticated state so
    // the client can show the right UI rather than silently bouncing to login.
    const sessionUserId = (req.session as any)?.passport?.user as string | undefined;
    if (sessionUserId) {
      try {
        const suspension = await storage.getActiveSuspension(sessionUserId);
        if (suspension) {
          return res.status(403).json({ message: "Account suspended", suspended: true });
        }
      } catch {
        // DB error — fall through to generic 401
      }
    }

    res.status(401).json({ message: "Not authenticated" });
  });

  // Verify email with token from the emailed link
  app.get("/api/auth/verify-email", async (req, res) => {
    try {
      const { token } = req.query;
      if (!token || typeof token !== "string") {
        return res.status(400).json({ message: "Verification token is required.", code: "INVALID_TOKEN" });
      }

      const crypto = await import("crypto");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

      const user = await storage.getUserByEmailVerificationToken(tokenHash);
      if (!user) {
        return res.status(400).json({ message: "This verification link is invalid or has expired.", code: "INVALID_TOKEN" });
      }

      await storage.setUserVerified(user.id);
      await storage.clearEmailVerificationToken(user.id);

      // Refresh the session so the client sees isVerified: true without re-logging in
      if (req.isAuthenticated() && req.user!.id === user.id) {
        (req.user as any).isVerified = true;
        await new Promise<void>((resolve, reject) => req.session.save((err) => err ? reject(err) : resolve()));
      }

      res.json({ message: "Email verified successfully." });
    } catch (error) {
      console.error("[AUTH] verify-email error:", error);
      res.status(500).json({ message: "Failed to verify email. Please try again." });
    }
  });

  // Resend verification email (authenticated users only)
  app.post("/api/auth/resend-verification", requireAuth, verificationEmailLimiter, async (req, res) => {
    try {
      const user = await storage.getUser(req.user!.id);
      if (!user) return res.status(404).json({ message: "User not found" });

      if (user.isVerified) {
        return res.status(400).json({ message: "Your email is already verified.", code: "ALREADY_VERIFIED" });
      }

      const crypto = await import("crypto");
      const rawToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await storage.setEmailVerificationToken(user.id, tokenHash, expires);

      const baseUrl = (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
      const verifyLink = `${baseUrl}/verify-email?token=${rawToken}`;
      const { sendVerificationEmail } = await import("../emailService");
      const sent = await sendVerificationEmail({ to: user.email, verifyLink, userName: user.displayName || user.username });

      if (!sent) {
        return res.status(500).json({ message: "Failed to send verification email. Please try again later." });
      }

      res.json({ message: "Verification email sent. Please check your inbox." });
    } catch (error) {
      console.error("[AUTH] resend-verification error:", error);
      res.status(500).json({ message: "Failed to send verification email." });
    }
  });

  // Change password
  app.patch("/api/auth/change-password", requireAuth, sensitiveOperationLimiter, async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: "Current password and new password are required" });
      }
      const passwordValidation = passwordSchema.safeParse(newPassword);
      if (!passwordValidation.success) {
        return res.status(400).json({ message: passwordValidation.error.errors[0].message });
      }

      const user = await storage.getUser(req.user!.id);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      if (!user.passwordHash) {
        return res.status(400).json({ message: "Password cannot be changed on accounts that use Google sign-in." });
      }

      const isValid = await comparePassword(currentPassword, user.passwordHash);
      if (!isValid) {
        return res.status(400).json({ message: "Current password is incorrect" });
      }

      const hashedPassword = await hashPassword(newPassword);
      await storage.updateUserPassword(req.user!.id, hashedPassword);
      res.json({ message: "Password changed successfully" });
    } catch (error) {
      console.error("Error changing password:", error);
      res.status(500).json({ message: "Failed to change password" });
    }
  });

  // Forgot password - request reset email
  app.post("/api/auth/forgot-password", authRateLimiter, async (req, res) => {
    try {
      const { email: rawEmail } = req.body;
      if (!rawEmail) {
        return res.status(400).json({ message: "Email is required" });
      }
      const email = rawEmail.toLowerCase();

      const user = await storage.getUserByEmail(email);

      // Always return success to prevent email enumeration attacks
      if (!user) {
        return res.json({ message: "If an account with that email exists, a password reset link has been sent." });
      }

      // Generate secure random token
      const crypto = await import("crypto");
      const resetToken = crypto.randomBytes(32).toString("hex");

      // Token expires in 1 hour
      const expires = new Date(Date.now() + 60 * 60 * 1000);

      await storage.setPasswordResetToken(user.id, resetToken, expires);

      // Send reset email
      const { sendPasswordResetEmail } = await import("../emailService");
      const baseUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, "");
      const resetLink = `${baseUrl}/reset-password?token=${resetToken}`;

      const emailSent = await sendPasswordResetEmail({
        to: user.email,
        resetLink,
        userName: user.displayName || user.username,
      });

      if (!emailSent) {
        console.error("Failed to send password reset email to:", email);
      }

      res.json({ message: "If an account with that email exists, a password reset link has been sent." });
    } catch (error) {
      console.error("Error in forgot-password:", error);
      res.status(500).json({ message: "Failed to process password reset request" });
    }
  });

  // Reset password with token
  app.post("/api/auth/reset-password", authRateLimiter, async (req, res) => {
    try {
      const { token, newPassword } = req.body;
      if (!token || !newPassword) {
        return res.status(400).json({ message: "Token and new password are required" });
      }
      const passwordValidation = passwordSchema.safeParse(newPassword);
      if (!passwordValidation.success) {
        return res.status(400).json({ message: passwordValidation.error.errors[0].message });
      }

      const user = await storage.getUserByPasswordResetToken(token);
      if (!user) {
        // Log internally for admin monitoring, but return generic error to prevent token enumeration
        console.log("Password reset attempted with invalid or expired token");
        return res.status(400).json({ message: "Unable to reset password. Please request a new reset link." });
      }

      // Use the same hashPassword function as signup for consistency
      const hashedPassword = await hashPassword(newPassword);

      await storage.updateUserPassword(user.id, hashedPassword);
      console.log(`Password reset successful for user ${user.id} (${user.email})`);
      await storage.clearPasswordResetToken(user.id);

      res.json({ message: "Password has been reset successfully. You can now login with your new password." });
    } catch (error) {
      console.error("Error in reset-password:", error);
      // Return same generic error message to prevent information leakage
      res.status(400).json({ message: "Unable to reset password. Please request a new reset link." });
    }
  });

  // Change username
  app.patch("/api/users/me/username", requireAuth, sensitiveOperationLimiter, async (req, res) => {
    try {
      const { newUsername } = req.body;
      if (!newUsername) {
        return res.status(400).json({ message: "New username is required" });
      }
      if (newUsername.length < 3) {
        return res.status(400).json({ message: "Username must be at least 3 characters" });
      }

      const user = await storage.getUser(req.user!.id);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      if (user.usernameChangesRemaining <= 0) {
        return res.status(400).json({ message: "No username changes remaining. You can only change your username twice." });
      }

      const existingUser = await storage.getUserByUsername(newUsername);
      if (existingUser && existingUser.id !== user.id) {
        return res.status(400).json({ message: "Username is already taken" });
      }

      const updatedUser = await storage.updateUsername(req.user!.id, newUsername);

      // Update session with new username
      req.login(userToSessionUser(updatedUser), (err) => {
        if (err) {
          console.error("Error updating session:", err);
        }
      });

      res.json({
        message: "Username changed successfully",
        user: userToSessionUser(updatedUser),
        usernameChangesRemaining: updatedUser.usernameChangesRemaining
      });
    } catch (error) {
      console.error("Error changing username:", error);
      res.status(500).json({ message: "Failed to change username" });
    }
  });

  // Update user profile
  app.patch("/api/users/:userId", requireAuth, sensitiveOperationLimiter, async (req, res) => {
    try {
      let { userId } = req.params;

      // Handle "me" as a special case for current user
      if (userId === "me") {
        userId = req.user!.id;
      }

      // Security check: Users can only update their own profile
      if (req.user!.id !== userId) {
        return res.status(403).json({ message: "Unauthorized" });
      }

      const { updateUserSchema } = await import("@shared/schema");
      let updates = updateUserSchema.parse(req.body);

      // Sanitize text fields in profile updates
      if (updates.displayName) updates.displayName = sanitizeTextOnly(updates.displayName);
      if (updates.bio) updates.bio = sanitizeTextOnly(updates.bio);
      if (updates.organizationName) updates.organizationName = sanitizeTextOnly(updates.organizationName);

      // Security: Only organizers can enable venue management
      if (updates.canManageVenues !== undefined) {
        if (req.user!.userType !== "organizer") {
          return res.status(403).json({ message: "Only event organizers can enable venue management" });
        }
      }

      // Enforce one-time gender edit: only block if the submitted value
      // actually differs from what is already stored.
      if (updates.gender !== undefined) {
        const currentUser = await storage.getUser(userId);
        if (currentUser?.genderEditedAt && updates.gender !== currentUser.gender) {
          return res.status(400).json({ message: "Gender can only be changed once" });
        }
      }

      const updatedUser = await storage.updateUser(userId, updates);
      // Refresh session so updated displayName/avatar immediately reflect in navigation
      req.login(userToSessionUser(updatedUser), (err) => {
        if (err) console.error('Session refresh error after profile update:', err);
      });
      const { passwordHash, ...userWithoutPassword } = updatedUser as any;
      res.json(userWithoutPassword);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid profile data", errors: error.errors });
      }
      console.error('Error updating profile:', error);
      res.status(500).json({ message: "Failed to update profile" });
    }
  });

  // Batch fetch users by usernames (for @mentions avatar lookup)
  app.post("/api/users/by-usernames", async (req, res) => {
    try {
      const { usernames } = req.body;
      if (!Array.isArray(usernames) || usernames.length === 0) {
        return res.json([]);
      }
      // Limit to 50 usernames per request
      const limitedUsernames = usernames.slice(0, 50);
      const users = await storage.getUsersByUsernames(limitedUsernames);
      // Only return public profile info for mentions
      const publicUsers = users.map(u => ({
        username: u.username,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl,
      }));
      res.json(publicUsers);
    } catch (error) {
      console.error("Error fetching users by usernames:", error);
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  // User search and profile
  app.get("/api/users/search", requireAuth, async (req, res) => {
    try {
      const query = (req.query.q as string || "").trim();

      // Validate query length (min 2 chars)
      if (query.length < 2) {
        return res.json([]);
      }

      // Limit query length for safety
      if (query.length > 50) {
        return res.status(400).json({ message: "Search query too long" });
      }

      const users = await storage.searchUsers(query);

      // Limit results to prevent large responses
      const limitedResults = users.slice(0, 20);

      res.json(limitedResults);
    } catch (error) {
      res.status(500).json({ message: "Failed to search users" });
    }
  });

  app.get("/api/users/:identifier/profile", async (req, res) => {
    try {
      const identifier = req.params.identifier;

      // Check if identifier is a UUID or username
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);

      let user;
      if (isUUID) {
        user = await storage.getUser(identifier);
      } else {
        user = await storage.getUserByUsername(identifier);
      }

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Now get the full profile using the user's ID
      const profile = await storage.getUserProfile(user.id);
      if (!profile) {
        return res.status(404).json({ message: "User not found" });
      }
      res.json(profile);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch user profile" });
    }
  });

  // User profile (legacy - keep for backward compatibility)
  app.get("/api/users/:identifier", async (req, res) => {
    try {
      const identifier = req.params.identifier;

      // Check if identifier is a UUID or username
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);

      let user;
      if (isUUID) {
        user = await storage.getUser(identifier);
      } else {
        user = await storage.getUserByUsername(identifier);
      }

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Don't send password hash to client
      const { passwordHash, ...userWithoutPassword } = user;

      // Get user's events or RSVPs based on user type
      if (user.userType === "organizer") {
        const events = await storage.getUserEvents(user.id);
        res.json({ ...userWithoutPassword, events });
      } else {
        const rsvps = await storage.getUserRsvps(user.id);
        res.json({ ...userWithoutPassword, rsvps });
      }
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch user profile" });
    }
  });

  // Follow/Unfollow routes
  app.post("/api/users/:identifier/follow", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    try {
      const targetUserId = await resolveUserId(req.params.identifier);
      const currentUserId = req.user!.id;

      if (!targetUserId) {
        return res.status(404).json({ message: "User not found" });
      }

      // Can't follow yourself
      if (targetUserId === currentUserId) {
        return res.status(400).json({ message: "You cannot follow yourself" });
      }

      // Check if already following
      const alreadyFollowing = await storage.isFollowing(currentUserId, targetUserId);
      if (alreadyFollowing) {
        return res.status(400).json({ message: "Already following this user" });
      }

      const follow = await storage.followUser(currentUserId, targetUserId);

      // Create notification for the followed user
      const currentUser = await storage.getUser(currentUserId);
      await deliverNotification({
        userId: targetUserId,
        type: "new_follower",
        title: "New Follower",
        message: `${currentUser?.displayName || currentUser?.username || "Someone"} started following you`,
        link: `/profile/${currentUser?.username}`,
        relatedUserId: currentUserId,
        relatedEntityId: currentUserId,
      });

      res.json(follow);
    } catch (error) {
      console.error("Follow error:", error);
      res.status(500).json({ message: "Failed to follow user" });
    }
  });

  app.post("/api/users/:identifier/unfollow", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    try {
      const targetUserId = await resolveUserId(req.params.identifier);
      const currentUserId = req.user!.id;

      if (!targetUserId) {
        return res.status(404).json({ message: "User not found" });
      }

      // Check if currently following
      const isFollowing = await storage.isFollowing(currentUserId, targetUserId);
      if (!isFollowing) {
        return res.status(400).json({ message: "Not following this user" });
      }

      await storage.unfollowUser(currentUserId, targetUserId);
      res.json({ message: "Successfully unfollowed" });
    } catch (error) {
      console.error("Unfollow error:", error);
      res.status(500).json({ message: "Failed to unfollow user" });
    }
  });

  app.get("/api/users/:identifier/follow-stats", async (req, res) => {
    try {
      const userId = await resolveUserId(req.params.identifier);

      if (!userId) {
        return res.status(404).json({ message: "User not found" });
      }

      // Get followers and following
      const followers = await storage.getFollowers(userId);
      const following = await storage.getFollowing(userId);

      // Check if current user is following this user
      let isFollowing = false;
      if (req.isAuthenticated()) {
        isFollowing = await storage.isFollowing(req.user!.id, userId);
      }

      res.json({
        followersCount: followers.length,
        followingCount: following.length,
        isFollowing,
      });
    } catch (error) {
      console.error("Follow stats error:", error);
      res.status(500).json({ message: "Failed to fetch follow stats" });
    }
  });

  // User posts endpoint
  app.get("/api/users/:identifier/posts", async (req, res) => {
    try {
      const userId = await resolveUserId(req.params.identifier);

      if (!userId) {
        return res.status(404).json({ message: "User not found" });
      }

      const posts = await storage.getUserPosts(userId);
      const user = await storage.getUser(userId);

      // Add user info to each post
      const postsWithUser = posts.map(post => ({
        ...post,
        user: user ? { id: user.id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl } : null
      }));

      res.json(postsWithUser);
    } catch (error) {
      console.error("Get user posts error:", error);
      res.status(500).json({ message: "Failed to fetch user posts" });
    }
  });

  // User liked posts endpoint
  app.get("/api/users/:identifier/liked-posts", async (req, res) => {
    try {
      const userId = await resolveUserId(req.params.identifier);

      if (!userId) {
        return res.status(404).json({ message: "User not found" });
      }

      const likedPosts = await storage.getUserLikedPosts(userId);
      res.json(likedPosts);
    } catch (error) {
      console.error("Get user liked posts error:", error);
      res.status(500).json({ message: "Failed to fetch liked posts" });
    }
  });

  // User reposted posts endpoint
  app.get("/api/users/:identifier/reposted-posts", async (req, res) => {
    try {
      const userId = await resolveUserId(req.params.identifier);

      if (!userId) {
        return res.status(404).json({ message: "User not found" });
      }

      const repostedPosts = await storage.getUserRepostedPosts(userId);
      res.json(repostedPosts);
    } catch (error) {
      console.error("Get user reposted posts error:", error);
      res.status(500).json({ message: "Failed to fetch reposted posts" });
    }
  });

  // Avatar upload endpoint - server-side upload to DB storage
  app.post("/api/users/me/avatar", requireAuth, async (req, res) => {
    try {
      const { imageData } = req.body;
      if (!imageData || !imageData.startsWith('data:image')) {
        return res.status(400).json({ message: "Invalid image data" });
      }
      // Delete old avatar media if it was a DB-backed URL
      const currentUser = await storage.getUser(req.user!.id);
      if (currentUser?.avatarUrl) {
        await storage.deleteMediaByUrls([currentUser.avatarUrl]);
      }
      const avatarUrl = await storeMedia(imageData, req.user!.id);
      const updatedUser = await storage.updateUser(req.user!.id, { avatarUrl });
      const { passwordHash, ...userWithoutPassword } = updatedUser;
      return res.json(userWithoutPassword);
    } catch (error: any) {
      if (error instanceof MediaValidationError) {
        return res.status(400).json({ message: error.message });
      }
      console.error("[Avatar Upload] Error:", error?.message || error);
      res.status(500).json({ message: "Failed to upload avatar. Please try again." });
    }
  });

  // Update avatar URL after upload - accepts any path
  app.patch("/api/users/me/avatar", requireAuth, async (req, res) => {
    try {
      const { avatarPath } = req.body;
      if (!avatarPath) return res.status(400).json({ message: "Avatar path is required" });
      const updatedUser = await storage.updateUser(req.user!.id, { avatarUrl: avatarPath });
      const { passwordHash, ...userWithoutPassword } = updatedUser;
      res.json(userWithoutPassword);
    } catch (error: any) {
      res.status(500).json({ message: "Failed to update avatar" });
    }
  });

  // Delete avatar - removes avatar URL from user profile
  app.delete("/api/users/me/avatar", requireAuth, async (req, res) => {
    try {
      console.log(`[Avatar Delete] User ${req.user!.id} removing avatar`);
      const updatedUser = await storage.updateUser(req.user!.id, { avatarUrl: null });
      console.log(`[Avatar Delete] Successfully removed avatar for user ${req.user!.id}`);
      const { passwordHash, ...userWithoutPassword } = updatedUser;
      res.json(userWithoutPassword);
    } catch (error: any) {
      console.error("[Avatar Delete] Error removing avatar:", error?.message || error);
      res.status(500).json({ message: "Failed to remove avatar" });
    }
  });

  // Group avatar upload endpoint
  app.post("/api/conversations/:id/avatar", requireAuth, async (req, res) => {
    try {
      const conversationId = req.params.id;
      const conversation = await storage.getConversationById(conversationId);
      if (!conversation) return res.status(404).json({ message: "Conversation not found" });
      if (!conversation.isGroup) return res.status(400).json({ message: "Avatar upload only available for group chats" });
      const participant = conversation.participants.find(p => p.userId === req.user!.id);
      if (!participant || participant.role !== 'admin') return res.status(403).json({ message: "Only group admins can update the avatar" });

      const { imageData } = req.body;
      if (imageData && imageData.startsWith('data:image')) {
        // Direct upload path
        const avatarUrl = await storeMedia(imageData, req.user!.id);
        const updatedConversation = await storage.updateConversation(conversationId, { avatarUrl });
        return res.json(updatedConversation);
      }
      // Return a dummy upload URL for backward compat with ObjectUploader
      res.json({ uploadURL: '/api/media/upload', stablePath: null });
    } catch (error) {
      if (error instanceof MediaValidationError) {
        return res.status(400).json({ message: error.message });
      }
      console.error("Error with group avatar:", error);
      res.status(500).json({ message: "Failed to update avatar" });
    }
  });

  // Update group avatar URL after upload - accepts the stable path
  app.patch("/api/conversations/:id/avatar", requireAuth, async (req, res) => {
    try {
      const conversationId = req.params.id;
      const { avatarPath } = req.body;
      if (!avatarPath) return res.status(400).json({ message: "Avatar path is required" });
      const conversation = await storage.getConversationById(conversationId);
      if (!conversation) return res.status(404).json({ message: "Conversation not found" });
      if (!conversation.isGroup) return res.status(400).json({ message: "Only group chats have avatars" });
      const participant = conversation.participants.find(p => p.userId === req.user!.id);
      if (!participant || participant.role !== 'admin') return res.status(403).json({ message: "Only admins can update avatar" });
      const updatedConversation = await storage.updateConversation(conversationId, { avatarUrl: avatarPath });
      res.json(updatedConversation);
    } catch (error) {
      res.status(500).json({ message: "Failed to update avatar" });
    }
  });

  // Universal search endpoint
  app.get("/api/search", requireAuth, async (req, res) => {
    try {
      const query = (req.query.q as string || "").trim();
      const types = req.query.types ? (req.query.types as string).split(",") : undefined;

      if (query.length < 2) {
        return res.json({
          users: [],
          events: [],
          venueEvents: [],
          venues: [],
          posts: [],
        });
      }

      if (query.length > 100) {
        return res.status(400).json({ message: "Search query too long" });
      }

      const results = await storage.universalSearch(query, types);
      res.json(results);
    } catch (error) {
      console.error("Universal search error:", error);
      res.status(500).json({ message: "Search failed" });
    }
  });

  // Trending posts
  app.get("/api/trending/posts", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
      const posts = await storage.getTrendingPosts(limit);
      res.json(posts);
    } catch (error) {
      console.error("Trending posts error:", error);
      res.status(500).json({ message: "Failed to get trending posts" });
    }
  });

  // Trending events
  app.get("/api/trending/events", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
      const events = await storage.getTrendingEvents(limit);
      res.json(events);
    } catch (error) {
      console.error("Trending events error:", error);
      res.status(500).json({ message: "Failed to get trending events" });
    }
  });

  // Trending venues
  app.get("/api/trending/venues", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
      const venues = await storage.getTrendingVenues(limit);
      res.json(venues);
    } catch (error) {
      console.error("Trending venues error:", error);
      res.status(500).json({ message: "Failed to get trending venues" });
    }
  });

  // Trending stories
  app.get("/api/trending/stories", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
      const stories = await storage.getTrendingStories(limit);
      res.json(stories);
    } catch (error) {
      console.error("Trending stories error:", error);
      res.status(500).json({ message: "Failed to get trending stories" });
    }
  });

  // Suggested users to follow
  app.get("/api/suggested-users", requireAuth, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 20);
      const suggestedUsers = await storage.getSuggestedUsers(req.user!.id, limit);
      res.json(suggestedUsers);
    } catch (error) {
      console.error("Suggested users error:", error);
      res.status(500).json({ message: "Failed to get suggested users" });
    }
  });

  // Recommended users based on interests and location
  app.get("/api/recommended-users", requireAuth, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 15, 30);
      const recommendedUsers = await storage.getRecommendedUsers(req.user!.id, limit);
      res.json(recommendedUsers);
    } catch (error) {
      console.error("Recommended users error:", error);
      res.status(500).json({ message: "Failed to get recommended users" });
    }
  });
}