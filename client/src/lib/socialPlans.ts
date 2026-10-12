// Shapes returned by the social plan API (server/socialPlanRoutes.ts) plus small helpers
// shared by the promote panel and the Social promotions page.

export interface PromoteTarget {
  eventId?: string;
  venueId?: string;
  venueNightId?: string;
}

// GET /api/social/plans/me
export interface PlanSummary {
  active: boolean;
  tier?: string;
  label?: string;
  billing?: "recurring" | "one_off";
  endsAt?: string;
  autoRenew?: boolean;
  campaignsUsed?: number;
  campaignsLimit?: number;
  campaignsLeft?: number;
  maxPlatforms?: number;
  timesPerCampaign?: number;
  platformsConnected: number;
  extraCampaigns?: number;
  extraPlatforms?: number;
  canAddPlatformTopup?: boolean;
  currency?: "GBP" | "NGN";
}

// GET /api/organizer/connected-socials
export interface ConnectedSocial {
  platform: string;
  handle: string | null;
  connectedAt: string;
  needsReconnect?: boolean;
}

// GET /api/social/campaigns
export interface CampaignRow {
  id: string;
  eventId: string | null;
  venueId: string | null;
  venueNightId: string | null;
  eventTitle: string;
  platforms: string[];
  timezone: string;
  status: string;
  createdAt: string;
  sends: Array<{ id: string; sendIndex: number; runAt: string; status: string; note: string | null; postsCreated: number | null }>;
}

export interface PromoteResult {
  postsCreated: number;
  platforms: Array<{ platform: string; success: boolean; error?: string }>;
}

export const SEND_STATUS_LABEL: Record<string, string> = {
  scheduled: "Scheduled", sending: "Posting…", sent: "Posted", partial: "Partly posted",
  failed: "Failed", skipped: "Skipped", cancelled: "Cancelled",
};

// Value for <input type="datetime-local" min=...>, in the browser's local time.
export function localInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Query string for "campaigns about this thing".
export function targetQuery(target: PromoteTarget): string {
  if (target.eventId) return `eventId=${encodeURIComponent(target.eventId)}`;
  if (target.venueNightId) return `venueNightId=${encodeURIComponent(target.venueNightId)}`;
  if (target.venueId) return `venueId=${encodeURIComponent(target.venueId)}`;
  return "";
}

export async function fetchCampaigns(query = ""): Promise<CampaignRow[]> {
  const res = await fetch(`/api/social/campaigns${query ? `?${query}` : ""}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load campaigns");
  return res.json();
}
