// Browser-side prep for ID photos: redraw on a canvas (drops EXIF and location), cap the longest edge, re-encode as JPEG.
// The result is handed straight to the upload; nothing here logs, caches or stores image data.
import { fitWithin } from "@/lib/ageReview";

export const EVIDENCE_MIME = "image/jpeg";
export const EVIDENCE_QUALITY = 0.85;
export const EVIDENCE_MAX_EDGE = 1600;

export class ImagePrepError extends Error {
  constructor(readonly code: "BAD_FILE" | "TOO_LARGE") { super(code); }
}

async function decode(file: File): Promise<{ src: CanvasImageSource; w: number; h: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
    } catch { /* fall through to the img element path */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, no) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => no(new ImagePrepError("BAD_FILE"));
      i.src = url;
    });
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, close: () => undefined };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const toBlob = (c: HTMLCanvasElement) =>
  new Promise<Blob>((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new ImagePrepError("BAD_FILE"))), EVIDENCE_MIME, EVIDENCE_QUALITY));

const toBase64 = (b: Blob) =>
  new Promise<string>((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => no(new ImagePrepError("BAD_FILE"));
    r.readAsDataURL(b);
  });

export interface PreparedImage { mime: string; data: string; previewUrl: string }

/** Caller owns previewUrl and must URL.revokeObjectURL it when done. */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith("image/")) throw new ImagePrepError("BAD_FILE");
  const d = await decode(file);
  try {
    const { w, h } = fitWithin(d.w, d.h, EVIDENCE_MAX_EDGE);
    if (!w || !h) throw new ImagePrepError("BAD_FILE");
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new ImagePrepError("BAD_FILE");
    ctx.drawImage(d.src, 0, 0, w, h);
    const blob = await toBlob(canvas);
    if (blob.size > 3 * 1024 * 1024) throw new ImagePrepError("TOO_LARGE");
    return { mime: EVIDENCE_MIME, data: await toBase64(blob), previewUrl: URL.createObjectURL(blob) };
  } finally {
    d.close();
  }
}
