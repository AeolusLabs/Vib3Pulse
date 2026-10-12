import { useMemo } from "react";
import { buildingSvg, type BuildingOptions } from "@shared/avatar-render/building";

interface BuildingProps extends BuildingOptions {
  /** A stored building config; junk renders nothing so callers can fall back. */
  config: unknown;
  className?: string;
}

/** A venue or event building as svg art. */
export function Building({ config, glow, decorative, className }: BuildingProps) {
  const key = JSON.stringify(config ?? null);
  const html = useMemo(() => buildingSvg(config, { glow, decorative }), [key, glow, decorative]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!html) return null;
  // Safe: buildingSvg only emits fixed enums, palette colours and numbers (see shared/avatar-render/building.ts).
  return <div className={`avatar-art${className ? ` ${className}` : ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
