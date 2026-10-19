// The spray effects canvas. It fills its positioned parent (inset 0), ignores every touch (pointer-events: none)
// and is hidden from assistive tech: what happened is said by the server's chat line, never by the canvas.
// It owns one SprayEngine for its lifetime and exposes it through `engineRef` (null before mount and after unmount).
import { useEffect, useRef, type MutableRefObject } from "react";
import { SprayEngine } from "./engine";

export interface SprayLayerProps {
  engineRef: MutableRefObject<SprayEngine | null>;
  className?: string;
  /** Optional: true while a live video is on screen, which lowers the note cap to 120. Read every frame. */
  videoActive?: () => boolean;
  /** Optional: a lower note cap than the engine's 200. */
  maxNotes?: number;
}

// Exported both ways so either `import SprayLayer` or `import { SprayLayer }` works for the tray lane.
export default SprayLayer;
export function SprayLayer({ engineRef, className, videoActive, maxNotes }: SprayLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Latest videoActive without recreating the engine when the parent passes a new function each render.
  const videoRef = useRef(videoActive);
  videoRef.current = videoActive;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new SprayEngine(canvas, {
      maxNotes,
      videoActive: () => { const f = videoRef.current; return f ? f() : false; },
    });
    engineRef.current = engine;
    const fit = () => {
      const r = canvas.getBoundingClientRect();
      engine.setSize(r.width, r.height, window.devicePixelRatio || 1);
    };
    fit();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(fit);
      ro.observe(canvas);
    } else {
      window.addEventListener("resize", fit);
    }
    return () => {
      if (ro) ro.disconnect(); else window.removeEventListener("resize", fit);
      engine.destroy();
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, [engineRef, maxNotes]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 h-full w-full${className ? ` ${className}` : ""}`}
      style={{ pointerEvents: "none" }}
    />
  );
}
