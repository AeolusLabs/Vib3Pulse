import { Request, Response, NextFunction } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import crypto from "crypto";
import sanitizeHtml from "sanitize-html";
import { storage } from "./storage";

const CSRF_TOKEN_HEADER = "x-csrf-token";
const CSRF_TOKEN_COOKIE = "csrf-token";

const LOGIN_THROTTLE_CONFIG = {
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
  lockoutDurationMs: 15 * 60 * 1000,
  cleanupIntervalMs: 60 * 60 * 1000,
};

// Purge expired rows once per hour so the table stays lean.
setInterval(() => {
  storage.cleanupExpiredLoginAttempts().catch((err) => {
    console.error("[SECURITY] login_attempts cleanup failed:", err);
  });
}, LOGIN_THROTTLE_CONFIG.cleanupIntervalMs);

export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function rotateCsrfToken(res: Response): string {
  const newToken = generateCsrfToken();
  res.cookie(CSRF_TOKEN_COOKIE, newToken, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 24 * 60 * 60 * 1000,
  });
  return newToken;
}

// Paths exempt from CSRF protection (relative to /api mount point)
// Only webhooks are exempt since they're called by external services without CSRF tokens
const CSRF_EXEMPT_PATHS = [
  "/webhooks/stripe",
  "/stripe/webhook",
  "/webhook",
  "/safety/buddy-sms-reply", // Twilio/Termii inbound SMS webhook
];

function isExemptFromCsrf(path: string): boolean {
  return CSRF_EXEMPT_PATHS.some(exempt => path.startsWith(exempt));
}

export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  if (isExemptFromCsrf(req.path)) {
    return next();
  }
  
  const safeMethods = ["GET", "HEAD", "OPTIONS"];
  
  if (safeMethods.includes(req.method)) {
    let token = req.cookies?.[CSRF_TOKEN_COOKIE];
    if (!token) {
      token = generateCsrfToken();
      res.cookie(CSRF_TOKEN_COOKIE, token, {
        httpOnly: false,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 24 * 60 * 60 * 1000,
      });
    }
    return next();
  }

  const cookieToken = req.cookies?.[CSRF_TOKEN_COOKIE];
  const headerToken = req.headers[CSRF_TOKEN_HEADER] as string;

  if (!cookieToken || !headerToken) {
    logSecurityEvent("csrf_violation", { 
      path: req.path, 
      method: req.method, 
      reason: "missing_token",
      ip: req.ip 
    });
    return res.status(403).json({ 
      message: "CSRF token missing",
      code: "CSRF_MISSING"
    });
  }

  if (cookieToken !== headerToken) {
    logSecurityEvent("csrf_violation", { 
      path: req.path, 
      method: req.method, 
      reason: "token_mismatch",
      ip: req.ip 
    });
    return res.status(403).json({ 
      message: "CSRF token invalid",
      code: "CSRF_INVALID"
    });
  }

  next();
}

export function csrfTokenEndpoint(req: Request, res: Response) {
  let token = req.cookies?.[CSRF_TOKEN_COOKIE];
  if (!token) {
    token = generateCsrfToken();
    res.cookie(CSRF_TOKEN_COOKIE, token, {
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000,
    });
  }
  res.json({ csrfToken: token });
}

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { 
    message: "Too many authentication attempts. Please try again later.",
    code: "RATE_LIMITED"
  },
  standardHeaders: true,
  legacyHeaders: false,
});

export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: {
    message: "Too many requests. Please slow down.",
    code: "RATE_LIMITED"
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user as any)?.id ?? req.ip ?? "",
  skip: (req) =>
    req.path.startsWith("/auth/session") ||
    req.path.startsWith("/media"),
});

export const sensitiveOperationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: {
    message: "Too many sensitive operations. Please try again later.",
    code: "RATE_LIMITED"
  },
  standardHeaders: true,
  legacyHeaders: false,
});

export const verificationEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  keyGenerator: (req) => (req.user as any)?.id ?? ipKeyGenerator(req.ip ?? ""),
  message: {
    message: "Too many verification email requests. Please try again in an hour.",
    code: "RATE_LIMITED",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

export const ratingSubmitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => (req.user as any)?.id ?? ipKeyGenerator(req.ip ?? ""),
  message: {
    error: "RATE_LIMITED",
    message: "Too many requests, try again later",
    statusCode: 429,
  },
  standardHeaders: true,
  legacyHeaders: false,
});

function getLoginKey(identifier: string, ip: string): string {
  return `${identifier}:${ip}`;
}

export async function checkLoginThrottle(
  identifier: string,
  ip: string,
): Promise<{ allowed: boolean; remainingAttempts?: number; lockedUntil?: Date }> {
  const key = getLoginKey(identifier, ip);
  const now = new Date();
  const data = await storage.getLoginAttempt(key);

  if (!data) {
    return { allowed: true, remainingAttempts: LOGIN_THROTTLE_CONFIG.maxAttempts };
  }

  if (data.lockedUntil && now < data.lockedUntil) {
    return { allowed: false, lockedUntil: data.lockedUntil };
  }

  // Lock expired or window elapsed — clear the stale row
  if (
    (data.lockedUntil && now >= data.lockedUntil) ||
    now.getTime() - data.lastAttempt.getTime() > LOGIN_THROTTLE_CONFIG.windowMs
  ) {
    await storage.deleteLoginAttempt(key);
    return { allowed: true, remainingAttempts: LOGIN_THROTTLE_CONFIG.maxAttempts };
  }

  const remainingAttempts = LOGIN_THROTTLE_CONFIG.maxAttempts - data.count;
  return { allowed: remainingAttempts > 0, remainingAttempts: Math.max(0, remainingAttempts) };
}

export async function recordLoginAttempt(identifier: string, ip: string, success: boolean): Promise<void> {
  const key = getLoginKey(identifier, ip);
  const now = new Date();

  if (success) {
    await storage.deleteLoginAttempt(key);
    return;
  }

  const existing = await storage.getLoginAttempt(key);
  let count: number;

  if (!existing || now.getTime() - existing.lastAttempt.getTime() > LOGIN_THROTTLE_CONFIG.windowMs) {
    count = 1;
  } else {
    count = existing.count + 1;
  }

  const lockedUntil =
    count >= LOGIN_THROTTLE_CONFIG.maxAttempts
      ? new Date(now.getTime() + LOGIN_THROTTLE_CONFIG.lockoutDurationMs)
      : null;

  await storage.upsertLoginAttempt(key, count, now, lockedUntil);
}

export async function clearLoginAttempts(identifier: string, ip: string): Promise<void> {
  const key = getLoginKey(identifier, ip);
  await storage.deleteLoginAttempt(key);
}

const sanitizeOptions: sanitizeHtml.IOptions = {
  allowedTags: [
    "b", "i", "em", "strong", "a", "p", "br", "ul", "ol", "li",
    "blockquote", "code", "pre", "h1", "h2", "h3", "h4", "h5", "h6"
  ],
  allowedAttributes: {
    "a": ["href", "target", "rel"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  transformTags: {
    "a": (tagName, attribs) => {
      return {
        tagName,
        attribs: {
          ...attribs,
          target: "_blank",
          rel: "noopener noreferrer nofollow",
        },
      };
    },
  },
};

export function sanitizeUserInput(input: string): string {
  if (!input || typeof input !== "string") return "";
  return sanitizeHtml(input, sanitizeOptions);
}

export function sanitizeTextOnly(input: string): string {
  if (!input || typeof input !== "string") return "";
  return sanitizeHtml(input, { allowedTags: [], allowedAttributes: {} });
}

export function validateAndSanitizeObject<T extends Record<string, any>>(
  obj: T,
  textFields: (keyof T)[],
  richTextFields: (keyof T)[] = []
): T {
  const result = { ...obj };
  
  for (const field of textFields) {
    if (result[field] && typeof result[field] === "string") {
      (result as any)[field] = sanitizeTextOnly(result[field] as string);
    }
  }
  
  for (const field of richTextFields) {
    if (result[field] && typeof result[field] === "string") {
      (result as any)[field] = sanitizeUserInput(result[field] as string);
    }
  }
  
  return result;
}

export const securityHeaders = (req: Request, res: Response, next: NextFunction) => {
  const isProduction = process.env.NODE_ENV === "production";

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(self), microphone=(), camera=()");

  // Per-request nonce — use res.locals.cspNonce to stamp any legitimate inline <script>
  const nonce = crypto.randomBytes(16).toString("base64");
  res.locals.cspNonce = nonce;

  // In production the Vite bundle is all external files — no inline scripts needed.
  // In development Vite HMR injects inline scripts, so unsafe-inline/unsafe-eval are
  // kept only in that environment.
  const scriptSrc = isProduction
    ? `script-src 'self' 'nonce-${nonce}' https://js.stripe.com`
    : `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com`;

  const cspDirectives = [
    "default-src 'self'",
    scriptSrc,
    // unsafe-inline for style-src is required: React inline style={{}} props produce
    // inline style attributes which browsers block without it.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https: http:",
    "worker-src 'self'",
    "connect-src 'self' https://api.stripe.com https://fonts.googleapis.com https://fonts.gstatic.com wss: ws:",
    "frame-src 'self' https://js.stripe.com https://hooks.stripe.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  res.setHeader("Content-Security-Policy", cspDirectives.join("; "));

  if (isProduction) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload"
    );
  }

  next();
};

export function logSecurityEvent(
  eventType: "login_failed" | "login_success" | "lockout" | "csrf_violation" | "rate_limited" | "suspicious_activity",
  details: Record<string, any>
): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    eventType,
    ...details,
  };
  console.log(`[SECURITY] ${JSON.stringify(logEntry)}`);
}
