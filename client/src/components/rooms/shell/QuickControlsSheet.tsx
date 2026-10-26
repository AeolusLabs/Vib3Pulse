import { useEffect, useState } from "react";
import { Sheet, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import RoomSheetContent from "@/components/rooms/shell/RoomSheetContent";
import { SLOW_MODES } from "@shared/rooms";
import { slowModeLabel, type HostSettings, type SettingsPatch } from "@/lib/hostControls";

// The few controls a host reaches for mid-show, in a half-height sheet from the rail: one tap away. Everything else is in All controls.

export interface QuickControlsProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Lock and slow mode are the host's; a co-host sees the mic and the buttons only. */
  isHost: boolean;
  settings: HostSettings;
  /** PATCH the room. Null when saved, else the server's message. */
  onSave(patch: SettingsPatch): Promise<string | null>;
  /** Present while you can publish audio. */
  mic?: { on: boolean; onToggle(): void };
  coHosts: number;
  waiting: number;
  onAddCoHost(): void;
  onAll(): void;
  /** One plain line for a failed save. */
  onMessage(message: string): void;
}

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const ROW = "flex min-h-[52px] items-center justify-between gap-3 border-t first:border-t-0";

export default function QuickControlsSheet({ open, onOpenChange, isHost, settings, onSave, mic, coHosts, waiting, onAddCoHost, onAll, onMessage }: QuickControlsProps) {
  // Show a change at once; the server's room:settings (which changes `settings`) settles it, a refusal takes it back.
  const [pending, setPending] = useState<SettingsPatch>({});
  useEffect(() => setPending({}), [settings.locked, settings.slowModeSec]);
  const shown = { ...settings, ...pending };
  const save = async (patch: SettingsPatch) => {
    setPending((p) => ({ ...p, ...patch }));
    const err = await onSave(patch);
    if (err) { setPending({}); onMessage(err); }
  };
  const go = (fn: () => void) => () => { onOpenChange(false); fn(); };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <RoomSheetContent side="bottom" className="max-h-[62dvh] overflow-y-auto rounded-t-3xl pb-[calc(20px+env(safe-area-inset-bottom,0px))] sm:mx-auto sm:max-w-lg" data-testid="quick-controls">
        <SheetHeader className="pr-10 text-left"><SheetTitle className="font-sans text-lg font-semibold">Live controls</SheetTitle></SheetHeader>
        <div className="mt-1">
          {mic && (
            <label className={`${ROW} cursor-pointer`}>
              <span className="text-base font-medium">Microphone</span>
              <span className="flex items-center gap-3"><span className="text-[13px] text-muted-foreground">{mic.on ? "On" : "Muted"}</span><Switch checked={mic.on} onCheckedChange={() => mic.onToggle()} aria-label="Microphone" data-testid="quick-mic" /></span>
            </label>
          )}
          {isHost && (
            <>
              <label className={`${ROW} cursor-pointer`}>
                <span className="text-base font-medium">Lock room<span className="block text-[13px] font-normal text-muted-foreground">No one new can join</span></span>
                <Switch checked={shown.locked} onCheckedChange={(locked) => void save({ locked })} aria-label="Lock room" data-testid="quick-lock" />
              </label>
              <div className="border-t py-3" role="group" aria-label="Slow mode">
                <p className="mb-2 text-sm text-muted-foreground">Slow mode between messages</p>
                <div className="grid grid-cols-4 gap-1 rounded-full border bg-background p-1">
                  {SLOW_MODES.map((n) => (
                    <button key={n} type="button" aria-pressed={shown.slowModeSec === n} onClick={() => void save({ slowModeSec: n })}
                      className={`min-h-[40px] rounded-full text-sm font-medium transition-colors ${FOCUS} ${shown.slowModeSec === n ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`} data-testid={`quick-slow-${n}`}>{slowModeLabel(n)}</button>
                  ))}
                </div>
              </div>
              <div className={ROW}>
                <span className="text-base font-medium">Co-hosts<span className="block text-[13px] font-normal text-muted-foreground">{coHosts === 0 ? "None yet" : `${coHosts} helping`}</span></span>
                <Button variant="outline" className={`min-h-[44px] rounded-full px-5 ${FOCUS}`} onClick={go(onAddCoHost)} data-testid="quick-add-cohost">Add</Button>
              </div>
            </>
          )}
        </div>
        <Button className={`mt-3 min-h-[48px] w-full rounded-full font-semibold ${FOCUS}`} onClick={go(onAll)} data-testid="quick-all">
          All controls{waiting > 0 ? ` · ${waiting} waiting` : ""}
        </Button>
      </RoomSheetContent>
    </Sheet>
  );
}
