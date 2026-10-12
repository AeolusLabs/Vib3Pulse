import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * The ticket QR, drawn on the device from the validation code: no request, so it opens instantly and
 * works with no signal. Always dark on a white tile (even in dark mode) because scanners need contrast.
 */
export default function QrCode({ value, label, size = 244 }: { value: string; label: string; size?: number }) {
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    QRCode.toString(value, { type: "svg", errorCorrectionLevel: "H", margin: 0, color: { dark: "#111015", light: "#ffffff" } })
      .then((s) => { if (live) setSvg(s); })
      .catch(() => { if (live) setSvg(null); });
    return () => { live = false; };
  }, [value]);

  return (
    <div
      className="grid place-items-center rounded-2xl bg-white p-3.5"
      style={{ width: size, height: size }}
      role="img"
      aria-label={label}
      data-testid="qr-code"
    >
      {svg ? (
        <div className="h-full w-full [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700" />
      )}
    </div>
  );
}
