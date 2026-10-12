// Avatar config: the single source of truth for what a user's avatar may contain.
// Used by the server (PATCH validation), the editor, and the renderer. Config only,
// never images: the renderer draws any valid config.

export const AVATAR_TYPES = ["female", "male", "neutral"] as const;
export type AvatarType = (typeof AVATAR_TYPES)[number];

export const HAIR_BY_TYPE: Record<AvatarType, readonly string[]> = {
  male: ["fade", "buzz", "crop", "quiff", "mohawk", "punk", "cornrows", "dreads", "afro", "topknot", "bald"],
  female: ["long", "wavy", "bangs", "bob", "pixie", "ponytail", "buns", "braids", "puffs"],
  neutral: ["crop", "bob", "curls", "mohawk", "dreads", "afro", "pixie", "quiff", "buzz", "punk"],
};
export const EXPRESSIONS = ["smile", "grin", "smirk", "wink", "neutral", "frown", "scowl", "surprised"] as const;
export const FACIAL = ["none", "stubble", "mustache", "goatee", "beard", "full"] as const;
export const OUTFITS = ["hoodie", "bomber", "tee", "tank", "sweater"] as const;
export const EYEWEAR = ["none", "round", "shades"] as const;
export const HEADWEAR = ["none", "cap", "beanie", "headphones"] as const;

export interface AvatarConfig {
  v: 1;
  type: AvatarType;
  skin: number; // 0..7
  hair: string;
  hairColor: number; // 0..7
  expression: (typeof EXPRESSIONS)[number];
  facial: (typeof FACIAL)[number];
  outfit: (typeof OUTFITS)[number];
  outfitColor: number; // 0..7
  eyewear: (typeof EYEWEAR)[number];
  headwear: (typeof HEADWEAR)[number];
  hoops: boolean;
}

// What switching to a body type resets: the hair list, hoops and facial hair differ by type.
const TYPE_DEFAULTS: Record<AvatarType, Pick<AvatarConfig, "hair" | "hoops" | "facial">> = {
  female: { hair: "long", hoops: true, facial: "none" },
  male: { hair: "fade", hoops: false, facial: "none" },
  neutral: { hair: "crop", hoops: false, facial: "none" },
};

export function defaultAvatar(type: AvatarType = "female"): AvatarConfig {
  return {
    v: 1,
    type,
    skin: 3,
    hairColor: 0,
    expression: "smile",
    outfit: "hoodie",
    outfitColor: 0,
    eyewear: "none",
    headwear: "none",
    ...TYPE_DEFAULTS[type],
  };
}

export function switchAvatarType(config: AvatarConfig, type: AvatarType): AvatarConfig {
  if (config.type === type) return config;
  return { ...config, type, ...TYPE_DEFAULTS[type] };
}

const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : fallback;

const index = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(7, Math.max(0, Math.floor(v))) : fallback;

/** Returns a fully valid config, or null when the input is not a plain object. */
export function sanitizeAvatarConfig(input: unknown): AvatarConfig | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const i = input as Record<string, unknown>;
  const type = oneOf(AVATAR_TYPES, i.type, "female");
  const d = defaultAvatar(type);
  return {
    v: 1,
    type,
    skin: index(i.skin, d.skin),
    hair: oneOf(HAIR_BY_TYPE[type] as readonly string[], i.hair, d.hair),
    hairColor: index(i.hairColor, d.hairColor),
    expression: oneOf(EXPRESSIONS, i.expression, d.expression),
    facial: type === "female" ? "none" : oneOf(FACIAL, i.facial, d.facial),
    outfit: oneOf(OUTFITS, i.outfit, d.outfit),
    outfitColor: index(i.outfitColor, d.outfitColor),
    eyewear: oneOf(EYEWEAR, i.eyewear, d.eyewear),
    headwear: oneOf(HEADWEAR, i.headwear, d.headwear),
    hoops: typeof i.hoops === "boolean" ? i.hoops : d.hoops,
  };
}

export type AvatarValidation = { ok: true; value: AvatarConfig } | { ok: false; field: string };

const isIndex = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 7;
const isOneOf = (list: readonly string[], v: unknown): v is string => typeof v === "string" && list.includes(v);

/**
 * Strict check for incoming API bodies: every field must be present and valid, otherwise the first failing
 * field is named. Unknown keys are dropped. (sanitizeAvatarConfig is the lenient repair used when rendering.)
 */
export function validateAvatarConfig(input: unknown): AvatarValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, field: "avatar" };
  const i = input as Record<string, unknown>;
  if (!isOneOf(AVATAR_TYPES, i.type)) return { ok: false, field: "type" };
  const type = i.type as AvatarType;
  if (!isIndex(i.skin)) return { ok: false, field: "skin" };
  if (!isOneOf(HAIR_BY_TYPE[type], i.hair)) return { ok: false, field: "hair" };
  if (!isIndex(i.hairColor)) return { ok: false, field: "hairColor" };
  if (!isOneOf(EXPRESSIONS, i.expression)) return { ok: false, field: "expression" };
  if (!isOneOf(FACIAL, i.facial) || (type === "female" && i.facial !== "none")) return { ok: false, field: "facial" };
  if (!isOneOf(OUTFITS, i.outfit)) return { ok: false, field: "outfit" };
  if (!isIndex(i.outfitColor)) return { ok: false, field: "outfitColor" };
  if (!isOneOf(EYEWEAR, i.eyewear)) return { ok: false, field: "eyewear" };
  if (!isOneOf(HEADWEAR, i.headwear)) return { ok: false, field: "headwear" };
  if (typeof i.hoops !== "boolean") return { ok: false, field: "hoops" };
  return {
    ok: true,
    value: {
      v: 1, type, skin: i.skin, hair: i.hair, hairColor: i.hairColor,
      expression: i.expression as AvatarConfig["expression"], facial: i.facial as AvatarConfig["facial"],
      outfit: i.outfit as AvatarConfig["outfit"], outfitColor: i.outfitColor,
      eyewear: i.eyewear as AvatarConfig["eyewear"], headwear: i.headwear as AvatarConfig["headwear"], hoops: i.hoops,
    },
  };
}

// ---- avatar as profile picture -------------------------------------------------------------------------------
// Every screen and API payload treats users.avatarUrl as "the picture to show". When a user picks their avatar
// as their picture, avatarUrl points at the rendered avatar image and the real photo is parked in
// users.profilePhotoUrl. Mode is "on" exactly when avatarUrl is an avatar image URL.

export const AVATAR_IMAGE_PREFIX = "/api/avatar-img/";

/** Short stable content hash (FNV-1a over the config's fields in fixed order); used to bust image caches. */
export function avatarVersion(c: AvatarConfig): string {
  const s = [c.v, c.type, c.skin, c.hair, c.hairColor, c.expression, c.facial, c.outfit, c.outfitColor, c.eyewear, c.headwear, c.hoops].join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

export const avatarImageUrl = (userId: string, c: AvatarConfig): string => `${AVATAR_IMAGE_PREFIX}${userId}.svg?v=${avatarVersion(c)}`;

export const isAvatarImageUrl = (url: string | null | undefined): boolean =>
  typeof url === "string" && url.startsWith(AVATAR_IMAGE_PREFIX) && url.length > AVATAR_IMAGE_PREFIX.length;

export interface PictureState { id: string; avatarUrl: string | null; profilePhotoUrl: string | null }
export interface AvatarSaveUpdates { avatar: AvatarConfig | null; avatarUrl?: string | null; profilePhotoUrl?: string | null }

/**
 * Column updates for saving (or clearing) the avatar. `usePicture` true/false chooses the mode; omitted keeps the
 * current mode. Turning the mode on parks the current photo; off (or clearing the avatar) restores it.
 */
export function avatarSaveUpdates(user: PictureState, avatar: AvatarConfig | null, usePicture?: boolean): AvatarSaveUpdates {
  const on = isAvatarImageUrl(user.avatarUrl);
  const want = avatar === null ? false : (usePicture ?? on);
  if (want && avatar) return { avatar, avatarUrl: avatarImageUrl(user.id, avatar), profilePhotoUrl: on ? user.profilePhotoUrl : user.avatarUrl };
  if (on) return { avatar, avatarUrl: user.profilePhotoUrl, profilePhotoUrl: null };
  return { avatar };
}

/** Uploading or choosing a photo is an explicit choice of that photo: avatar-as-picture goes off. `replaced` is the old photo to delete. */
export function photoSetUpdates(user: PictureState, newUrl: string): { updates: { avatarUrl: string; profilePhotoUrl: null }; replaced: string | null } {
  const on = isAvatarImageUrl(user.avatarUrl);
  return { updates: { avatarUrl: newUrl, profilePhotoUrl: null }, replaced: (on ? user.profilePhotoUrl : user.avatarUrl) ?? null };
}

/** Removing the photo: while avatar-as-picture is on only the parked photo goes, and the avatar stays the picture. */
export function photoDeleteUpdates(user: PictureState): { avatarUrl?: null; profilePhotoUrl?: null } {
  return isAvatarImageUrl(user.avatarUrl) ? { profilePhotoUrl: null } : { avatarUrl: null };
}
