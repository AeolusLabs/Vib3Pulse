// Drives the YouTube and Vimeo players inside the room screen so everyone watches at about the same moment.
// The decision logic is pure (syncDecision); the adapters wrap each provider's player API. The provider API scripts are
// loaded on demand from the allow-listed hosts only, and any failure (blocked, offline, slow) just means "no sync":
// the plain embed keeps working.
import { needsCorrection, targetPositionMs, type NowPlaying } from "@shared/playback";

export type PlayerEvent = "playing" | "paused" | "ended" | "buffering";

export interface PlayerAdapter {
  play(): void;
  pause(): void;
  seekTo(ms: number): void;
  positionMs(): number;
  isPlaying(): boolean;
  onState(cb: (s: PlayerEvent) => void): () => void;
  /** Stops listening. Never removes the iframe: React owns it, and a shared iframe may be re-attached straight away. */
  destroy(): void;
}

/** The nocookie embed with the JS API switched on. Throws for any other host so nothing user-supplied is ever framed. */
export function youtubeEmbedWithApi(embedUrl: string, origin: string): string {
  const u = new URL(embedUrl);
  if (u.protocol !== "https:" || u.hostname !== "www.youtube-nocookie.com") throw new Error("not a YouTube embed");
  u.searchParams.set("enablejsapi", "1");
  u.searchParams.set("origin", origin);
  return u.toString();
}

export type SyncAction = { action: "none" } | { action: "play" | "pause" | "seek"; seekToMs?: number };

/** What a guest's player should do to match the host. `playerMs` is null while the player is not ready. */
export function syncDecision(i: {
  nowPlaying: NowPlaying | null; serverOffsetMs: number; clientNowMs: number; playerMs: number | null; playerPlaying: boolean; watchOwn: boolean;
}): SyncAction {
  const np = i.nowPlaying;
  if (!np || i.watchOwn || i.playerMs === null) return { action: "none" };
  if (np.state === "cue" || np.state === "ended") return { action: "none" };
  const target = targetPositionMs(np, i.clientNowMs + i.serverOffsetMs);
  const off = needsCorrection(i.playerMs, target);
  if (np.state === "paused") {
    if (i.playerPlaying) return off ? { action: "pause", seekToMs: target } : { action: "pause" };
    return off ? { action: "seek", seekToMs: target } : { action: "none" };
  }
  if (!i.playerPlaying) return off ? { action: "play", seekToMs: target } : { action: "play" };
  return off ? { action: "seek", seekToMs: target } : { action: "none" };
}

// ---------------------------------------------------------------- loaders (browser only)
const LOAD_TIMEOUT_MS = 8000;
const loaders = new Map<string, Promise<boolean>>();

function loadScript(src: string): Promise<boolean> {
  const hit = loaders.get(src);
  if (hit) return hit;
  const p = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), LOAD_TIMEOUT_MS);
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = () => { clearTimeout(timer); resolve(true); };
    el.onerror = () => { clearTimeout(timer); resolve(false); };
    document.head.appendChild(el);
  }).then((ok) => { if (!ok) loaders.delete(src); return ok; }); // a failed load may be retried later
  loaders.set(src, p);
  return p;
}

function timeout<T>(p: Promise<T>, ms = LOAD_TIMEOUT_MS): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

// ---------------------------------------------------------------- YouTube
async function attachYouTube(iframe: HTMLIFrameElement): Promise<PlayerAdapter | null> {
  const w = window as any;
  if (!w.YT?.Player) {
    const ready = new Promise<void>((resolve) => { const prev = w.onYouTubeIframeAPIReady; w.onYouTubeIframeAPIReady = () => { prev?.(); resolve(); }; });
    if (!(await loadScript("https://www.youtube.com/iframe_api"))) return null;
    if ((await timeout(ready)) === null && !w.YT?.Player) return null;
  }
  return timeout(new Promise<PlayerAdapter>((resolve) => {
    const listeners = new Set<(s: PlayerEvent) => void>();
    let state = -1;
    const player = new w.YT.Player(iframe, {
      events: {
        onReady: () => resolve(adapter),
        onStateChange: (e: { data: number }) => {
          state = e.data;
          const s: PlayerEvent | null = e.data === 1 ? "playing" : e.data === 2 ? "paused" : e.data === 0 ? "ended" : e.data === 3 ? "buffering" : null;
          if (s) listeners.forEach((cb) => cb(s));
        },
      },
    });
    const adapter: PlayerAdapter = {
      play: () => player.playVideo(),
      pause: () => player.pauseVideo(),
      seekTo: (ms) => player.seekTo(ms / 1000, true),
      positionMs: () => Math.round((player.getCurrentTime?.() ?? 0) * 1000),
      isPlaying: () => state === 1,
      onState: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
      // Only stop listening. The provider's destroy() would remove the iframe from the page, and React owns that iframe.
      destroy: () => { listeners.clear(); },
    };
  }));
}

// ---------------------------------------------------------------- Vimeo
async function attachVimeo(iframe: HTMLIFrameElement): Promise<PlayerAdapter | null> {
  const w = window as any;
  if (!w.Vimeo?.Player && !(await loadScript("https://player.vimeo.com/api/player.js"))) return null;
  if (!w.Vimeo?.Player) return null;
  const player = new w.Vimeo.Player(iframe);
  if ((await timeout(player.ready())) === null) return null;
  const listeners = new Set<(s: PlayerEvent) => void>();
  let pos = 0, playing = false;
  const emit = (s: PlayerEvent) => listeners.forEach((cb) => cb(s));
  player.on("timeupdate", (d: { seconds: number }) => { pos = Math.round(d.seconds * 1000); });
  player.on("play", () => { playing = true; emit("playing"); });
  player.on("pause", () => { playing = false; emit("paused"); });
  player.on("ended", () => { playing = false; emit("ended"); });
  player.on("bufferstart", () => emit("buffering"));
  return {
    play: () => { void player.play().catch(() => {}); },
    pause: () => { void player.pause().catch(() => {}); },
    seekTo: (ms) => { pos = ms; void player.setCurrentTime(ms / 1000).catch(() => {}); },
    positionMs: () => pos,
    isPlaying: () => playing,
    onState: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    // Only stop listening (Vimeo's destroy() removes the iframe, which React owns).
    destroy: () => { listeners.clear(); },
  };
}

/** null when the player API could not be reached in time: the room carries on without sync. Never throws. */
export async function attachPlayer(provider: "youtube" | "vimeo", iframe: HTMLIFrameElement): Promise<PlayerAdapter | null> {
  try {
    return provider === "youtube" ? await attachYouTube(iframe) : await attachVimeo(iframe);
  } catch {
    return null;
  }
}
