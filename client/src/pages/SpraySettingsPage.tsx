import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ChevronRightIcon } from "@/components/ui/icons";
import { GROUP, SettingsShell, SwitchRow } from "@/components/settings/SettingsShell";
import { useSprayQuiet } from "@/components/rooms/spray/SprayEffects";
import SpendingLimits from "@/components/rooms/spray/SpendingLimits";
import { SPRAY_ME_KEY } from "@/components/rooms/spray/SprayFlow";
import { getSprayMe } from "@/lib/sprayApi";
import { parseSprayMe, type SprayMe } from "@/lib/sprayUi";

// The two spray settings that follow you between rooms: how loud the effects are, and what you can spend.
export default function SpraySettingsPage() {
  const [quiet, setQuiet] = useSprayQuiet();
  const [limitsOpen, setLimitsOpen] = useState(false);
  const { data: me } = useQuery<SprayMe>({
    queryKey: SPRAY_ME_KEY,
    queryFn: async () => {
      const r = await getSprayMe();
      const parsed = r.ok ? parseSprayMe(r.body) : null;
      if (!parsed) throw new Error("Couldn't load your card");
      return parsed;
    },
    retry: 1,
  });

  return (
    <SettingsShell title="Spray limits and effects">
      <div className={GROUP}>
        <SwitchRow title="Quiet effects" sub="Show a short note instead of the cash animation and sounds. Saved on this device." checked={quiet} onChange={setQuiet} testId="switch-spray-quiet" />
        <button
          type="button" onClick={() => setLimitsOpen(true)} disabled={!me}
          className="flex min-h-[60px] w-full items-center gap-3.5 px-3.5 py-2 text-left disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary" data-testid="button-spray-limits"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-base font-medium leading-5">Daily limit and saved card</span>
            <span className="block text-[13px] leading-[18px] text-muted-foreground">{me ? "Change what you can spend in a day, or remove your card" : "Loading…"}</span>
          </span>
          <ChevronRightIcon className="h-[18px] w-[18px] shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </div>
      <Sheet open={limitsOpen} onOpenChange={setLimitsOpen}>
        <SheetContent side="bottom" className="max-h-[90vh] overflow-y-auto rounded-t-2xl">
          <SpendingLimits me={me ?? null} onChanged={() => void queryClient.invalidateQueries({ queryKey: SPRAY_ME_KEY })} onClose={() => setLimitsOpen(false)} />
        </SheetContent>
      </Sheet>
    </SettingsShell>
  );
}
