import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Loader2Icon, MinimizeIcon, XIcon } from "@/components/ui/icons";
import type { ScreenTrack } from "@/hooks/useRoomVoice";
import { pickDevices, rememberDevice, rememberedDevice, type Dev } from "@/lib/mediaDevices";
import { formatMmSs } from "@/lib/voiceState";
import type { VideoProfile } from "@/lib/bandwidth";

interface Props {
  /** The track to show: your own preview while you hold the screen, otherwise what the holder sends. */
  track: ScreenTrack | null;
  holderName: string | null;
  /** You hold the screen (the host gave it to you). */
  isHolder: boolean;
  cameraOn: boolean;
  cameraError: string | null;
  /** Call from a click: starts your camera and microphone with the chosen devices. */
  onGoLive: (devices: { cameraId?: string; micId?: string; musicMode?: boolean }) => Promise<unknown>;
  onStop: () => void;
  /** Someone on stage who may ask (or, for the host and co-hosts, take) the screen. */
  canAsk: boolean;
  askLabel: string;
  asked: boolean;
  onAsk: () => void;
  onWithdraw: () => void;
  /** Not connected to the room's media yet (the browser wants a tap first): nothing can be shown until they tap. */
  needsTap: boolean;
  onTap: () => void;
  /** The holder's connection dropped and their spot is being held: viewers see a slate instead of "No one is live". */
  holderAway: boolean;
  /** Only for the holder, while their own connection is down: about how long the spot is held (ms), null otherwise. */
  holderLeftMs: number | null;
  /** Weak connections. Holder: picture quality, and dropping the picture while keeping the sound. Viewer: sound only to save data. */
  quality: VideoProfile | "auto";
  onQuality: (q: VideoProfile | "auto") => void;
  videoPaused: boolean;
  onPauseVideo: () => void;
  onResumeVideo: () => void;
  audioOnly: boolean;
  onAudioOnly: (on: boolean) => void;
  /** Own connection has been poor for a while: offer the sound-only option. */
  weakLink: boolean;
  /** The holder's automatic comeback after a drop is running: Go live waits for it. */
  comingBack: boolean;
  /** Chat + reactions shown over the bottom of the stage while it is fullscreen. */
  strip?: ReactNode;
}

type FsVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
const fsElement = () => (document.fullscreenElement ?? (document as any).webkitFullscreenElement) as Element | null | undefined;

/** The room's screen when live video is on: one stage, one person on it, 16:9. Nothing is recorded. */
export default function ScreenStage({ track, holderName, isHolder, cameraOn, cameraError, onGoLive, onStop, canAsk, askLabel, asked, onAsk, onWithdraw, needsTap, onTap, holderAway, holderLeftMs, quality, onQuality, videoPaused, onPauseVideo, onResumeVideo, audioOnly, onAudioOnly, weakLink, comingBack, strip }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const videoEl = useRef<HTMLVideoElement>(null);
  const [cams, setCams] = useState<Dev[]>([]);
  const [mics, setMics] = useState<Dev[]>([]);
  const [camId, setCamId] = useState("");
  const [micId, setMicId] = useState("");
  const [starting, setStarting] = useState(false);
  const [musicMode, setMusicMode] = useState(false);
  const musicHelpId = useId();
  const [isFull, setIsFull] = useState(false); // the stage box is fullscreen (not iPhone's video-only fullscreen, which has no room for chat)
  const [stripOpen, setStripOpen] = useState(true);
  const fsButton = useRef<HTMLButtonElement>(null);
  const exitButton = useRef<HTMLButtonElement>(null);
  const wasFull = useRef(false);

  // The <video> belongs to this component; the track is attached to it and detached again, never the other way round.
  useEffect(() => {
    const el = videoEl.current;
    if (!el || !track) return;
    track.attach(el);
    return () => { track.detach(el); };
  }, [track]);

  const refreshDevices = useCallback(async () => {
    try {
      const { cameras, mics: microphones } = pickDevices(await navigator.mediaDevices.enumerateDevices());
      setCams(cameras); setMics(microphones);
      setCamId((cur) => (cameras.some((d) => d.deviceId === cur) ? cur : rememberedDevice("camera", cameras) ?? cameras[0]?.deviceId ?? ""));
      setMicId((cur) => (microphones.some((d) => d.deviceId === cur) ? cur : rememberedDevice("mic", microphones) ?? microphones[0]?.deviceId ?? ""));
    } catch { /* no media devices API (insecure page or old browser): going live will explain */ }
  }, []);

  useEffect(() => {
    if (!isHolder) return;
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
  }, [isHolder, cameraOn, refreshDevices]); // names appear only after permission: look again once the camera is on

  const goLive = async () => {
    setStarting(true);
    rememberDevice("camera", camId); rememberDevice("mic", micId);
    await onGoLive({ cameraId: camId || undefined, micId: micId || undefined, musicMode });
    setStarting(false);
  };

  useEffect(() => {
    const onChangeFs = () => setIsFull(!!fsElement() && fsElement() === box.current);
    document.addEventListener("fullscreenchange", onChangeFs);
    document.addEventListener("webkitfullscreenchange", onChangeFs);
    return () => { document.removeEventListener("fullscreenchange", onChangeFs); document.removeEventListener("webkitfullscreenchange", onChangeFs); };
  }, []);

  // The Fullscreen button disappears when fullscreen opens: move focus to Exit, and give it back on the way out.
  useEffect(() => {
    if (isFull) exitButton.current?.focus();
    else if (wasFull.current) fsButton.current?.focus();
    wasFull.current = isFull;
  }, [isFull]);

  const fullscreen = () => {
    const el = box.current as FsElement | null;
    if (el?.requestFullscreen) void el.requestFullscreen().catch(() => {});
    else if (el?.webkitRequestFullscreen) void Promise.resolve(el.webkitRequestFullscreen()).catch(() => {});
    else (videoEl.current as FsVideo | null)?.webkitEnterFullscreen?.(); // iPhone Safari only fullscreens the video itself
  };
  const exitFullscreen = () => { if (fsElement()) void Promise.resolve(document.exitFullscreen?.() ?? (document as any).webkitExitFullscreen?.()).catch(() => {}); };

  const locked = cameraOn || starting || comingBack;
  const videoName = isHolder ? "Your live video" : holderName ? `Live video from ${holderName}` : "Live video";

  const showVideo = !!track;
  return (
    <section aria-label="Live screen" className="space-y-3" data-testid="screen-stage">
      <div ref={box} className="relative aspect-video w-full overflow-hidden rounded-2xl border border-border bg-muted data-[fullscreen=true]:rounded-none data-[fullscreen=true]:border-0" data-fullscreen={isFull ? "true" : "false"}>
        <video ref={videoEl} autoPlay playsInline muted aria-label={videoName} className={`h-full w-full object-contain ${showVideo ? "" : "hidden"}`} data-testid="screen-video" />
        {!showVideo && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center" data-testid="live-empty">
            {holderAway && !isHolder ? (
              <div role="status" className="flex flex-col items-center gap-1" data-testid="live-away-slate">
                <Loader2Icon className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
                <p className="font-serif text-2xl font-bold">Back in a moment</p>
                <p className="text-sm text-muted-foreground">{holderName ?? "The streamer"} lost connection. Their spot is being held.</p>
              </div>
            ) : (
              <>
                <p className="font-serif text-2xl font-bold">{isHolder ? "You're up" : "No one is live"}</p>
                <p className="text-sm text-muted-foreground">
                  {isHolder ? "Pick your camera and microphone, then go live."
                    : holderName && audioOnly ? `Sound only: you can hear ${holderName}. Tap Watch video to see the picture.`
                    : holderName ? `${holderName} has the screen. No picture right now.`
                    : "The host can put someone on the screen."}
                </p>
              </>
            )}
            {needsTap && <Button type="button" className="mt-2 min-h-[44px] rounded-full" onClick={onTap} data-testid="button-tap-watch">Tap to hear and watch</Button>}
          </div>
        )}
        {showVideo && (
          <>
            <span role="status" className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-background/80 px-2.5 py-1 text-xs font-medium backdrop-blur" data-testid="live-badge"><span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden />{holderAway ? "Reconnecting…" : isHolder ? "You're live" : holderName ? `${holderName} is live` : "Live"}</span>
            {!isFull && <Button type="button" ref={fsButton} variant="secondary" size="sm" className="absolute bottom-3 right-3 min-h-[44px] rounded-full" onClick={fullscreen} data-testid="button-screen-fullscreen">Fullscreen</Button>}
          </>
        )}
        {isFull && (
          <>
            <Button type="button" ref={exitButton} size="icon" variant="secondary" onClick={exitFullscreen} className="absolute right-3 top-3 z-20 h-11 w-11 rounded-full" aria-label="Exit fullscreen" data-testid="button-screen-exit"><MinimizeIcon className="h-5 w-5" aria-hidden /></Button>
            {strip && (
              <div className="absolute inset-x-0 bottom-0 z-20 max-h-[45%] overflow-y-auto bg-background/85 p-2 backdrop-blur" data-testid="stage-strip">
                <Button type="button" size="sm" variant="ghost" className="mb-1 min-h-[44px] rounded-full" onClick={() => setStripOpen((o) => !o)} aria-expanded={stripOpen} data-testid="button-stage-strip">
                  {stripOpen ? <><XIcon className="mr-1 h-3.5 w-3.5" aria-hidden />Hide chat</> : "Show chat"}
                </Button>
                {stripOpen && strip}
              </div>
            )}
          </>
        )}
      </div>

      {isHolder && (
        <div className="space-y-3 rounded-2xl border border-border p-3" data-testid="holder-controls">
          {holderLeftMs !== null && (
            <div className="space-y-1 rounded-xl bg-muted px-3 py-2 text-sm" data-testid="holder-reconnecting">
              {/* Announced once; the ticking time sits outside the status so it is not read out every second. */}
              <p role="status">Your connection dropped. We're holding your spot. Your stream carries on by itself when you're back.</p>
              <p className="text-muted-foreground">Time left: <span className="font-medium tabular-nums text-foreground" aria-live="off">{formatMmSs(holderLeftMs)}</span></p>
            </div>
          )}
          {videoPaused && (
            <p role="status" className="rounded-xl bg-muted px-3 py-2 text-sm" data-testid="video-paused">Your picture is off to save your connection. Your sound is still live.</p>
          )}
          {weakLink && cameraOn && !videoPaused && (
            <div role="status" className="space-y-2 rounded-xl bg-muted px-3 py-2 text-sm" data-testid="weak-link-holder">
              <p>Your connection is weak. Pause the picture and keep the sound?</p>
              <Button size="sm" variant="outline" className="min-h-[44px] rounded-full" onClick={onPauseVideo} data-testid="button-pause-picture">Pause picture, keep sound</Button>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Quality</span>
              <select value={quality} onChange={(e) => onQuality(e.target.value as VideoProfile | "auto")} disabled={locked} className="min-h-[44px] w-full rounded-md border border-input bg-background px-3 text-base" data-testid="select-quality">
                <option value="auto">Auto</option>
                <option value="saver">Data saver (360p)</option>
                <option value="balanced">Balanced (540p)</option>
                <option value="standard">High (720p)</option>
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Camera</span>
              <select value={camId} onChange={(e) => setCamId(e.target.value)} disabled={locked} className="min-h-[44px] w-full rounded-md border border-input bg-background px-3 text-base" data-testid="select-camera">
                {cams.length === 0 && <option value="">No camera found</option>}
                {cams.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Microphone</span>
              <select value={micId} onChange={(e) => setMicId(e.target.value)} disabled={locked} className="min-h-[44px] w-full rounded-md border border-input bg-background px-3 text-base" data-testid="select-mic">
                {mics.length === 0 && <option value="">No microphone found</option>}
                {mics.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
              </select>
            </label>
          </div>
          <div>
            <label className="flex min-h-[44px] w-fit cursor-pointer items-center gap-3 text-sm">
              <Switch checked={musicMode} onCheckedChange={setMusicMode} disabled={locked} aria-describedby={musicHelpId} data-testid="switch-music-mode" />
              <span>Music mode</span>
            </label>
            <p id={musicHelpId} className="text-xs text-muted-foreground">Use headphones, or the room may hear itself.</p>
          </div>
          {cameraError && <p role="alert" className="text-sm text-destructive" data-testid="camera-error">{cameraError}</p>}
          <div className="flex flex-wrap gap-2">
            {videoPaused && <Button className="min-h-[44px] rounded-full" onClick={onResumeVideo} disabled={comingBack} data-testid="button-resume-picture">Turn picture back on</Button>}
            {(cameraOn || videoPaused)
              ? <Button className="min-h-[44px] rounded-full" variant="destructive" onClick={onStop} data-testid="button-stop-live">Stop live</Button>
              : <Button className="min-h-[44px] rounded-full" onClick={() => void goLive()} disabled={starting || comingBack} data-testid="button-go-live">{comingBack ? <><Loader2Icon className="mr-2 h-4 w-4 animate-spin" aria-hidden />Reconnecting…</> : starting ? <><Loader2Icon className="mr-2 h-4 w-4 animate-spin" aria-hidden />Starting…</> : "Go live"}</Button>}
            {!cameraOn && !videoPaused && <Button className="min-h-[44px] rounded-full" variant="ghost" onClick={onStop} data-testid="button-give-up-screen">Hand back the screen</Button>}
          </div>
        </div>
      )}

      {!isHolder && (
        <div className="flex flex-wrap items-center gap-2">
          {weakLink && !audioOnly && (
            <p role="status" className="w-full rounded-xl bg-muted px-3 py-2 text-sm" data-testid="weak-link-viewer">Your connection is weak. Switch to sound only to keep listening smoothly?</p>
          )}
          <Button type="button" size="sm" variant={audioOnly ? "default" : "outline"} className="min-h-[44px] rounded-full" aria-pressed={audioOnly} onClick={() => onAudioOnly(!audioOnly)} data-testid="button-audio-only">
            {audioOnly ? "Watch video" : "Sound only (saves data)"}
          </Button>
        </div>
      )}

      {!isHolder && canAsk && (
        <Button className="min-h-[44px] rounded-full" variant={asked ? "outline" : "default"} onClick={asked ? onWithdraw : onAsk} aria-pressed={asked} data-testid="button-ask-live">{asked ? "Cancel request" : askLabel}</Button>
      )}
    </section>
  );
}
