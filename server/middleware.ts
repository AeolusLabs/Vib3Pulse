import type { Request, Response, NextFunction } from "express";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ message: "Authentication required" });
}

export function requireOrganizer(req: Request, res: Response, next: NextFunction) {
  if (req.isAuthenticated() && req.user?.userType === "organizer") {
    return next();
  }
  res.status(403).json({ message: "Organizer access required" });
}

export function requireSocial(req: Request, res: Response, next: NextFunction) {
  if (req.isAuthenticated() && req.user?.userType === "social") {
    return next();
  }
  res.status(403).json({ message: "Social user access required" });
}
