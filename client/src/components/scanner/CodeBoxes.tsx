import { useRef, useState } from "react";

/**
 * Six boxes for a staff PIN. One real input underneath so the phone shows a numeric keypad, paste works,
 * and one-time-code autofill works; the boxes are the display.
 */
export default function CodeBoxes({ value, onChange, disabled, invalid }: { value: string; onChange: (v: string) => void; disabled?: boolean; invalid?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  return (
    <div className="relative" onClick={() => input.current?.focus()}>
      <div className="grid grid-cols-6 gap-2" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <div
            key={i}
            className={`grid h-[60px] place-items-center rounded-xl border bg-card font-mono text-[26px] transition-shadow ${
              invalid ? "border-destructive" : i === value.length && focused ? "border-primary ring-[3px] ring-primary/25" : ""
            }`}
          >
            {value[i] ?? ""}
          </div>
        ))}
      </div>
      <input
        ref={input}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={disabled}
        aria-label="6-digit code"
        aria-invalid={invalid}
        className="absolute inset-0 h-full w-full cursor-text opacity-0"
        data-testid="input-staff-code"
      />
    </div>
  );
}
