import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ROOM_KINDS, ROOM_LIMITS, type RoomKind } from "@shared/rooms";
import { KIND_LABEL } from "@/lib/roomsApi";
import type { WizardState } from "@/lib/createRoomRules";
import { COPY } from "@/lib/createRoomWizardUi";
import { ChipGroup } from "./parts";

export interface FieldError { field: string; reason: string }

/** Inline error for one field, tied to its input by id. */
export function FieldErr({ id, error, field }: { id: string; error: FieldError | null; field: string | string[] }) {
  const fields = Array.isArray(field) ? field : [field];
  if (!error || !fields.includes(error.field)) return null;
  return <p id={id} role="alert" className="text-sm text-destructive">{error.reason}</p>;
}

interface Props {
  state: WizardState;
  set(patch: Partial<WizardState>): void;
  error: FieldError | null;
  linkChoice: string;
  setLinkChoice(v: string): void;
  myEvents: { id: string; title: string }[];
  myVenues: { id: string; name: string }[];
}

export default function StepBasics({ state, set, error, linkChoice, setLinkChoice, myEvents, myVenues }: Props) {
  const titleErr = error?.field === "title";
  const capErr = error?.field === "capacity";
  // A room opened from an event or venue page keeps that link even before (or without) the owner's lists loading.
  const presetMissing = linkChoice !== "none"
    && !myEvents.some((e) => `event:${e.id}` === linkChoice) && !myVenues.some((v) => `venue:${v.id}` === linkChoice);
  const showLink = myEvents.length > 0 || myVenues.length > 0 || linkChoice !== "none";
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="wiz-title">{COPY.titleLabel}</Label>
        <Input
          id="wiz-title" value={state.title} maxLength={ROOM_LIMITS.title} onChange={(e) => set({ title: e.target.value })}
          placeholder={COPY.titlePlaceholder} required autoComplete="off" enterKeyHint="next"
          aria-invalid={titleErr || undefined} aria-describedby={titleErr ? "wiz-title-err" : undefined}
          className="h-11 text-[16px]" data-testid="input-room-title"
        />
        <FieldErr id="wiz-title-err" error={error} field="title" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="wiz-desc">{COPY.descLabel}</Label>
        <Textarea
          id="wiz-desc" value={state.description} maxLength={ROOM_LIMITS.description} rows={2}
          onChange={(e) => set({ description: e.target.value })} className="text-[16px]" data-testid="input-room-description"
        />
        <FieldErr id="wiz-desc-err" error={error} field="description" />
      </div>

      <ChipGroup<RoomKind>
        legend={COPY.kindLabel} name="wiz-kind" value={state.kind} testId="chips-room-kind"
        options={ROOM_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
        onPick={(k) => set({ kind: k })}
      />

      <div className="space-y-2">
        <Label htmlFor="wiz-capacity">{COPY.capacityLabel}</Label>
        <Input
          id="wiz-capacity" type="number" inputMode="numeric" min={2} max={ROOM_LIMITS.capacityMax}
          value={Number.isFinite(state.capacity) ? String(state.capacity) : ""}
          onChange={(e) => set({ capacity: e.target.value === "" ? Number.NaN : Number(e.target.value) })}
          aria-invalid={capErr || undefined} aria-describedby={capErr ? "wiz-capacity-err wiz-capacity-help" : "wiz-capacity-help"}
          className="h-11 w-32 text-[16px]" data-testid="input-room-capacity"
        />
        <p id="wiz-capacity-help" className="text-sm text-muted-foreground">{COPY.capacityHelp}</p>
        <FieldErr id="wiz-capacity-err" error={error} field="capacity" />
      </div>

      {showLink && (
        <div className="space-y-2">
          <Label htmlFor="wiz-link">{COPY.linkLabel}</Label>
          <Select value={linkChoice} onValueChange={setLinkChoice}>
            <SelectTrigger id="wiz-link" className="min-h-[44px] text-[16px]" data-testid="select-room-link"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{COPY.linkNone}</SelectItem>
              {presetMissing && (
                <SelectItem value={linkChoice}>{linkChoice.startsWith("event:") ? COPY.linkedEvent : COPY.linkedVenue}</SelectItem>
              )}
              {myEvents.map((e) => <SelectItem key={e.id} value={`event:${e.id}`}>Event: {e.title}</SelectItem>)}
              {myVenues.map((v) => <SelectItem key={v.id} value={`venue:${v.id}`}>Venue: {v.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <FieldErr id="wiz-link-err" error={error} field={["eventId", "venueId"]} />
        </div>
      )}
    </div>
  );
}
