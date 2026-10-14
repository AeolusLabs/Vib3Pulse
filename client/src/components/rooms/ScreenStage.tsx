import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2Icon } from "@/components/ui/icons";
import type { ScreenTrack } from "@/hooks/useRoomVoice";
import { pickDevices, rememberDevice, rememberedDevice, type Dev } from "@/lib/mediaDevices";

interface Props {
  /** The track to show: your own preview while you hold the screen, otherwise what the holder sends. */
  track: ScreenTrack | null;
  holderName: string | null;
  /** You hold the screen (the host gave it to you). */
  isHolder: boolean;
  cameraOn: boolean;
  cameraError: string | null;
  /** Call from a click: starts your camera and microphone with the chosen devices. */
  onGoLive: (devices: { cameraId?: string; micId?: string }) => Promise<void>;
  onStop: () => void;
  /** Someone on stage who may ask (or, for the host and co-hosts, take) the screen. */
  canAsk: boolean;
  askLabel: string;
  asked: boolean;
  onAsk: () => void;
  onWithdraw: () => void;
}

type FsVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

/** The room's screen when live video is on: one stage, one person on it, 16:9. Nothing is recorded. */
export default function ScreenStage({ track, holderName, isHolder, cameraOn, cameraError, onGoLive, onStop, canAsk, askLabel, asked, onAsk, onWithdraw }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const videoEl = useRef<HTMLVideoElement>(null);
  const [cams, setCams] = useState<Dev[]>([]);
  const [mics, setMics] = useState<Dev[]>([]);
  const [camId, setCamId] = useState("");
  const [micId, setMicId] = useState("");
  const [starting, setStarting] = useState(false);

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
    await onGoLive({ cameraId: camId || undefined, micId: micId || undefined });
    setStarting(false);
  };

  const fullscreen = () => {
    const el = box.current;
    if (el?.requestFullscreen) void el.requestFullscreen().catch(() => {});
    else (videoEl.current as FsVideo | null)?.webkitEnterFullscreen?.(); // iPhone Safari only fullscreens the video itself
  };

  const showVideo = !!track;
  return (
    <section aria-label="Live screen" className="space-y-3" data-testid="screen-stage">
      <div ref={box} className="relative aspect-video w-full overflow-hidden rounded-2xl border border-border bg-muted">
        <video ref={videoEl} autoPlay playsInline muted className={`h-full w-full object-contain ${showVideo ? "" : "hidden"}`} data-testid="screen-video" />
        {!showVideo && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center" data-testid="live-empty">
            <p className="font-serif text-2xl font-bold">{isHolder ? "You're up" : "No one is live"}</p>
            <p className="text-sm text-muted-foreground">{isHolder ? "Pick your camera and microphone, then go live." : holderName ? `${holderName} is getting ready.` : "The host can put someone on the screen."}</p>
          </div>
        )}
        {showVideo && (
          <>
            <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-background/80 px-2.5 py-1 text-xs font-medium backdrop-blur"><span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden />{isHolder ? "You're live" : holderName ? `${holderName} is live` : "Live"}</span>
            <Button type="button" variant="secondary" size="sm" className="absolute bottom-3 right-3 min-h-[44px] rounded-full" onClick={fullscreen} data-testid="button-screen-fullscreen">Fullscreen</Button>
          </>
        )}
      </div>

      {isHolder && (
        <div className="space-y-3 rounded-2xl border border-border p-3" data-testid="holder-controls">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Camera</span>
              <select value={camId} onChange={(e) => setCamId(e.target.value)} disabled={cameraOn || starting} className="min-h-[44px] w-full rounded-md border border-input bg-background px-3 text-base" data-testid="select-camera">
                {cams.length === 0 && <option value="">No camera found</option>}
                {cams.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Microphone</span>
              <select value={micId} onChange={(e) => setMicId(e.target.value)} disabled={cameraOn || starting} className="min-h-[44px] w-full rounded-md border border-input bg-background px-3 text-base" data-testid="select-mic">
                {mics.length === 0 && <option value="">No microphone found</option>}
                {mics.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
              </select>
            </label>
          </div>
          {cameraError && <p role="alert" className="text-sm text-destructive" data-testid="camera-error">{cameraError}</p>}
          <div className="flex flex-wrap gap-2">
            {cameraOn
              ? <Button className="min-h-[44px] rounded-full" variant="destructive" onClick={onStop} data-testid="button-stop-live">Stop live</Button>
              : <Button className="min-h-[44px] rounded-full" onClick={() => void goLive()} disabled={starting} data-testid="button-go-live">{starting ? <><Loader2Icon className="mr-2 h-4 w-4 animate-spin" aria-hidden />Starting…</> : "Go live"}</Button>}
            {!cameraOn && <Button className="min-h-[44px] rounded-full" variant="ghost" onClick={onStop} data-testid="button-give-up-screen">Hand back the screen</Button>}
          </div>
        </div>
      )}

      {!isHolder && canAsk && (
        <Button className="min-h-[44px] rounded-full" variant={asked ? "outline" : "default"} onClick={asked ? onWithdraw : onAsk} aria-pressed={asked} data-testid="button-ask-live">{asked ? "Cancel request" : askLabel}</Button>
      )}
    </section>
  );
}
