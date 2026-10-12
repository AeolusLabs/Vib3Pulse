import { useMemo } from "react";
import { avatarSvg, type AvatarMode } from "@shared/avatar-render/render";

interface AvatarProps {
  /** Any stored value: it is sanitized, and garbage renders nothing so callers can fall back. */
  config: unknown;
  mode?: AvatarMode;
  className?: string;
  /** Hide from assistive tech (e.g. a picker tile that sits next to its own text label). */
  decorative?: boolean;
}

/** Full-figure, bust, head or face crop of an avatar config. Renders null when the config is unusable. */
export function Avatar({ config, mode = "full", className, decorative }: AvatarProps) {
  // Memoized on the config's content so element ids stay stable across re-renders.
  const key = JSON.stringify(config ?? null);
  const html = useMemo(() => avatarSvg(config, mode, { decorative }), [key, mode, decorative]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!html) return null;
  // Safe: avatarSvg only emits values from fixed enums, clamped indexes and palette colours (see render.ts).
  return <div className={`avatar-art${className ? ` ${className}` : ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
