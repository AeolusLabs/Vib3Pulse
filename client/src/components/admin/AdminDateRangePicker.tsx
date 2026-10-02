import { useState } from "react";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

interface AdminDateRangePickerProps {
  from?: Date;
  to?: Date;
  onChange: (range: { from?: Date; to?: Date }) => void;
  className?: string;
}

const PRESETS: Array<{ label: string; days: number }> = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
];

export default function AdminDateRangePicker({ from, to, onChange, className }: AdminDateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const range: DateRange | undefined = from ? { from, to } : undefined;

  const applyPreset = (days: number) => {
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    onChange({ from: start, to: end });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn("justify-start text-left font-normal gap-2", !from && "text-muted-foreground", className)}
          data-testid="button-admin-date-range"
        >
          <CalendarIcon className="w-4 h-4" />
          {from ? (
            to ? `${format(from, "MMM d, yyyy")} – ${format(to, "MMM d, yyyy")}` : format(from, "MMM d, yyyy")
          ) : (
            "All time"
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="flex">
          <div className="flex flex-col gap-1 p-3 border-r">
            {PRESETS.map((p) => (
              <Button key={p.days} variant="ghost" size="sm" className="justify-start" onClick={() => applyPreset(p.days)} data-testid={`button-preset-${p.days}d`}>
                {p.label}
              </Button>
            ))}
            <Button variant="ghost" size="sm" className="justify-start" onClick={() => { onChange({ from: undefined, to: undefined }); setOpen(false); }} data-testid="button-preset-all-time">
              All time
            </Button>
          </div>
          <Calendar
            mode="range"
            selected={range}
            onSelect={(r) => onChange({ from: r?.from, to: r?.to })}
            numberOfMonths={2}
            defaultMonth={from}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
