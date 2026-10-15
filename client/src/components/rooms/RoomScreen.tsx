import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLinkIcon, MaximizeIcon, MinimizeIcon, XIcon } from "@/components/ui/icons";
import { resolveScreen, type Screen } from "@shared/screen";
import type { NowPlaying, PlaybackState } from "@shared/playback";
import { useScreenSync } from "@/hooks/useScreenSync";
import { youtubeEmbedWithApi } from "@/lib/playerAdapters";
import SyncControls from "@/components/rooms/SyncControls";
import { PROVIDER_LABEL } from "@/lib/roomsApi";

interface Props {
  screen: Screen | null;
  /** Host / co-host: shows the paste-a-link control under the screen. */
  canControl: boolean;
  /** url = set, null = clear. Resolves true when the server accepted it. */
  onChange: (url: string | null) => void;
  /** Chat + reactions shown over the bottom of the screen while it is fullscreen. */
  strip?: ReactNode;
  /** Synced playback (part 3a). */
  nowPlaying?: NowPlaying | null;
  serverOffsetMs?: number;
  sendPlayback?: (p: { state: PlaybackState; positionMs: number; inMs?: number }) => boolean;
  /** Only the host's player reports playback; co-hosts follow like guests (two reporters would fight over the position). */
  leadsPlayback?: boolean;
}

type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
const fsElement = () => (document.fullscreenElement ?? (document as any).webkitFullscreenElement) as Element | null | undefined;

const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return u; } };
const SANDBOX = "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox allow-forms";
const ALLOW = "autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write";

/**
 * The room's screen. Only providers on the allow-list ever get an iframe (the server and shared/screen.ts decide;
 * this component renders embedUrl only). A transparent shield over the embed turns a tap into fullscreen; inside
 * fullscreen the shield is gone so the provider's own controls work.
 */
export default function RoomScreen({ screen, canControl, onChange, strip, nowPlaying = null, serverOffsetMs = 0, sendPlayback = () => false, leadsPlayback = false }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);   // native fullscreen
  const [pseudoFull, setPseudoFull] = useState(false);   // iOS Safari: no element fullscreen, so cover the viewport instead
  const [loaded, setLoaded] = useState(false);
  const [stripOpen, setStripOpen] = useState(true);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const isFull = fullscreen || pseudoFull;
  const [iframeEl, setIframeEl] = useState<HTMLIFrameElement | null>(null);
  const sync = useScreenSync({ screen, iframe: iframeEl, loaded, nowPlaying, serverOffsetMs, canControl: leadsPlayback, sendPlayback });
  // YouTube's player API needs enablejsapi + origin on the embed; if that cannot be built the plain embed is used.
  const embedSrc = (() => { if (!screen?.embedUrl) return undefined; try { return screen.provider === "youtube" ? youtubeEmbedWithApi(screen.embedUrl, window.location.origin) : screen.embedUrl; } catch { return screen.embedUrl; } })();

  useEffect(() => {
    setLoaded(false);
    const t = setTimeout(() => setLoaded(true), 6000); // never leave a skeleton up forever if the provider's load event doesn't fire
    return () => clearTimeout(t);
  }, [screen?.embedUrl, screen?.url]);

  useEffect(() => {
    const onChangeFs = () => setFullscreen(!!fsElement() && fsElement() === box.current);
    document.addEventListener("fullscreenchange", onChangeFs);
    document.addEventListener("webkitfullscreenchange", onChangeFs);
    return () => { document.removeEventListener("fullscreenchange", onChangeFs); document.removeEventListener("webkitfullscreenchange", onChangeFs); };
  }, []);

  const exit = useCallback(() => {
    setPseudoFull(false);
    if (fsElement()) (document.exitFullscreen?.() ?? (document as any).webkitExitFullscreen?.());
  }, []);

  // Viewport-cover fullscreen (iOS Safari) behaves like a dialog: Escape closes it, Tab stays inside it, the page behind does not scroll.
  useEffect(() => {
    if (!pseudoFull) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { exit(); return; }
      if (e.key !== "Tab" || !box.current) return;
      const items = Array.from(box.current.querySelectorAll<HTMLElement>("button, a[href], input, [tabindex]:not([tabindex='-1'])")).filter((el) => !el.hasAttribute("disabled"));
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [pseudoFull, exit]);

  // The shield (the focused control) disappears when fullscreen opens: move focus to Exit, and give it back on the way out.
  const exitRef = useRef<HTMLButtonElement>(null);
  const shieldRef = useRef<HTMLButtonElement>(null);
  const wasFull = useRef(false);
  useEffect(() => {
    if (isFull) exitRef.current?.focus();
    else if (wasFull.current) shieldRef.current?.focus();
    wasFull.current = isFull;
  }, [isFull]);

  const enter = async () => {
    const el = box.current as FsElement | null;
    if (!el) return;
    try {
      if (el.requestFullscreen) await el.requestFullscreen();
      else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
      else setPseudoFull(true);
    } catch { setPseudoFull(true); }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const url = draft.trim();
    if (!url) return;
    if (!resolveScreen(url).ok) { setDraftError("That link can't be shown on the screen."); return; }
    setDraftError(null); setDraft(""); onChange(url);
  };

  const providerName = screen ? PROVIDER_LABEL[screen.provider] : "";
  const frameClass = pseudoFull ? "fixed inset-0 z-[60] bg-black" : "relative aspect-video w-full overflow-hidden rounded-2xl bg-muted";

  return (
    <section aria-label="Room screen" className="space-y-2" data-testid="room-screen">
      <div ref={box} className={frameClass} data-fullscreen={isFull ? "true" : "false"} {...(pseudoFull ? { role: "dialog", "aria-modal": true, "aria-label": "Room screen, fullscreen" } : {})}>
        {!screen && (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground" data-testid="screen-empty">
            {canControl ? "Paste a link below to put something on the screen." : "The host hasn't put anything on the screen yet."}
          </div>
        )}

        {screen?.embedUrl && (
          <>
            {!loaded && <Skeleton className="absolute inset-0 h-full w-full" aria-hidden />}
            <iframe
              key={screen.embedUrl}
              ref={setIframeEl}
              src={embedSrc}
              title={`${providerName} player`}
              className="absolute inset-0 h-full w-full border-0"
              sandbox={SANDBOX}
              allow={ALLOW}
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
              loading="lazy"
              onLoad={() => setLoaded(true)}
              data-testid="screen-iframe"
            />
          </>
        )}

        {screen?.provider === "image" && (
          <img src={screen.url} alt={screen.title || "Shared on the room screen"} className="h-full w-full object-contain" referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} data-testid="screen-image" />
        )}

        {screen?.provider === "link" && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" data-testid="screen-link-card">
            <p className="line-clamp-2 text-sm font-semibold">{screen.title || hostOf(screen.url)}</p>
            <p className="max-w-full truncate text-xs text-muted-foreground">{hostOf(screen.url)}</p>
            <Button asChild className="min-h-[44px]"><a href={screen.openUrl} target="_blank" rel="noopener noreferrer">Open link<ExternalLinkIcon className="ml-2 h-4 w-4" /></a></Button>
          </div>
        )}

        {/* Tap anywhere on the embed to go fullscreen. Removed in fullscreen so the provider's own controls work. */}
        {screen?.embedUrl && !isFull && (
          <button type="button" ref={shieldRef} onClick={enter} className="absolute inset-0 z-10 flex items-end justify-end bg-transparent p-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" aria-label="Go fullscreen" data-testid="screen-shield">
            <span className="pointer-events-none inline-flex items-center gap-1 rounded-full bg-black/60 px-2.5 py-1 text-xs text-white"><MaximizeIcon className="h-3.5 w-3.5" aria-hidden />Tap for fullscreen</span>
          </button>
        )}

        {isFull && (
          <>
            <Button type="button" ref={exitRef} size="icon" variant="secondary" onClick={exit} className="absolute right-3 top-3 z-20 h-11 w-11" aria-label="Exit fullscreen" data-testid="screen-exit"><MinimizeIcon className="h-5 w-5" /></Button>
            {strip && (
              <div className="absolute inset-x-0 bottom-0 z-20 max-h-[45%] overflow-y-auto bg-black/70 p-2 text-white" data-testid="screen-strip">
                <Button type="button" size="sm" variant="ghost" className="mb-1 h-8 text-white hover:bg-white/10 hover:text-white" onClick={() => setStripOpen((o) => !o)} aria-expanded={stripOpen}>
                  {stripOpen ? <><XIcon className="mr-1 h-3.5 w-3.5" />Hide chat</> : "Show chat"}
                </Button>
                {stripOpen && strip}
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {screen && screen.provider !== "link" && screen.provider !== "image" && (
          <Button asChild variant="outline" size="sm" className="min-h-[44px]">
            <a href={screen.openUrl} target="_blank" rel="noopener noreferrer" data-testid="screen-open-in">Open in {providerName}<ExternalLinkIcon className="ml-1.5 h-3.5 w-3.5" /></a>
          </Button>
        )}
        {screen?.provider === "spotify" && <span>Full tracks play if you're signed in to Spotify in this browser.</span>}
        {screen?.provider === "apple_music" && <span>Full playback needs an Apple Music subscription.</span>}
      </div>

      <SyncControls screen={screen} sync={sync} canControl={leadsPlayback} canCue={canControl} onCue={(inMs) => sendPlayback({ state: "cue", positionMs: 0, inMs })} />

      {canControl && (
        <form onSubmit={submit} className="space-y-1" data-testid="screen-control">
          <div className="flex gap-2">
            <Input value={draft} onChange={(e) => { setDraft(e.target.value); setDraftError(null); }} placeholder="Paste a YouTube, Vimeo, Spotify, Apple Music or SoundCloud link" inputMode="url" aria-label="Screen link" className="min-h-[44px]" data-testid="input-screen-link" />
            <Button type="submit" className="min-h-[44px]" data-testid="button-set-screen">Set</Button>
            {screen && <Button type="button" variant="outline" className="min-h-[44px]" onClick={() => onChange(null)} data-testid="button-clear-screen">Clear</Button>}
          </div>
          {draftError && <p role="alert" className="text-xs text-destructive">{draftError}</p>}
        </form>
      )}
    </section>
  );
}
