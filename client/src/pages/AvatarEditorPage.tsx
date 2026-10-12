import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/avatar/Avatar";
import type { AvatarMode } from "@shared/avatar-render/render";
import { HAIR_COLORS, OUTFIT_COLORS, SKINS } from "@shared/avatar-render/palette";
import * as L from "@/components/avatar/labels";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  AVATAR_TYPES, EXPRESSIONS, EYEWEAR, FACIAL, HAIR_BY_TYPE, HEADWEAR, OUTFITS,
  defaultAvatar, isAvatarImageUrl, sanitizeAvatarConfig, switchAvatarType, type AvatarConfig,
} from "@shared/avatar";

type Tab = "body" | "hair" | "face" | "outfit" | "extras";
const TABS: Array<[Tab, string]> = [["body", "Body"], ["hair", "Hair"], ["face", "Face"], ["outfit", "Outfit"], ["extras", "Extras"]];

const press = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background";

function Swatches({ colors, names, value, onPick, label }: { colors: readonly string[]; names: string[]; value: number; onPick: (i: number) => void; label: string }) {
  return (
    <div className="flex flex-wrap gap-2.5" role="group" aria-label={label}>
      {colors.map((c, i) => (
        <button key={c} type="button" aria-label={names[i]} title={names[i]} aria-pressed={value === i} onClick={() => onPick(i)}
          style={{ background: c }}
          className={`h-11 w-11 rounded-full border border-black/30 transition-transform active:scale-95 ${press} ${value === i ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""}`} />
      ))}
    </div>
  );
}

function Segmented<T extends string>({ options, value, labels, onPick, label }: { options: readonly T[]; value: T; labels: Record<string, string>; onPick: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="grid gap-1 rounded-xl border bg-muted/40 p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0,1fr))` }}>
      {options.map((o) => (
        <button key={o} type="button" aria-pressed={value === o} onClick={() => onPick(o)}
          className={`min-h-11 rounded-lg px-2 text-sm font-medium transition-colors active:scale-[.97] ${press} ${value === o ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
          {labels[o]}
        </button>
      ))}
    </div>
  );
}

function Tiles({ items, value, onPick, render, mode }: { items: Array<[string, string]>; value: string; onPick: (v: string) => void; render: (v: string) => AvatarConfig; mode: AvatarMode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2.5">
      {items.map(([v, label]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onPick(v)}
          className={`flex flex-col items-center gap-1 rounded-2xl border bg-card p-1.5 pb-2 text-xs font-medium transition-colors active:scale-[.97] ${press} ${value === v ? "border-primary ring-1 ring-primary" : "hover:border-primary/60"}`}>
          <Avatar config={render(v)} mode={mode} decorative className="w-full rounded-lg bg-muted/50" />
          {label}
        </button>
      ))}
    </div>
  );
}

const Group = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="space-y-2.5"><h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>{children}</div>
);

export default function AvatarEditorPage() {
  const { data: user } = useAuth();
  const { toast } = useToast();
  const saved = useMemo(() => sanitizeAvatarConfig(user?.avatar) ?? defaultAvatar(), [user?.avatar]);
  const [draft, setDraft] = useState<AvatarConfig | null>(null);
  const [picDraft, setPicDraft] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>("body");
  const config = draft ?? saved;
  // Is the avatar currently the profile picture (users.avatarUrl points at the rendered avatar)? Defaults on at first save.
  const savedPicture = user?.avatar ? isAvatarImageUrl(user.avatarUrl) : true;
  const picture = picDraft ?? savedPicture;
  // A user with no stored avatar can save the default straight away.
  const dirty = JSON.stringify(config) !== JSON.stringify(saved) || !user?.avatar || picture !== savedPicture;
  const set = (patch: Partial<AvatarConfig>) => setDraft(sanitizeAvatarConfig({ ...config, ...patch }));

  const save = useMutation({
    mutationFn: async () => (await apiRequest("PUT", "/api/users/me/avatar", { avatar: config, usePicture: picture })).json(),
    onSuccess: (data) => {
      // setQueryData, not invalidateQueries: invalidating refetches while the session cookie is being replaced.
      // The response is session-shaped (includes hasPassword etc.), so it is safe to cache as the session user.
      queryClient.setQueryData(["/api/auth/session"], data);
      queryClient.invalidateQueries({ queryKey: [`/api/users/${user!.username}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/users/${user!.id}/profile`] });
      setDraft(null);
      setPicDraft(null);
      toast({ title: "Avatar saved", description: "Your friends will see it on the map." });
    },
    onError: (e: any) => toast({ title: "Could not save avatar", description: e?.message || "Please try again.", variant: "destructive" }),
  });

  const hairItems = HAIR_BY_TYPE[config.type].map((h) => [h, L.HAIR_LABELS[h]] as [string, string]);
  const labelled = (ids: readonly string[], map: Record<string, string>) => ids.map((v) => [v, map[v]] as [string, string]);

  return (
    <div className="min-h-screen bg-background pb-24">
      <Navigation />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <h1 className="mb-4 font-serif text-3xl font-bold">Your avatar</h1>
        <div className="grid overflow-hidden rounded-3xl border bg-card md:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
          <div className="flex min-h-[380px] items-end justify-center border-b bg-muted/30 pt-6 md:border-b-0 md:border-r">
            <Avatar config={config} mode="full" className="w-[min(300px,86%)]" />
          </div>
          <div className="min-w-0 space-y-6 p-5">
            <div role="tablist" aria-label="Avatar sections" className="flex overflow-x-auto border-b">
              {TABS.map(([k, label]) => (
                <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)}
                  className={`-mb-px min-h-11 shrink-0 border-b-2 px-4 text-sm font-medium ${press} ${tab === k ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{label}</button>
              ))}
            </div>

            {tab === "body" && <>
              <Group title="Body type">
                <Segmented options={AVATAR_TYPES} value={config.type} labels={L.TYPE_LABELS} label="Body type" onPick={(t) => setDraft(switchAvatarType(config, t))} />
              </Group>
              <Group title={`Complexion · ${L.SKIN_NAMES[config.skin]}`}>
                <Swatches colors={SKINS} names={L.SKIN_NAMES} value={config.skin} onPick={(i) => set({ skin: i })} label="Complexion" />
              </Group>
            </>}

            {tab === "hair" && <>
              <Group title={`Style · ${L.TYPE_LABELS[config.type]}`}>
                <Tiles items={hairItems} value={config.hair} onPick={(v) => set({ hair: v })} render={(v) => ({ ...config, hair: v })} mode="head" />
              </Group>
              <Group title="Colour"><Swatches colors={HAIR_COLORS} names={L.HAIR_COLOR_NAMES} value={config.hairColor} onPick={(i) => set({ hairColor: i })} label="Hair colour" /></Group>
            </>}

            {tab === "face" && <>
              <Group title="Expression">
                <Tiles items={labelled(EXPRESSIONS, L.EXPRESSION_LABELS)} value={config.expression} onPick={(v) => set({ expression: v as AvatarConfig["expression"] })} render={(v) => ({ ...config, expression: v as AvatarConfig["expression"] })} mode="face" />
              </Group>
              <Group title="Facial hair">
                {config.type === "female"
                  ? <p className="text-sm text-muted-foreground">Available on Male and Neutral avatars.</p>
                  : <Tiles items={labelled(FACIAL, L.FACIAL_LABELS)} value={config.facial} onPick={(v) => set({ facial: v as AvatarConfig["facial"] })} render={(v) => ({ ...config, facial: v as AvatarConfig["facial"] })} mode="lower" />}
              </Group>
            </>}

            {tab === "outfit" && <>
              <Group title="Style"><Tiles items={labelled(OUTFITS, L.OUTFIT_LABELS)} value={config.outfit} onPick={(v) => set({ outfit: v as AvatarConfig["outfit"] })} render={(v) => ({ ...config, outfit: v as AvatarConfig["outfit"] })} mode="outfit" /></Group>
              <Group title="Colour"><Swatches colors={OUTFIT_COLORS} names={L.OUTFIT_COLOR_NAMES} value={config.outfitColor} onPick={(i) => set({ outfitColor: i })} label="Outfit colour" /></Group>
            </>}

            {tab === "extras" && <>
              <Group title="Eyewear"><Segmented options={EYEWEAR} value={config.eyewear} labels={L.EYEWEAR_LABELS} label="Eyewear" onPick={(v) => set({ eyewear: v })} /></Group>
              <Group title="Headwear"><Segmented options={HEADWEAR} value={config.headwear} labels={L.HEADWEAR_LABELS} label="Headwear" onPick={(v) => set({ headwear: v })} /></Group>
              <Group title="Jewellery">
                <button type="button" aria-pressed={config.hoops} onClick={() => set({ hoops: !config.hoops })}
                  className={`flex min-h-12 w-full items-center justify-between rounded-xl border bg-muted/40 px-4 text-sm font-medium ${press}`}>
                  Gold hoops<span className={`rounded-full px-2 py-0.5 text-xs ${config.hoops ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>{config.hoops ? "On" : "Off"}</span>
                </button>
              </Group>
            </>}

            <button type="button" role="switch" aria-checked={picture} onClick={() => setPicDraft(!picture)}
              className={`flex min-h-12 w-full items-center justify-between gap-3 rounded-xl border bg-muted/40 px-4 py-2 text-left ${press}`}>
              <span>
                <span className="block text-sm font-medium">Use as my profile picture</span>
                <span className="block text-xs text-muted-foreground">Shown in the feed, comments, chat and on the map. Your photo is kept.</span>
              </span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${picture ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>{picture ? "On" : "Off"}</span>
            </button>

            <div className="flex gap-3 border-t pt-4">
              <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending || !user}>{save.isPending ? "Saving…" : "Save avatar"}</Button>
              <Button variant="outline" onClick={() => { setDraft(null); setPicDraft(null); }} disabled={(!draft && picDraft === null) || save.isPending}>Reset</Button>
            </div>
          </div>
        </div>
      </main>
      <BottomNavigation />
    </div>
  );
}
