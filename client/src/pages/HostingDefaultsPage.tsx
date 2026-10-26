import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { SLOW_MODES, type RoomDefaults } from "@shared/rooms";
import { slowModeLabel } from "@/lib/hostControls";
import { GROUP, SettingsShell, SwitchRow } from "@/components/settings/SettingsShell";

const KEY = ["/api/users/me/room-defaults"];
type Data = { roomDefaults: RoomDefaults };

// What every new room starts with. The create form can still change each one for a single room.
export default function HostingDefaultsPage() {
  const { toast } = useToast();
  const { data } = useQuery<Data>({ queryKey: KEY });
  const d = data?.roomDefaults;
  const save = useMutation({
    mutationFn: (next: RoomDefaults) => apiRequest("PUT", KEY[0], next),
    onMutate: (next) => queryClient.setQueryData<Data>(KEY, { roomDefaults: next }),
    onError: () => { toast({ title: "Couldn't save that", variant: "destructive" }); void queryClient.invalidateQueries({ queryKey: KEY }); },
  });
  const set = (patch: Partial<RoomDefaults>) => {
    if (!d) return;
    const next = { ...d, ...patch };
    if (!next.voice) next.liveVideo = false; // live video needs voice
    save.mutate(next);
  };

  return (
    <SettingsShell title="Hosting defaults">
      <p className="mb-4 text-sm text-muted-foreground">New rooms start with these. You can still change them for one room when you create it.</p>
      {!d ? <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p> : (
        <>
          <div className={GROUP}>
            <SwitchRow title="Voice" sub="People you bring on stage can talk" checked={d.voice} onChange={(voice) => set({ voice })} testId="switch-default-voice" />
            <SwitchRow title="Live video" sub={d.voice ? "One person at a time can go on camera" : "Needs voice on first"} checked={d.liveVideo} disabled={!d.voice} onChange={(liveVideo) => set({ liveVideo })} testId="switch-default-live" />
            <SwitchRow title="Spray" sub="Viewers can send cash to people on stage" checked={d.sprayEnabled} onChange={(sprayEnabled) => set({ sprayEnabled })} testId="switch-default-spray" />
          </div>
          <section aria-labelledby="slow-h" className="rounded-2xl border bg-card p-3.5">
            <h2 id="slow-h" className="text-base font-medium">Slow mode</h2>
            <p className="mb-3 text-[13px] text-muted-foreground">Time between one person's chat messages</p>
            <div role="radiogroup" aria-labelledby="slow-h" className="grid grid-cols-4 gap-1 rounded-full border bg-background p-1">
              {SLOW_MODES.map((n) => (
                <button
                  key={n} type="button" role="radio" aria-checked={d.slowModeSec === n} onClick={() => set({ slowModeSec: n })}
                  className={`min-h-[40px] rounded-full text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${d.slowModeSec === n ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                  data-testid={`slow-default-${n}`}
                >{slowModeLabel(n)}</button>
              ))}
            </div>
          </section>
        </>
      )}
    </SettingsShell>
  );
}
