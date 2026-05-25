import { Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import sanitizeHtml from "sanitize-html";

const CSRF_TOKEN_HEADER = "x-csrf-token";
const CSRF_TOKEN_COOKIE = "csrf-token";

const loginAttempts = new Map<string, { count: number; lastAttempt: number; lockedUntil?: number }>();

const LOGIN_THROTTLE_CONFIG = {
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
  lockoutDurationMs: 15 * 60 * 1000,
  cleanupIntervalMs: 60 * 60 * 1000,
};

setInterval(() => {
  const now = Date.now();
  const entries = Array.from(loginAttempts.entries());
  for (const [key, data] of entries) {
    if (now - data.lastAttempt > LOGIN_THROTTLE_CONFIG.windowMs * 2) {
      loginAttempts.delete(key);
    }
  }
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
  max: 100,
  message: { 
    message: "Too many requests. Please slow down.",
    code: "RATE_LIMITED"
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    return req.path.startsWith("/auth/session");
  },
});

export const sensitiveOperationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: {
    message: "Too many sensitive operations. Please try again later.",
    code: "RATE_LIMITED"
  },
  standardHeaders: true,
  legacyHeaders: false,
});

export const ratingSubmitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => (req.user as any)?.id ?? req.ip ?? "anonymous",
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

export function checkLoginThrottle(identifier: string, ip: string): { allowed: boolean; remainingAttempts?: number; lockedUntil?: Date } {
  const key = getLoginKey(identifier, ip);
  const now = Date.now();
  const data = loginAttempts.get(key);

  if (!data) {
    return { allowed: true, remainingAttempts: LOGIN_THROTTLE_CONFIG.maxAttempts };
  }

  if (data.lockedUntil && now < data.lockedUntil) {
    return { 
      allowed: false, 
      lockedUntil: new Date(data.lockedUntil)
    };
  }

  if (data.lockedUntil && now >= data.lockedUntil) {
    loginAttempts.delete(key);
    return { allowed: true, remainingAttempts: LOGIN_THROTTLE_CONFIG.maxAttempts };
  }

  if (now - data.lastAttempt > LOGIN_THROTTLE_CONFIG.windowMs) {
    loginAttempts.delete(key);
    return { allowed: true, remainingAttempts: LOGIN_THROTTLE_CONFIG.maxAttempts };
  }

  const remainingAttempts = LOGIN_THROTTLE_CONFIG.maxAttempts - data.count;
  return { allowed: remainingAttempts > 0, remainingAttempts: Math.max(0, remainingAttempts) };
}

export function recordLoginAttempt(identifier: string, ip: string, success: boolean): void {
  const key = getLoginKey(identifier, ip);
  const now = Date.now();

  if (success) {
    loginAttempts.delete(key);
    return;
  }

  const data = loginAttempts.get(key) || { count: 0, lastAttempt: now };
  
  if (now - data.lastAttempt > LOGIN_THROTTLE_CONFIG.windowMs) {
    data.count = 1;
  } else {
    data.count++;
  }
  
  data.lastAttempt = now;

  if (data.count >= LOGIN_THROTTLE_CONFIG.maxAttempts) {
    data.lockedUntil = now + LOGIN_THROTTLE_CONFIG.lockoutDurationMs;
  }

  loginAttempts.set(key, data);
}

export function clearLoginAttempts(identifier: string, ip: string): void {
  const key = getLoginKey(identifier, ip);
  loginAttempts.delete(key);
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
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(self), microphone=(), camera=()");
  
  const cspDirectives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com https://fonts.googleapis.com",
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
  
  if (process.env.NODE_ENV === "production") {
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
