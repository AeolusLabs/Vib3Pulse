// Lock-screen / headset controls for a joined room. Play and pause both flip the mic; hangup leaves.
export interface MediaSessionOpts { title: string; host: string; muted: boolean; onToggleMute(): void; onLeave(): void }

interface NavLike { mediaSession?: { metadata: unknown; playbackState: string; setActionHandler(a: string, h: (() => void) | null): void } }

const ACTIONS = ["play", "pause", "hangup"] as const;

export function setMediaSession(opts: MediaSessionOpts, nav: NavLike | undefined = typeof navigator === "undefined" ? undefined : (navigator as unknown as NavLike)): () => void {
  if (!nav || !("mediaSession" in nav) || !nav.mediaSession) return () => {};
  const ms = nav.mediaSession;
  try {
    if (typeof MediaMetadata !== "undefined") ms.metadata = new MediaMetadata({ title: opts.title, artist: opts.host, album: "Vib3Pulse Rooms" });
    ms.playbackState = opts.muted ? "paused" : "playing";
  } catch { /* metadata is a nicety */ }
  const handlers: Record<(typeof ACTIONS)[number], () => void> = { play: opts.onToggleMute, pause: opts.onToggleMute, hangup: opts.onLeave };
  // "hangup" throws on browsers that do not know it; the others still register.
  for (const a of ACTIONS) { try { ms.setActionHandler(a, handlers[a]); } catch { /* unsupported action */ } }
  return () => {
    for (const a of ACTIONS) { try { ms.setActionHandler(a, null); } catch { /* unsupported action */ } }
    try { ms.metadata = null; ms.playbackState = "none"; } catch { /* ignore */ }
  };
}
