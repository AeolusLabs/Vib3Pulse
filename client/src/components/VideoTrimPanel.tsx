import { useRef, useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useVideoTrimmer } from "@/hooks/useVideoTrimmer";
import { VideoFilmstrip } from "@/components/VideoFilmstrip";
import { ScissorsIcon } from "@/components/ui/icons";

const E = {
  drawer: "cubic-bezier(0.32, 0.72, 0, 1)",
  out:    "cubic-bezier(0.23, 1, 0.32, 1)",
} as const;

const MIN_CLIP_SECS = 1;
const MAX_CLIP_SECS = 60;

function fmt(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export interface VideoTrimPanelProps {
  videoUrl: string;
  duration: number;
  onConfirm: (blob: Blob, newDuration: number) => void;
  onCancel: () => void;
}

/**
 * Full-screen trim panel. The visible <video> element inside this panel is
 * used directly as the captureStream source during recording — this avoids
 * the off-screen frame-throttling Chrome applies to hidden video elements.
 *
 * Loop playback is driven by a requestAnimationFrame loop reading from refs,
 * not state, so in/out point updates during dragging are reflected immediately
 * without restarting the loop on every setState call.
 */
export function VideoTrimPanel({ videoUrl, duration, onConfirm, onCancel }: VideoTrimPanelProps) {
  const videoRef   = useRef<HTMLVideoElement>(null);
  const trackRef   = useRef<HTMLDivElement>(null);
  const loopRafRef = useRef<number>(0);

  // Render-state versions of in/out points (drive the UI)
  const [inPoint,  setInPoint]  = useState(0);
  const [outPoint, setOutPoint] = useState(Math.min(duration, MAX_CLIP_SECS));

  // Ref versions are always current — the RAF loop reads these to avoid
  // stale closures when in/out points change during drag.
  const inRef  = useRef(0);
  const outRef = useRef(Math.min(duration, MAX_CLIP_SECS));

  const syncIn  = (v: number) => { inRef.current  = v; setInPoint(v);  };
  const syncOut = (v: number) => { outRef.current = v; setOutPoint(v); };

  const { trim, isTrimming, progress } = useVideoTrimmer();

  // ── loop playback ─────────────────────────────────────────────────────────

  const startLoop = useCallback(() => {
    cancelAnimationFrame(loopRafRef.current);
    const video = videoRef.current;
    if (!video) return;

    video.currentTime = inRef.current;
    video.play().catch(() => {});

    const tick = () => {
      const vid = videoRef.current;
      if (!vid) return;
      if (!vid.paused && vid.currentTime >= outRef.current) {
        vid.currentTime = inRef.current;
      }
      loopRafRef.current = requestAnimationFrame(tick);
    };
    loopRafRef.current = requestAnimationFrame(tick);
  }, []);

  const stopLoop = useCallback(() => {
    cancelAnimationFrame(loopRafRef.current);
    videoRef.current?.pause();
  }, []);

  // Start loop once the video metadata is ready
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onReady = () => startLoop();
    if (video.readyState >= 1) {
      startLoop();
    } else {
      video.addEventListener("loadedmetadata", onReady, { once: true });
    }

    return () => {
      video.removeEventListener("loadedmetadata", onReady);
      stopLoop();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup on unmount
  useEffect(() => () => cancelAnimationFrame(loopRafRef.current), []);

  // ── handle drag ───────────────────────────────────────────────────────────

  const onHandlePointerDown = useCallback((
    e: React.PointerEvent,
    handle: "in" | "out",
  ) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);

    // Pause the loop during drag; video is scrubbed directly
    stopLoop();

    const track = trackRef.current;
    if (!track) return;

    const onMove = (ev: PointerEvent) => {
      const rect  = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const time  = ratio * duration;

      if (handle === "in") {
        // Clamp: [0, outPoint - MIN] but also keep within MAX_CLIP of outPoint
        const raw     = Math.max(0, Math.min(time, outRef.current - MIN_CLIP_SECS));
        const clamped = Math.max(raw, outRef.current - MAX_CLIP_SECS);
        syncIn(clamped);
        if (videoRef.current) videoRef.current.currentTime = clamped;
      } else {
        // Clamp: [inPoint + MIN, min(duration, inPoint + MAX_CLIP)]
        const clamped = Math.max(
          inRef.current + MIN_CLIP_SECS,
          Math.min(time, duration, inRef.current + MAX_CLIP_SECS),
        );
        syncOut(clamped);
        // Scrub slightly before out-point so user sees what the clip ends on
        if (videoRef.current) {
          videoRef.current.currentTime = Math.max(inRef.current, clamped - 0.1);
        }
      }
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup",   onUp);
      // Restart loop from the (possibly updated) in-point
      startLoop();
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup",   onUp);
  }, [duration, startLoop, stopLoop]);

  // ── trim / record ─────────────────────────────────────────────────────────

  const handleTrim = useCallback(async () => {
    const video = videoRef.current;
    if (!video || isTrimming) return;

    stopLoop();

    try {
      const blob = await trim(video, inRef.current, outRef.current);
      onConfirm(blob, outRef.current - inRef.current);
    } catch (err: any) {
      // Restore loop so the user can adjust and retry
      startLoop();
      throw err; // propagated to StoryCreator's catch → toast
    }
  }, [isTrimming, trim, onConfirm, startLoop, stopLoop]);

  // ── derived UI values ─────────────────────────────────────────────────────

  const clipDuration = outPoint - inPoint;
  const inPercent    = (inPoint  / duration) * 100;
  const outPercent   = (outPoint / duration) * 100;
  const tooShort     = clipDuration < MIN_CLIP_SECS;

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <motion.div
      key="trim-panel"
      initial={{ y: "100%" }}
      animate={{ y: 0 }}
      exit={{ y: "100%" }}
      transition={{ duration: 0.35, ease: E.drawer }}
      className="absolute inset-0 z-50 bg-[#0A0A0A] flex flex-col"
    >
      {/* ── header ── */}
      <div className="flex items-center justify-between px-5 pt-12 pb-3 shrink-0">
        <button
          onClick={onCancel}
          disabled={isTrimming}
          className="text-white/55 text-sm font-medium disabled:opacity-30 active:opacity-60 transition-opacity"
          aria-label="Cancel trim"
        >
          Cancel
        </button>

        <h3 className="text-white font-semibold text-[15px]">Trim Video</h3>

        <button
          onClick={handleTrim}
          disabled={isTrimming || tooShort}
          className="flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-bold disabled:opacity-30 active:scale-95"
          style={{
            backgroundColor: "#C4B0FF",
            color: "#0A0A0A",
            transition: `all 0.12s ${E.out}`,
          }}
          aria-label="Confirm trim"
        >
          {isTrimming ? (
            <div className="w-4 h-4 border-2 border-black/25 border-t-black rounded-full animate-spin" />
          ) : (
            <ScissorsIcon className="h-3.5 w-3.5" />
          )}
          {isTrimming ? "Trimming" : "Trim"}
        </button>
      </div>

      {/* ── video preview ── */}
      <div className="flex-1 relative bg-black flex items-center justify-center overflow-hidden">
        <div
          className="relative"
          style={{ aspectRatio: "9/16", height: "100%", maxWidth: "100%" }}
        >
          <video
            ref={videoRef}
            src={videoUrl}
            playsInline
            className="absolute inset-0 w-full h-full object-contain"
          />

          {/* recording overlay */}
          <AnimatePresence>
            {isTrimming && progress && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="absolute inset-0 flex flex-col items-center justify-center bg-black/75"
              >
                <div
                  className="w-12 h-12 rounded-full border-4 border-white/15 border-t-[#C4B0FF] animate-spin mb-5"
                  style={{ animationDuration: "0.7s" }}
                />
                <p className="text-white font-semibold text-base">Trimming clip…</p>
                <p className="text-white/50 text-sm mt-1 tabular-nums">
                  {fmt(progress.elapsed)} / {fmt(progress.total)}
                </p>

                {/* progress bar */}
                <div className="w-48 h-1.5 bg-white/10 rounded-full overflow-hidden mt-4">
                  <motion.div
                    className="h-full rounded-full"
                    style={{ background: "linear-gradient(90deg, #C4B0FF, #FF6B9D)" }}
                    animate={{ width: `${(progress.elapsed / progress.total) * 100}%` }}
                    transition={{ duration: 0.1, ease: "linear" }}
                  />
                </div>

                <p className="text-white/25 text-xs mt-3 text-center px-10">
                  Recording in real time — this takes as long as the clip
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* ── controls ── */}
      <div
        className="shrink-0 px-4 pt-4 pb-10 space-y-3"
        style={{ background: "linear-gradient(to top, #111 80%, transparent)" }}
      >
        {/* time display */}
        <div className="flex items-center justify-between px-1">
          <span
            className="text-sm font-mono font-semibold tabular-nums"
            style={{ color: "#C4B0FF" }}
          >
            {fmt(inPoint)}
          </span>
          <span className="text-white/35 text-xs">
            {fmt(clipDuration)} selected
          </span>
          <span
            className="text-sm font-mono font-semibold tabular-nums"
            style={{ color: "#FF6B9D" }}
          >
            {fmt(outPoint)}
          </span>
        </div>

        {/* filmstrip with selection overlay */}
        <div className="relative">
          <VideoFilmstrip
            videoUrl={videoUrl}
            duration={duration}
            frameCount={10}
            className="w-full"
          />

          {/* dim unselected left region */}
          {inPercent > 0 && (
            <div
              className="absolute inset-y-0 left-0 bg-black/65 rounded-l-lg pointer-events-none"
              style={{ width: `${inPercent}%` }}
            />
          )}

          {/* dim unselected right region */}
          {outPercent < 100 && (
            <div
              className="absolute inset-y-0 right-0 bg-black/65 rounded-r-lg pointer-events-none"
              style={{ width: `${100 - outPercent}%` }}
            />
          )}

          {/* selection border */}
          <div
            className="absolute inset-y-0 pointer-events-none"
            style={{
              left:   `${inPercent}%`,
              right:  `${100 - outPercent}%`,
              border: "2px solid #C4B0FF",
              borderRadius: 6,
              boxShadow: "0 0 8px rgba(196,176,255,0.4)",
            }}
          />
        </div>

        {/* scrub track + handles */}
        <div
          ref={trackRef}
          className="relative flex items-center"
          style={{ height: 44, touchAction: "none" }}
        >
          {/* track rail */}
          <div className="absolute inset-x-0 h-1.5 rounded-full bg-white/12">
            {/* selected region fill */}
            <div
              className="absolute inset-y-0 rounded-full"
              style={{
                left:       `${inPercent}%`,
                right:      `${100 - outPercent}%`,
                background: "linear-gradient(90deg, #C4B0FF, #FF6B9D)",
              }}
            />
          </div>

          {/* in-point handle — 44px touch target, 16px visible pill */}
          <div
            className="absolute flex items-center justify-center"
            style={{
              left:      `${inPercent}%`,
              transform: "translateX(-50%)",
              width:  44,
              height: 44,
              cursor: "ew-resize",
              touchAction: "none",
              zIndex: 10,
            }}
            onPointerDown={e => onHandlePointerDown(e, "in")}
            aria-label={`In point: ${fmt(inPoint)}`}
            role="slider"
            aria-valuenow={Math.round(inPoint)}
            aria-valuemin={0}
            aria-valuemax={Math.round(outPoint - MIN_CLIP_SECS)}
          >
            <div
              className="w-4 h-8 rounded-full flex items-center justify-center"
              style={{
                backgroundColor: "#C4B0FF",
                boxShadow: "0 0 0 3px rgba(196,176,255,0.25), 0 0 14px rgba(196,176,255,0.5)",
              }}
            >
              <div className="w-0.5 h-4 rounded-full bg-white/70" />
            </div>
          </div>

          {/* out-point handle */}
          <div
            className="absolute flex items-center justify-center"
            style={{
              left:      `${outPercent}%`,
              transform: "translateX(-50%)",
              width:  44,
              height: 44,
              cursor: "ew-resize",
              touchAction: "none",
              zIndex: 10,
            }}
            onPointerDown={e => onHandlePointerDown(e, "out")}
            aria-label={`Out point: ${fmt(outPoint)}`}
            role="slider"
            aria-valuenow={Math.round(outPoint)}
            aria-valuemin={Math.round(inPoint + MIN_CLIP_SECS)}
            aria-valuemax={Math.round(duration)}
          >
            <div
              className="w-4 h-8 rounded-full flex items-center justify-center"
              style={{
                backgroundColor: "#FF6B9D",
                boxShadow: "0 0 0 3px rgba(255,107,157,0.25), 0 0 14px rgba(255,107,157,0.5)",
              }}
            >
              <div className="w-0.5 h-4 rounded-full bg-white/70" />
            </div>
          </div>
        </div>

        {/* contextual hint */}
        <p
          className="text-center text-xs px-4"
          style={{ color: tooShort ? "rgba(248,113,113,0.8)" : "rgba(255,255,255,0.22)" }}
        >
          {tooShort
            ? "Minimum clip length is 1 second"
            : "Drag handles to set start and end · Video loops selection"}
        </p>
      </div>
    </motion.div>
  );
}