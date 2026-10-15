// Keeps the room's player in step with the host. The host's player reports play / pause / seek and a heartbeat; guests
// compare their player with the server-stamped target and nudge it when it drifts. Providers whose players cannot be
// driven (Spotify, Apple Music, SoundCloud) get a countdown cue instead. All of it is best effort: if the player API
// cannot be reached the plain embed keeps working and `available` is false.
import { useCallback, useEffect, useRef, useState } from "react";
import { cueCountdownMs, type NowPlaying, type PlaybackState } from "@shared/playback";
import type { Screen } from "@shared/screen";
import { attachPlayer, syncDecision, type PlayerAdapter } from "@/lib/playerAdapters";

const HEARTBEAT_EVERY = 5;       // controller ticks (1 s each)
const SEEK_JUMP_MS = 2000;       // a position jump bigger than this while playing is a seek
const GUEST_TICK_MS = 2000;

export interface ScreenSync {
  /** null = nothing to sync here or still connecting; false = the provider's player API could not be reached. */
  available: boolean | null;
  watchOwn: boolean;
  setWatchOwn(v: boolean): void;
  catchUp(): void;
  /** The player wants to play but the browser is refusing until the viewer taps. */
  needsTap: boolean;
  tapToPlay(): void;
  /** Countdown for cue providers, null when there is no cue. */
  cueRemainingMs: number | null;
}

export function useScreenSync(a: {
  screen: Screen | null;
  iframe: HTMLIFrameElement | null;
  loaded: boolean;
  nowPlaying: NowPlaying | null;
  serverOffsetMs: number;
  canControl: boolean;
  sendPlayback: (p: { state: PlaybackState; positionMs: number; inMs?: number }) => boolean;
}): ScreenSync {
  const provider = a.screen?.provider === "youtube" || a.screen?.provider === "vimeo" ? a.screen.provider : null;
  const [available, setAvailable] = useState<boolean | null>(null);
  const [watchOwn, setWatchOwn] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  const [cueRemainingMs, setCueRemaining] = useState<number | null>(null);
  const adapter = useRef<PlayerAdapter | null>(null);
  const live = useRef(a); live.current = a;
  const wantPlayTicks = useRef(0);

  // attach once the iframe has loaded; tear down when the screen changes
  useEffect(() => {
    setAvailable(null); setNeedsTap(false); wantPlayTicks.current = 0;
    if (!provider || !a.iframe || !a.loaded) return;
    let dead = false;
    attachPlayer(provider, a.iframe).then((ad) => {
      if (dead) { ad?.destroy(); return; }
      adapter.current = ad;
      setAvailable(ad !== null);
    });
    return () => { dead = true; adapter.current?.destroy(); adapter.current = null; };
  }, [provider, a.iframe, a.loaded, a.screen?.embedUrl]);

  // the controller (host / co-host) reports what its player does
  useEffect(() => {
    if (!available || !a.canControl) return;
    const ad = adapter.current;
    if (!ad) return;
    const report = (state: PlaybackState) => live.current.sendPlayback({ state, positionMs: ad.positionMs() });
    let lastPos = ad.positionMs(), lastAt = Date.now(), ticks = 0;
    const off = ad.onState((s) => {
      if (s === "playing") report("playing"); else if (s === "paused") report("paused"); else if (s === "ended") report("ended");
      lastPos = ad.positionMs(); lastAt = Date.now();
    });
    const t = setInterval(() => {
      const now = Date.now(), pos = ad.positionMs();
      if (ad.isPlaying()) {
        ticks++;
        const jumped = Math.abs(pos - (lastPos + (now - lastAt))) > SEEK_JUMP_MS;
        if (jumped || ticks % HEARTBEAT_EVERY === 0) report("playing");
      } else if (Math.abs(pos - lastPos) > SEEK_JUMP_MS) report("paused"); // seeked while paused
      lastPos = pos; lastAt = now;
    }, 1000);
    return () => { off(); clearInterval(t); };
  }, [available, a.canControl, a.screen?.embedUrl]);

  // guests follow
  const apply = useCallback((ignoreWatchOwn: boolean) => {
    const ad = adapter.current;
    if (!ad || live.current.canControl) return;
    const d = syncDecision({
      nowPlaying: live.current.nowPlaying, serverOffsetMs: live.current.serverOffsetMs, clientNowMs: Date.now(),
      playerMs: ad.positionMs(), playerPlaying: ad.isPlaying(), watchOwn: ignoreWatchOwn ? false : watchOwnRef.current,
    });
    if (d.action === "none") { wantPlayTicks.current = 0; setNeedsTap(false); return; }
    if (d.seekToMs !== undefined) ad.seekTo(d.seekToMs);
    if (d.action === "play") {
      ad.play();
      wantPlayTicks.current++;
      if (wantPlayTicks.current >= 2) setNeedsTap(true); // asked twice and it still is not playing: the browser wants a tap
    } else {
      wantPlayTicks.current = 0; setNeedsTap(false);
      if (d.action === "pause") ad.pause();
    }
  }, []);
  const watchOwnRef = useRef(false); watchOwnRef.current = watchOwn;

  useEffect(() => {
    if (!available || a.canControl) return;
    apply(false);
    const t = setInterval(() => apply(false), GUEST_TICK_MS);
    return () => clearInterval(t);
  }, [available, a.canControl, a.nowPlaying, apply]);

  // countdown for cue providers (and for anyone, whatever the provider: a cue is a cue)
  useEffect(() => {
    const np = a.nowPlaying;
    if (!np || np.state !== "cue") { setCueRemaining(null); return; }
    const tick = () => setCueRemaining(cueCountdownMs(np, Date.now() + live.current.serverOffsetMs));
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [a.nowPlaying]);

  return {
    available, watchOwn, setWatchOwn, needsTap, cueRemainingMs,
    catchUp: () => apply(true),
    tapToPlay: () => { adapter.current?.play(); setNeedsTap(false); wantPlayTicks.current = 0; },
  };
}
