// ID-verification seam. Today the stub reads the columns an admin sets; a real provider replaces `ageVerifier`.
import { storage } from "../storage";
import { toAgeVerification, type AgeVerification } from "@shared/ageVerification";

export interface AgeVerifier {
  status(userId: string): Promise<AgeVerification>;
  start(userId: string): Promise<{ url?: string; message: string }>;
}

const stub: AgeVerifier = {
  async status(userId) {
    const u = await storage.getUser(userId);
    if (!u) return { verified: false, band: null, at: null, method: null };
    return toAgeVerification(u);
  },
  async start() {
    return { message: "ID verification is not available yet" };
  },
};

let override: AgeVerifier | null = null;
export const ageVerifier: AgeVerifier = {
  status: (id) => (override ?? stub).status(id),
  start: (id) => (override ?? stub).start(id),
};
export function setAgeVerifierForTests(v: AgeVerifier | null) { override = v; }
