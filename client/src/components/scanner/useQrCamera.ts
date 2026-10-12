import { useCallback, useEffect, useRef, useState } from "react";
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";

export type CameraProblem = "denied" | "none" | "error" | null;

/**
 * One camera that stays on. Door staff scan a guest every few seconds, so the camera is started once and
 * every decoded QR goes to `onDecode`; deduping and pausing is the caller's job.
 */
export function useQrCamera(regionId: string, onDecode: (text: string) => void) {
  const scanner = useRef<Html5Qrcode | null>(null);
  const cameras = useRef<Array<{ id: string; label: string }>>([]);
  const cameraIndex = useRef(0);
  const decode = useRef(onDecode);
  decode.current = onDecode;
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<CameraProblem>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [cameraCount, setCameraCount] = useState(0);

  const stop = useCallback(async () => {
    const s = scanner.current;
    scanner.current = null;
    if (s) {
      try { await s.stop(); } catch { /* already stopped */ }
      try { s.clear(); } catch { /* element gone */ }
    }
    setRunning(false);
    setTorchOn(false);
    setTorchSupported(false);
  }, []);

  const start = useCallback(async (deviceId?: string) => {
    await stop();
    setProblem(null);
    try {
      const s = new Html5Qrcode(regionId, { verbose: false, formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE] });
      scanner.current = s;
      await s.start(
        deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "environment" },
        {
          fps: 12,
          qrbox: (w, h) => { const side = Math.floor(Math.min(w, h) * 0.72); return { width: side, height: side }; },
        },
        (text) => decode.current(text),
        undefined,
      );
      setRunning(true);
      try {
        cameras.current = await Html5Qrcode.getCameras();
        setCameraCount(cameras.current.length);
        const caps: any = (s as any).getRunningTrackCameraCapabilities?.();
        setTorchSupported(!!caps?.torchFeature?.().isSupported());
      } catch {
        // Listing cameras or torch support is optional.
      }
    } catch (e: any) {
      scanner.current = null;
      const msg = String(e?.message ?? e ?? "");
      setProblem(/permission|denied|notallowed/i.test(msg) ? "denied" : /not ?found|no camera|requested device/i.test(msg) ? "none" : "error");
      setRunning(false);
    }
  }, [regionId, stop]);

  const flip = useCallback(async () => {
    if (cameras.current.length < 2) return;
    cameraIndex.current = (cameraIndex.current + 1) % cameras.current.length;
    await start(cameras.current[cameraIndex.current].id);
  }, [start]);

  const toggleTorch = useCallback(async () => {
    const s: any = scanner.current;
    if (!s) return;
    try {
      const next = !torchOn;
      await s.getRunningTrackCameraCapabilities().torchFeature().apply(next);
      setTorchOn(next);
    } catch {
      setTorchSupported(false);
    }
  }, [torchOn]);

  useEffect(() => () => { void stop(); }, [stop]);

  return { running, problem, start, stop, flip, torchSupported, torchOn, toggleTorch, canFlip: cameraCount > 1 };
}
