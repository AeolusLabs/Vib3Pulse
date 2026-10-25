// Small building blocks shared by the wizard steps. Native radios and the shared Switch, so arrow keys, Space and screen
// readers behave as they do everywhere else; every row and chip is at least 44 px tall.
import type { ReactNode } from "react";
import { Switch } from "@/components/ui/switch";

const focusRing = "focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary";

/** A full-width radio row (age rules). A disabled row stays readable and says why, right under its label. */
export function ChoiceRow(props: {
  name: string; value: string; checked: boolean; label: string; sub?: string; disabledReason?: string; onPick(): void; testId?: string;
}) {
  const { name, value, checked, label, sub, disabledReason, onPick, testId } = props;
  const off = !!disabledReason;
  const whyId = `${name}-${value}-why`;
  return (
    <label
      className={`flex min-h-[44px] items-start gap-3 rounded-xl border p-3 transition-colors motion-reduce:transition-none ${focusRing} ${
        off ? "cursor-not-allowed border-border opacity-60" : checked ? "cursor-pointer border-primary bg-primary/10" : "cursor-pointer border-border hover:border-primary/40"
      }`}
      data-testid={testId}
    >
      <input
        type="radio" name={name} value={value} checked={checked} disabled={off}
        onChange={() => { if (!off) onPick(); }}
        aria-describedby={off ? whyId : undefined}
        className="mt-1 h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
      />
      <span className="min-w-0 flex-1 text-sm">
        <span className="block font-medium">{label}</span>
        {sub && <span className="block text-muted-foreground">{sub}</span>}
        {off && <span id={whyId} className="mt-1 block text-foreground">{disabledReason}</span>}
      </span>
    </label>
  );
}

/** A row of radio chips (kind, visibility, slow mode, when). Disabled chips list their reasons under the row. */
export function ChipGroup<V extends string | number>(props: {
  legend: string; name: string; value: V; options: Array<{ value: V; label: string; disabledReason?: string }>; onPick(v: V): void; help?: ReactNode; testId?: string;
}) {
  const { legend, name, value, options, onPick, help, testId } = props;
  const reasons = options.filter((o) => o.disabledReason);
  const reasonsId = `${name}-reasons`;
  return (
    <fieldset className="space-y-2" data-testid={testId}>
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const off = !!o.disabledReason;
          const on = o.value === value;
          return (
            <label
              key={String(o.value)}
              className={`inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full border px-4 text-sm font-medium transition-colors motion-reduce:transition-none ${focusRing} ${
                off ? "cursor-not-allowed border-border text-muted-foreground opacity-60" : on ? "cursor-pointer border-primary bg-primary text-primary-foreground" : "cursor-pointer border-border hover:border-primary/40"
              }`}
              data-testid={testId ? `${testId}-${o.value}` : undefined}
            >
              <input
                type="radio" name={name} value={String(o.value)} checked={on} disabled={off} className="sr-only"
                onChange={() => { if (!off) onPick(o.value); }}
                aria-describedby={off ? reasonsId : undefined}
              />
              {o.label}
            </label>
          );
        })}
      </div>
      {reasons.length > 0 && (
        <ul id={reasonsId} className="space-y-1 text-sm text-muted-foreground">
          {reasons.map((o) => <li key={String(o.value)}><span className="font-medium text-foreground">{o.label}:</span> {o.disabledReason}</li>)}
        </ul>
      )}
      {help && <div className="text-sm text-muted-foreground">{help}</div>}
    </fieldset>
  );
}

/** A labelled switch row. A disabled switch says why under its help line. */
export function SwitchRow(props: { id: string; label: string; help?: string; checked: boolean; onChange(v: boolean): void; disabledReason?: string; testId?: string; quietReason?: boolean }) {
  const { id, label, help, checked, onChange, disabledReason, testId, quietReason } = props;
  const off = !!disabledReason;
  return (
    <div className={`flex min-h-[44px] items-center justify-between gap-4 rounded-xl border border-border p-3 ${off ? "opacity-60" : ""}`}>
      <div className="min-w-0 text-sm">
        <label htmlFor={id} className="block font-medium">{label}</label>
        {help && <p id={`${id}-help`} className="text-muted-foreground">{help}</p>}
        {off && !quietReason && <p id={`${id}-why`} className="text-foreground">{disabledReason}</p>}
      </div>
      {/* The shared switch is small; the wrapper gives it a 44 px tap area. */}
      <span className="grid min-h-[44px] min-w-[44px] shrink-0 place-items-center">
        <Switch
          id={id} checked={checked} disabled={off} onCheckedChange={onChange}
          aria-describedby={[help ? `${id}-help` : "", off && !quietReason ? `${id}-why` : ""].filter(Boolean).join(" ") || undefined}
          data-testid={testId}
        />
      </span>
    </div>
  );
}

/** One line of the review card. */
export function ReviewLine({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium">{value}</dd>
    </div>
  );
}
