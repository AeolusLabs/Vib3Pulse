import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CameraIcon, Loader2Icon } from "@/components/ui/icons";

interface Props {
  /** The captured photo, as a file the normal upload path takes. */
  onFile: (file: File) => void;
  onClose: () => void;
}

const BTN = "min-h-[44px] rounded-full";

/** Why the camera could not start, in plain words. null = it started. */
function reasonFor(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "Camera access is blocked. Allow the camera for this site in your browser settings, then try again, or choose a photo instead.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera was found on this device. Choose a photo instead.";
  if (name === "NotReadableError") return "Another app is using the camera. Close it and try again, or choose a photo instead.";
  return "The camera could not be opened. Choose a photo instead.";
}

/** Asks for the camera, shows a live preview, takes the selfie. Falls back to the device's own photo picker when the camera is unavailable. */
export default function SelfieCamera({ onFile, onClose }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [state, setState] = useState<"asking" | "live" | "failed">("asking");
  const [message, setMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let gone = false;
    setState("asking"); setMessage(null);
    if (!navigator.mediaDevices?.getUserMedia) { setState("failed"); setMessage("This browser cannot open the camera here. Choose a photo instead."); return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false })
      .then((s) => {
        if (gone) { s.getTracks().forEach((t) => t.stop()); return; }
        stream.current = s;
        if (video.current) { video.current.srcObject = s; void video.current.play().catch(() => {}); }
        setState("live");
      })
      .catch((e) => { if (!gone) { setState("failed"); setMessage(reasonFor(e)); } });
    return () => { gone = true; stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; };
  }, [attempt]);

  const snap = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
    c.toBlob((b) => {
      if (!b) { setState("failed"); setMessage("The photo could not be taken. Choose a photo instead."); return; }
      stream.current?.getTracks().forEach((t) => t.stop());
      onFile(new File([b], "selfie.jpg", { type: "image/jpeg" }));
    }, "image/jpeg", 0.92);
  };

  return (
    <div className="space-y-3" data-testid="selfie-camera">
      {state !== "failed" && (
        <div className="relative aspect-[4/3] overflow-hidden rounded-xl border border-border bg-muted/40">
          {/* Mirrored like a mirror so the person can frame themselves; the saved photo is not mirrored. */}
          <video ref={video} autoPlay playsInline muted className="h-full w-full -scale-x-100 object-cover" aria-label="Camera preview" />
          {state === "asking" && (
            <div className="absolute inset-0 grid place-items-center gap-2 p-4 text-center text-sm text-muted-foreground" role="status">
              <span><Loader2Icon className="mx-auto mb-2 h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden />Allow the camera when your browser asks.</span>
            </div>
          )}
        </div>
      )}
      {state === "failed" && message && <p role="alert" className="rounded-xl border border-destructive/60 p-3 text-sm text-destructive" data-testid="selfie-camera-error">{message}</p>}
      <div className="flex flex-wrap gap-2">
        {state === "live" && (
          <Button className={BTN} onClick={snap} data-testid="selfie-snap"><CameraIcon className="mr-2 h-4 w-4" aria-hidden />Take photo</Button>
        )}
        {state === "failed" && (
          <>
            <Button variant="outline" className={BTN} onClick={() => setAttempt((n) => n + 1)}>Try the camera again</Button>
            <label className={`inline-flex ${BTN} cursor-pointer items-center border border-border bg-muted px-5 text-sm font-medium has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary`}>
              Choose a photo
              <input type="file" accept="image/*" capture="user" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onFile(f); }} data-testid="age-input-selfie" />
            </label>
          </>
        )}
        <Button variant="ghost" className={BTN} onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}
