import { Building } from "@/components/avatar/Building";
import { BUILDING_ACCENTS, BUILDING_STYLES, resolveBuilding, type BuildingConfig, type BuildingStyle } from "@shared/building";

const STYLE_LABELS: Record<BuildingStyle, string> = {
  club: "Club", bar: "Bar or lounge", stadium: "Stadium", stage: "Open-air stage", tent: "Festival tent", rooftop: "Rooftop",
};
const ACCENT_NAMES = ["Violet", "Rose", "Green", "Amber", "Blue", "Sky", "Orange", "Cream"];
const press = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background";

interface Props {
  kind: "venue" | "event";
  /** The venue or event category, used to pick the default building until the organizer chooses one. */
  category: string | null | undefined;
  /** Stored building, or null while the category default is in use. */
  value: BuildingConfig | null | undefined;
  onChange: (next: BuildingConfig | null) => void;
}

/** Lets an organizer choose how their venue or event looks on the map: a building style plus an accent colour. */
export default function BuildingPicker({ kind, category, value, onChange }: Props) {
  const shown = resolveBuilding(kind, category, value);
  const set = (patch: Partial<Pick<BuildingConfig, "style" | "accent">>) =>
    onChange({ v: 1, style: patch.style ?? shown.style, accent: patch.accent ?? shown.accent });

  return (
    <div className="space-y-3" data-testid="building-picker">
      <div>
        <p className="text-sm font-medium">Map marker</p>
        <p className="text-xs text-muted-foreground">How your {kind} looks on the map.{value ? "" : " Using the default for its category."}</p>
      </div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6" role="group" aria-label="Building style">
        {BUILDING_STYLES.map((style) => (
          <button key={style} type="button" aria-pressed={shown.style === style} onClick={() => set({ style })}
            className={`flex min-h-11 flex-col items-center gap-1 rounded-xl border bg-card p-1.5 pb-2 text-xs font-medium transition-colors active:scale-[.97] ${press} ${shown.style === style ? "border-primary ring-1 ring-primary" : "hover:border-primary/60"}`}>
            <Building config={{ v: 1, style, accent: shown.accent }} decorative className="w-full" />
            {STYLE_LABELS[style]}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2.5" role="group" aria-label="Accent colour">
        {BUILDING_ACCENTS.map((c, i) => (
          <button key={c} type="button" aria-label={ACCENT_NAMES[i]} title={ACCENT_NAMES[i]} aria-pressed={shown.accent === i} onClick={() => set({ accent: i })}
            style={{ background: c }}
            className={`h-11 w-11 rounded-full border border-black/30 transition-transform active:scale-95 ${press} ${shown.accent === i ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""}`} />
        ))}
        {value && (
          <button type="button" onClick={() => onChange(null)} className={`min-h-11 rounded-lg px-3 text-sm text-muted-foreground underline-offset-2 hover:underline ${press}`}>
            Use default
          </button>
        )}
      </div>
    </div>
  );
}
