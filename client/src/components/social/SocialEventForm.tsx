import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2Icon, PlusIcon, XIcon } from "@/components/ui/icons";

export type SocialEventType = "birthday" | "party" | "wedding" | "other";

export type SocialEventValues = {
  visibility: "private" | "public";
  socialType: SocialEventType;
  title: string;
  description: string;
  eventDate: string; // datetime-local
  eventEndDate: string; // datetime-local or ""
  location: string;
  exactAddress: string;
  capacity: number;
  maxPlusOnes: number;
  dressCode: string;
  schedule: { name: string; time: string }[];
  ageRestriction: "all" | "18+" | "21+";
  servesAlcohol: boolean;
};

export const EMPTY_SOCIAL_EVENT: SocialEventValues = {
  visibility: "private",
  socialType: "party",
  title: "",
  description: "",
  eventDate: "",
  eventEndDate: "",
  location: "",
  exactAddress: "",
  capacity: 30,
  maxPlusOnes: 1,
  dressCode: "",
  schedule: [],
  ageRestriction: "all",
  servesAlcohol: false,
};

export const SOCIAL_TYPE_LABEL: Record<SocialEventType, string> = {
  birthday: "Birthday",
  party: "Party",
  wedding: "Wedding",
  other: "Something else",
};

// <input type="datetime-local"> speaks local time without a zone; the API wants ISO.
export const toLocalInput = (iso?: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function valuesToPayload(v: SocialEventValues, opts: { includeType: boolean }) {
  return {
    ...(opts.includeType ? { socialType: v.socialType, visibility: v.visibility } : {}),
    title: v.title,
    description: v.description,
    eventDate: new Date(v.eventDate).toISOString(),
    eventEndDate: v.eventEndDate ? new Date(v.eventEndDate).toISOString() : null,
    location: v.location,
    exactAddress: v.exactAddress,
    capacity: Number(v.capacity),
    maxPlusOnes: Number(v.maxPlusOnes),
    dressCode: v.dressCode || null,
    schedule: v.schedule.filter((s) => s.name.trim()).map((s) => ({ name: s.name, ...(s.time.trim() ? { time: s.time } : {}) })),
    ageRestriction: v.ageRestriction,
    servesAlcohol: v.servesAlcohol,
  };
}

type Props = {
  initial: SocialEventValues;
  submitLabel: string;
  isSubmitting: boolean;
  lockType?: boolean;
  onSubmit: (v: SocialEventValues) => void;
};

export default function SocialEventForm({ initial, submitLabel, isSubmitting, lockType, onSubmit }: Props) {
  const [v, setV] = useState<SocialEventValues>(initial);
  const set = <K extends keyof SocialEventValues>(k: K, val: SocialEventValues[K]) => setV((p) => ({ ...p, [k]: val }));

  const alcoholNeedsAge = v.servesAlcohol && v.ageRestriction === "all";
  const valid = v.title.trim() && v.description.trim() && v.eventDate && v.location.trim() && v.exactAddress.trim() && v.capacity >= 1 && !alcoholNeedsAge;

  return (
    <form
      className="space-y-8"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit(v);
      }}
    >
      {!lockType && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold">Who can find it?</h2>
          <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Who can find it">
            {([
              ["private", "Invite only", "Only people with your link. Never listed or searchable. Guests don't need an account."],
              ["public", "Public", "Listed in discovery after a quick check. Needs a verified phone number. Guests log in and you approve who gets the address."],
            ] as const).map(([val, title, hint]) => (
              <button key={val} type="button" role="radio" aria-checked={v.visibility === val} onClick={() => set("visibility", val)}
                className={`rounded-2xl border p-4 text-left transition-colors ${v.visibility === val ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`} data-testid={`radio-visibility-${val}`}>
                <span className="block font-medium">{title}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="se-type">What are you hosting?</Label>
          <Select value={v.socialType} onValueChange={(t) => set("socialType", t as SocialEventType)} disabled={lockType}>
            <SelectTrigger id="se-type" className="min-h-[44px]" data-testid="select-social-type"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(SOCIAL_TYPE_LABEL) as SocialEventType[]).map((t) => (
                <SelectItem key={t} value={t}>{SOCIAL_TYPE_LABEL[t]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="se-title">Name</Label>
          <Input id="se-title" className="min-h-[44px]" maxLength={120} value={v.title} onChange={(e) => set("title", e.target.value)} placeholder="Ada's 30th" data-testid="input-social-title" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="se-desc">Message to your guests</Label>
          <Textarea id="se-desc" rows={4} maxLength={2000} value={v.description} onChange={(e) => set("description", e.target.value)} placeholder="What should people know?" data-testid="input-social-description" />
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-base font-semibold">When and where</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="se-start">Starts</Label>
            <Input id="se-start" type="datetime-local" className="min-h-[44px]" value={v.eventDate} onChange={(e) => set("eventDate", e.target.value)} data-testid="input-social-start" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="se-end">Ends <span className="text-muted-foreground">(optional)</span></Label>
            <Input id="se-end" type="datetime-local" className="min-h-[44px]" value={v.eventEndDate} onChange={(e) => set("eventEndDate", e.target.value)} />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="se-area">Area</Label>
          <Input id="se-area" className="min-h-[44px]" maxLength={120} value={v.location} onChange={(e) => set("location", e.target.value)} placeholder="Shoreditch, London" data-testid="input-social-area" />
          <p className="text-xs text-muted-foreground">The general area, shown on the invitation.</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="se-address">Exact address</Label>
          <Input id="se-address" className="min-h-[44px]" maxLength={300} value={v.exactAddress} onChange={(e) => set("exactAddress", e.target.value)} placeholder="Street, number, postcode" data-testid="input-social-address" />
          <p className="text-xs text-muted-foreground">Only guests who say yes can see this.</p>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-base font-semibold">Guests</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="se-cap">Total capacity</Label>
            <Input id="se-cap" type="number" inputMode="numeric" min={1} max={1000} className="min-h-[44px]" value={v.capacity} onChange={(e) => set("capacity", Number(e.target.value))} data-testid="input-social-capacity" />
            <p className="text-xs text-muted-foreground">Counts guests and their plus-ones.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="se-plus">Plus-ones per guest</Label>
            <Select value={String(v.maxPlusOnes)} onValueChange={(n) => set("maxPlusOnes", Number(n))}>
              <SelectTrigger id="se-plus" className="min-h-[44px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[0, 1, 2, 3, 4, 5].map((n) => (
                  <SelectItem key={n} value={String(n)}>{n === 0 ? "None" : `Up to ${n}`}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="se-age">Age</Label>
            <Select value={v.ageRestriction} onValueChange={(a) => set("ageRestriction", a as SocialEventValues["ageRestriction"])}>
              <SelectTrigger id="se-age" className="min-h-[44px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All ages</SelectItem>
                <SelectItem value="18+">18+</SelectItem>
                <SelectItem value="21+">21+</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-xl border px-4 py-3">
            <Label htmlFor="se-alcohol" className="cursor-pointer">Alcohol will be served</Label>
            <Switch id="se-alcohol" checked={v.servesAlcohol} onCheckedChange={(c) => { setV((p) => ({ ...p, servesAlcohol: c, ageRestriction: c && p.ageRestriction === "all" ? "18+" : p.ageRestriction })); }} />
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-base font-semibold">Details <span className="text-sm font-normal text-muted-foreground">(optional)</span></h2>
        <div className="space-y-2">
          <Label htmlFor="se-dress">Dress code</Label>
          <Input id="se-dress" className="min-h-[44px]" maxLength={120} value={v.dressCode} onChange={(e) => set("dressCode", e.target.value)} placeholder="Smart casual" />
        </div>
        <div className="space-y-2">
          <Label className="block">Schedule</Label>
          {v.schedule.map((s, i) => (
            <div key={i} className="flex gap-2">
              <Input aria-label={`Schedule item ${i + 1} time`} className="min-h-[44px] w-28 shrink-0" maxLength={40} placeholder="7pm" value={s.time} onChange={(e) => set("schedule", v.schedule.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)))} />
              <Input aria-label={`Schedule item ${i + 1}`} className="min-h-[44px]" maxLength={80} placeholder="Doors open" value={s.name} onChange={(e) => set("schedule", v.schedule.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <Button type="button" variant="ghost" size="icon" className="min-h-[44px] min-w-[44px] shrink-0" aria-label="Remove schedule item" onClick={() => set("schedule", v.schedule.filter((_, j) => j !== i))}>
                <XIcon className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {v.schedule.length < 30 && (
            <Button type="button" variant="outline" className="min-h-[44px] rounded-full" onClick={() => set("schedule", [...v.schedule, { name: "", time: "" }])}>
              <PlusIcon className="mr-2 h-4 w-4" />Add a schedule item
            </Button>
          )}
        </div>
      </section>

      {alcoholNeedsAge && <p role="alert" className="text-sm text-destructive">Events serving alcohol must be 18+ or 21+.</p>}

      <Button type="submit" className="min-h-[48px] w-full rounded-full sm:w-auto sm:px-10" disabled={!valid || isSubmitting} data-testid="button-submit-social-event">
        {isSubmitting && <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />}
        {submitLabel}
      </Button>
    </form>
  );
}
