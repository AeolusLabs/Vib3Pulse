import { useState, useCallback } from "react";

export interface TrimProgress {
  elapsed: number; // seconds recorded so far
  total: number;   // total clip duration in seconds
}

/**
 * Hook that trims a video clip from a visible HTMLVideoElement using
 * captureStream() + MediaRecorder. Requires Chrome or Edge; throws a
 * descriptive error on Safari (captureStream unsupported).
 *
 * The caller passes the already-mounted video element — this avoids
 * the off-screen frame-throttling issue that affects hidden video elements
 * in Chrome when captureStream is active.
 *
 * Progress is updated via requestAnimationFrame (~60Hz) instead of
 * ontimeupdate (~4Hz), giving <20ms stopping precision vs ~250ms.
 */
export function useVideoTrimmer() {
  const [isTrimming, setIsTrimming] = useState(false);
  const [progress, setProgress] = useState<TrimProgress | null>(null);

  const trim = useCallback(
    (videoEl: HTMLVideoElement, inPoint: number, outPoint: number): Promise<Blob> => {
      const supported =
        typeof MediaRecorder !== "undefined" &&
        ("captureStream" in HTMLVideoElement.prototype ||
          "mozCaptureStream" in HTMLVideoElement.prototype);

      if (!supported) {
        return Promise.reject(
          new Error(
            "Video trim is not supported in this browser — please use Chrome or Edge.",
          ),
        );
      }

      if (outPoint <= inPoint) {
        return Promise.reject(new Error("outPoint must be greater than inPoint"));
      }

      const clipDuration = outPoint - inPoint;

      return new Promise((resolve, reject) => {
        setIsTrimming(true);
        setProgress({ elapsed: 0, total: clipDuration });

        // Ensure playback rate is normal before recording
        videoEl.playbackRate = 1;
        videoEl.currentTime = inPoint;

        const onSeeked = () => {
          videoEl.removeEventListener("seeked", onSeeked);

          // One RAF tick: the browser paints the seeked frame before
          // captureStream starts, preventing a black/stale first frame.
          requestAnimationFrame(() => {
            const stream: MediaStream =
              (videoEl as any).captureStream?.() ||
              (videoEl as any).mozCaptureStream?.();

            if (!stream) {
              setIsTrimming(false);
              setProgress(null);
              reject(new Error("captureStream not available"));
              return;
            }

            const mimeType =
              MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
                ? "video/webm;codecs=vp9"
                : MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
                ? "video/webm;codecs=vp8"
                : "video/webm";

            const recorder = new MediaRecorder(stream, { mimeType });
            const chunks: Blob[] = [];
            let rafId: number;

            const cleanup = () => {
              cancelAnimationFrame(rafId);
              setIsTrimming(false);
              setProgress(null);
            };

            recorder.ondataavailable = e => {
              if (e.data.size > 0) chunks.push(e.data);
            };

            recorder.onstop = () => {
              videoEl.pause();
              cleanup();
              resolve(new Blob(chunks, { type: recorder.mimeType || "video/webm" }));
            };

            recorder.onerror = () => {
              videoEl.pause();
              cleanup();
              reject(new Error("MediaRecorder error during trim"));
            };

            recorder.start(200);
            videoEl.play().catch(err => {
              cleanup();
              reject(err);
            });

            // RAF loop: check currentTime at ~60Hz for precise stopping.
            // Also updates progress so the UI shows elapsed / total seconds.
            const startWall = performance.now();

            const tick = () => {
              const wallElapsed = (performance.now() - startWall) / 1000;
              const videoElapsed = Math.max(0, videoEl.currentTime - inPoint);
              setProgress({
                elapsed: Math.min(videoElapsed, clipDuration),
                total: clipDuration,
              });

              const pastEnd = videoEl.currentTime >= outPoint;
              // Wall-clock safety net: stop if we've waited clipDuration + 1s
              // even if currentTime hasn't caught up (e.g. video stalled).
              const wallOverrun = wallElapsed >= clipDuration + 1;

              if (pastEnd || wallOverrun) {
                if (recorder.state === "recording") recorder.stop();
              } else {
                rafId = requestAnimationFrame(tick);
              }
            };

            rafId = requestAnimationFrame(tick);
          });
        };

        videoEl.addEventListener("seeked", onSeeked);
      });
    },
    [],
  );

  return { trim, isTrimming, progress };
}