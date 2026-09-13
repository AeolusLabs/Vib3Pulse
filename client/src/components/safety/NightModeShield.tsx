import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Link } from "wouter";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ShieldIcon } from "@/components/ui/icons";
import { useNightMode } from "@/hooks/useNightMode";

function truncateName(name: string, max = 15): string {
  return name.length > max ? `${name.slice(0, max)}…` : name;
}

export function NightModeShield() {
  const [open, setOpen] = useState(false);
  const night = useNightMode();

  if (!night.shieldVisible) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Night mode active"
          data-testid="button-night-mode-shield"
        >
          <span className="relative inline-flex">
            <ShieldIcon className="h-5 w-5 text-primary" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[min(320px,calc(100vw-16px))] p-4"
        align="end"
        sideOffset={8}
        data-testid="popover-night-mode"
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <ShieldIcon className="h-5 w-5 text-primary shrink-0" />
            <div>
              <p className="text-sm font-semibold">Night mode is active</p>
              {night.primaryBuddyName ? (
                <p className="text-xs text-muted-foreground">
                  {truncateName(night.primaryBuddyName)} is watching over you tonight
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  <Link href="/buddy/settings" className="underline">Add a safety buddy</Link> to get alerts
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between pt-1 border-t">
            <span className="text-xs text-muted-foreground">Keep on during the day</span>
            <Switch
              checked={night.manualOverride}
              onCheckedChange={night.setManualOverride}
              data-testid="switch-night-mode-override"
            />
          </div>

          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={() => { night.dismissForTonight(); setOpen(false); }}
            data-testid="button-dismiss-night-mode"
          >
            Dismiss for tonight
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
