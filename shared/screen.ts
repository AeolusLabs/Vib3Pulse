// Room "screen": turns a pasted link into something the room can safely show. Pure, no network.
// Only allow-listed providers get an iframe, and the embed URL is always built from a parsed id on a
// fixed host, never from the user's string. Everything else valid is a link card.
export type ScreenProvider = "youtube" | "vimeo" | "spotify" | "apple_music" | "soundcloud" | "image" | "link";

export interface Screen {
  v: 1;
  provider: ScreenProvider;
  kind: "video" | "audio" | "image" | "link";
  url: string;
  embedUrl?: string;
  openUrl: string;
  title?: string;
  thumb?: string;
}

export type ResolveResult =
  | { ok: true; screen: Screen }
  | { ok: false; reason: "invalid_url" | "unsafe_scheme" | "too_long" };

const MAX_LEN = 2048;
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const MEDIA_PATH = /^\/api\/media\/[A-Za-z0-9_-]{1,100}$/;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const SOUNDCLOUD_RESERVED = new Set(["discover", "you", "stream", "upload", "search", "pages", "settings", "charts", "tags", "feed", "messages", "notifications"]);

/** Exact host or a true `www.`/`m.` subdomain, never a substring. */
const hostIs = (h: string, base: string) => h === base || h === `www.${base}` || h === `m.${base}`;

function embedFor(u: URL): Pick<Screen, "provider" | "kind" | "embedUrl"> | null {
  if (u.port) return null;
  const h = u.hostname.toLowerCase();
  const path = u.pathname;
  let m: RegExpMatchArray | null;

  if (hostIs(h, "youtube.com") || h === "music.youtube.com") {
    const id = path === "/watch" ? u.searchParams.get("v") : (m = path.match(/^\/shorts\/([^/]+)\/?$/)) ? m[1] : null;
    if (id && YT_ID.test(id)) return { provider: "youtube", kind: "video", embedUrl: `https://www.youtube-nocookie.com/embed/${id}` };
    return null;
  }
  if (h === "youtu.be") {
    m = path.match(/^\/([^/]+)\/?$/);
    if (m && YT_ID.test(m[1])) return { provider: "youtube", kind: "video", embedUrl: `https://www.youtube-nocookie.com/embed/${m[1]}` };
    return null;
  }
  if (hostIs(h, "vimeo.com")) {
    m = path.match(/^\/(\d{1,12})\/?$/);
    return m ? { provider: "vimeo", kind: "video", embedUrl: `https://player.vimeo.com/video/${m[1]}` } : null;
  }
  if (h === "open.spotify.com") {
    m = path.match(/^\/(?:intl-[a-z]{2,5}\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]{10,30})\/?$/);
    return m ? { provider: "spotify", kind: "audio", embedUrl: `https://open.spotify.com/embed/${m[1]}/${m[2]}` } : null;
  }
  if (h === "music.apple.com") {
    m = path.match(/^\/([a-z]{2})\/(album|song|playlist)\/([\w.~%-]+)(?:\/([\w.~%-]+))?\/?$/);
    if (!m) return null;
    const i = u.searchParams.get("i");
    const tail = m[4] ? `/${m[4]}` : "";
    return {
      provider: "apple_music", kind: "audio",
      embedUrl: `https://embed.music.apple.com/${m[1]}/${m[2]}/${m[3]}${tail}${i && /^\d{1,20}$/.test(i) ? `?i=${i}` : ""}`,
    };
  }
  if (hostIs(h, "soundcloud.com")) {
    m = path.match(/^\/([\w-]+)\/([\w-]+)\/?$/);
    if (!m || SOUNDCLOUD_RESERVED.has(m[1].toLowerCase())) return null;
    return { provider: "soundcloud", kind: "audio", embedUrl: `https://w.soundcloud.com/player/?url=${encodeURIComponent(`https://soundcloud.com/${m[1]}/${m[2]}`)}` };
  }
  return null;
}

export function resolveScreen(input: string): ResolveResult {
  const raw = typeof input === "string" ? input.trim() : "";
  if (raw.length > MAX_LEN) return { ok: false, reason: "too_long" };
  if (MEDIA_PATH.test(raw)) return { ok: true, screen: { v: 1, provider: "image", kind: "image", url: raw, openUrl: raw } };

  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, reason: "invalid_url" }; }
  if (u.protocol !== "https:") return { ok: false, reason: "unsafe_scheme" };
  if (u.username || u.password || !u.hostname) return { ok: false, reason: "invalid_url" };

  const base = { v: 1 as const, url: u.href, openUrl: u.href };
  const e = embedFor(u);
  if (e) return { ok: true, screen: { ...base, ...e } };
  if (IMAGE_EXT.test(u.pathname)) return { ok: true, screen: { ...base, provider: "image", kind: "image" } };
  return { ok: true, screen: { ...base, provider: "link", kind: "link" } };
}

/** Re-validates a value read back from storage or the wire. Only `url` is trusted as input; everything else is recomputed. */
export function screenFromStored(input: unknown): Screen | null {
  try {
    if (!input || typeof input !== "object") return null;
    const o = input as Record<string, unknown>;
    if (typeof o.url !== "string") return null;
    const r = resolveScreen(o.url);
    if (!r.ok) return null;
    const screen: Screen = { ...r.screen };
    if (typeof o.title === "string" && o.title.trim()) screen.title = o.title.trim().slice(0, 120);
    if (typeof o.thumb === "string") {
      const t = resolveScreen(o.thumb);
      if (t.ok && t.screen.provider === "image") screen.thumb = t.screen.url;
    }
    return screen;
  } catch {
    return null;
  }
}
