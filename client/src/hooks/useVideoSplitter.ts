import { useState, useCallback } from "react";

export interface SplitProgress {
  segment: number;
  total: number;
}

/** Seek a video element to `seekSecs` and capture a JPEG thumbnail data-URL. */
export async function captureVideoThumbnail(blobUrl: string, seekSecs: number): Promise<string> {
  return new Promise((resolve) => {
    const vid = document.createElement("video");
    vid.src = blobUrl;
    vid.muted = true;
    vid.preload = "metadata";

    const render = () => {
      const c = document.createElement("canvas");
      c.width = 108; c.height = 192;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, 108, 192);
      ctx.drawImage(vid, 0, 0, 108, 192);
      resolve(c.toDataURL("image/jpeg", 0.75));
    };

    vid.onseeked = render;
    vid.onloadeddata = () => { if (vid.readyState >= 2) vid.currentTime = seekSecs; };
    vid.onloadedmetadata = () => { vid.currentTime = seekSecs; };
    vid.onerror = () => resolve("");
  });
}

function recordSegment(
  video: HTMLVideoElement,
  start: number,
  segDuration: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    video.currentTime = start;

    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);

      const stream: MediaStream =
        (video as any).captureStream?.() ||
        (video as any).mozCaptureStream?.();

      if (!stream) {
        reject(new Error("captureStream is not supported in this browser"));
        return;
      }

      const mimeType =
        MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" :
        MediaRecorder.isTypeSupported("video/webm;codecs=vp8") ? "video/webm;codecs=vp8" :
        "video/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];

      recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        video.pause();
        resolve(new Blob(chunks, { type: recorder.mimeType || "video/webm" }));
      };
      recorder.onerror = () => reject(new Error("MediaRecorder error during segment capture"));

      recorder.start(200);
      video.play().catch(reject);
      setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, (segDuration + 0.4) * 1000);
    };

    video.addEventListener("seeked", onSeeked);
  });
}

export function useVideoSplitter() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<SplitProgress | null>(null);

  const split = useCallback(async (
    blob: Blob,
    segDurationSecs = 15,
  ): Promise<Blob[]> => {
    const supported =
      typeof MediaRecorder !== "undefined" &&
      ("captureStream" in HTMLVideoElement.prototype ||
       "mozCaptureStream" in HTMLVideoElement.prototype);

    if (!supported) {
      throw new Error(
        "Video splitting is not supported in this browser — please use Chrome or Edge.",
      );
    }

    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    Object.assign(video.style, {
      position: "fixed", top: "-9999px", left: "-9999px",
      width: "1px", height: "1px", opacity: "0", pointerEvents: "none",
    });
    document.body.appendChild(video);

    setIsProcessing(true);
    setProgress(null);

    try {
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("Failed to load video for splitting"));
        video.load();
      });

      const totalDuration = video.duration;
      if (!isFinite(totalDuration) || totalDuration <= 0) {
        throw new Error("Invalid video duration");
      }

      const totalSegments = Math.ceil(totalDuration / segDurationSecs);
      const segments: Blob[] = [];

      for (let i = 0; i < totalSegments; i++) {
        setProgress({ segment: i + 1, total: totalSegments });
        const start = i * segDurationSecs;
        const segDur = Math.min(totalDuration - start, segDurationSecs);
        segments.push(await recordSegment(video, start, segDur));
      }

      return segments;
    } finally {
      if (document.body.contains(video)) document.body.removeChild(video);
      URL.revokeObjectURL(url);
      setIsProcessing(false);
      setProgress(null);
    }
  }, []);

  return { split, isProcessing, progress };
}
