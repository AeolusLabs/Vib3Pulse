import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import connectPgSimple from "connect-pg-simple";
import cookieParser from "cookie-parser";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { storage } from "./storage";
import { comparePassword, userToSessionUser, type SessionUser } from "./auth";
import { wsManager } from "./websocket";
import { setupAdminRoutes } from "./admin-routes";
import { 
  csrfProtection, 
  csrfTokenEndpoint, 
  apiRateLimiter, 
  securityHeaders,
  logSecurityEvent
} from "./security";

const app = express();

// Trust proxy to work correctly behind Replit's reverse proxy
app.set('trust proxy', 1);

const PgSession = connectPgSimple(session);

// Create session store that we'll use for both Express and WebSocket
const sessionStore = new PgSession({
  conString: process.env.DATABASE_URL,
  tableName: "session",
  createTableIfMissing: true,
});

declare module 'http' {
  interface IncomingMessage {
    rawBody: unknown
  }
}

// Security headers first
app.use(securityHeaders);

// Cookie parser for CSRF token validation
app.use(cookieParser());

app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

// Session configuration with strengthened security
app.use(
  session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || "vibepulse-secret-key-change-in-production",
    resave: false,
    saveUninitialized: false,
    name: "vibepulse.sid",
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
    },
  })
);

passport.use(
  new LocalStrategy(async (username, password, done) => {
    try {
      const isEmail = username.includes('@');
      const user = isEmail 
        ? await storage.getUserByEmail(username)
        : await storage.getUserByUsername(username);
      
      if (!user) {
        return done(null, false, { message: "Invalid username or password" });
      }

      const isValid = await comparePassword(password, user.passwordHash);
      if (!isValid) {
        return done(null, false, { message: "Invalid username or password" });
      }

      return done(null, userToSessionUser(user));
    } catch (error) {
      return done(error);
    }
  })
);

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id: string, done) => {
  try {
    const user = await storage.getUser(id);
    if (!user) {
      return done(null, false);
    }
    done(null, userToSessionUser(user));
  } catch (error) {
    done(error);
  }
});

app.use(passport.initialize());
app.use(passport.session());

// Setup admin routes (separate authentication system)
setupAdminRoutes(app);

// CSRF token endpoint - must be before CSRF protection middleware
app.get("/api/csrf-token", csrfTokenEndpoint);

// Apply rate limiting to all API routes
app.use("/api", apiRateLimiter);

// Apply CSRF protection to all API routes (after session is established)
app.use("/api", csrfProtection);

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  // Initialize WebSocket server
  wsManager.initialize(server, sessionStore);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  
  console.log(`[STARTUP] Initializing server on port ${port}...`);
  console.log(`[STARTUP] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[STARTUP] Database connected: ${!!process.env.DATABASE_URL}`);
  
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    console.log(`[STARTUP] Server successfully bound to 0.0.0.0:${port}`);
    console.log(`[STARTUP] Application ready to accept requests`);
    log(`serving on port ${port}`);
  });
})();
