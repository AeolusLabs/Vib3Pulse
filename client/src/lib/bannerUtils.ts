export type BannerMode = "fingerprint" | "vibe" | "custom";

export type VibeKey =
  | "hype"
  | "chill"
  | "social"
  | "creative"
  | "underground"
  | "offgrid";

export interface VibeDef {
  label: string;
  tagline: string;
  gradient: string;
  /** Representative swatch colour shown in the picker */
  swatch: string;
}

export const VIBES: Record<VibeKey, VibeDef> = {
  hype: {
    label: "Hype",
    tagline: "High energy, ready to go",
    gradient: "linear-gradient(135deg, #f97316 0%, #ec4899 100%)",
    swatch: "#f97316",
  },
  chill: {
    label: "Chill",
    tagline: "Relaxed and in the flow",
    gradient: "linear-gradient(135deg, #1e3a5f 0%, #7c3aed 100%)",
    swatch: "#7c3aed",
  },
  social: {
    label: "Social",
    tagline: "Out here, meeting people",
    gradient: "linear-gradient(135deg, #d97706 0%, #f43f5e 100%)",
    swatch: "#d97706",
  },
  creative: {
    label: "Creative",
    tagline: "In the zone, making things",
    gradient: "linear-gradient(135deg, #0d9488 0%, #84cc16 100%)",
    swatch: "#0d9488",
  },
  underground: {
    label: "Underground",
    tagline: "Dark, raw, independent",
    gradient: "linear-gradient(135deg, #1c1917 0%, #991b1b 100%)",
    swatch: "#991b1b",
  },
  offgrid: {
    label: "Off the Grid",
    tagline: "Taking a break from the noise",
    gradient: "linear-gradient(135deg, #334155 0%, #94a3b8 100%)",
    swatch: "#64748b",
  },
};

export const VIBE_KEYS = Object.keys(VIBES) as VibeKey[];

/** djb2 hash — deterministic, fast, no external deps */
function hashString(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h << 5, h) + str.charCodeAt(i);
  }
  return Math.abs(h);
}

/**
 * Derives a unique gradient from the user's interests array.
 * Same interests → same gradient every time. Changing interests updates it.
 */
export function generateFingerprintGradient(interests: string[]): string {
  if (!interests || interests.length === 0) {
    return "linear-gradient(135deg, hsl(260 50% 38%) 0%, hsl(300 45% 48%) 100%)";
  }

  // Sort so order doesn't matter — {music, art} === {art, music}
  const seed = hashString([...interests].sort().join(","));

  const hue1 = seed % 360;
  const hue2 = (hue1 + 40 + (seed % 80)) % 360;
  const angle = 90 + (seed % 120);
  const sat = 48 + (seed % 32);
  const l1 = 28 + (seed % 18);
  const l2 = 42 + (seed % 22);

  return `linear-gradient(${angle}deg, hsl(${hue1} ${sat}% ${l1}%) 0%, hsl(${hue2} ${sat}% ${l2}%) 100%)`;
}

/** Turns a user-chosen hex into a gradient (full → 65% opacity fade) */
function buildCustomGradient(hex: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    return generateFingerprintGradient([]);
  }
  return `linear-gradient(135deg, ${hex} 0%, ${hex}a6 100%)`;
}

interface BannerProfile {
  bannerMode?: string | null;
  bannerVibe?: string | null;
  bannerColor?: string | null;
  interests?: string[] | null;
}

/**
 * Returns the CSS `background` value for a user's profile banner.
 * Falls back gracefully when fields are missing.
 */
export function getBannerStyle(profile: BannerProfile): string {
  const mode = profile.bannerMode || "fingerprint";

  if (mode === "custom" && profile.bannerColor) {
    return buildCustomGradient(profile.bannerColor);
  }

  if (mode === "vibe" && profile.bannerVibe && profile.bannerVibe in VIBES) {
    return VIBES[profile.bannerVibe as VibeKey].gradient;
  }

  // Default: fingerprint from interests
  return generateFingerprintGradient(profile.interests ?? []);
}
