import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ageBand, AGE_LIMITS, minAgeForLimit, type AgeLimit } from "@shared/age";
import { resolveScreen } from "@shared/screen";
import { ROOM_KINDS, ROOM_LIMITS, ROOM_VISIBILITY, validateRoomInput, type RoomKind, type RoomVisibility } from "@shared/rooms";
import { KIND_LABEL, LINK_SCREENS, PROVIDER_LABEL, VISIBILITY_LABEL, ageLimitLabel } from "@/lib/roomsApi";
import { CopyIcon, Loader2Icon } from "@/components/ui/icons";
import TeenHostNote from "@/components/rooms/TeenHostNote";
import { showTeenHostNote } from "@/lib/minorsRoomUi";

const TEEN_NOTE_KEY = "rooms.teenHostNote.seen";
const noteSeen = () => { try { return localStorage.getItem(TEEN_NOTE_KEY) === "1"; } catch { return false; } };

const VISIBILITY_HELP: Record<RoomVisibility, string> = {
  public: "Anyone old enough can find it in Rooms.",
  friends: "Only people you follow and who follow you back.",
  invite: "Only people with your invite link.",
};

interface Props { open: boolean; onOpenChange: (open: boolean) => void; defaultEventId?: string; defaultVenueId?: string }

export default function CreateRoomDialog({ open, onOpenChange, defaultEventId, defaultVenueId }: Props) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { data: me } = useQuery<{ age: number | null }>({ queryKey: ["/api/users/me/room-privacy"], enabled: open });
  const { data: myEvents = [] } = useQuery<{ id: string; title: string }[]>({ queryKey: ["/api/events/my-events"], enabled: open });
  const { data: myVenues = [] } = useQuery<{ id: string; name: string }[]>({ queryKey: ["/api/my-venues"], enabled: open });

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<RoomKind>("party");
  const [visibility, setVisibility] = useState<RoomVisibility>("public");
  const [ageLimit, setAgeLimit] = useState<AgeLimit>("all");
  const [when, setWhen] = useState<"now" | "later">("now");
  const [scheduledFor, setScheduledFor] = useState("");
  const [link, setLink] = useState<string>(defaultEventId ? `event:${defaultEventId}` : defaultVenueId ? `venue:${defaultVenueId}` : "none");
  const [screenUrl, setScreenUrl] = useState("");
  const [directInteractions, setDirectInteractions] = useState(true);
  const [capacity, setCapacity] = useState(String(ROOM_LIMITS.capacityDefault));
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ link: string; roomId: string } | null>(null);

  const age = me?.age ?? null;
  // Told once, calmly. Remembered in this browser only; the server decides who can join regardless.
  const [noteGone, setNoteGone] = useState(noteSeen);
  const showNote = showTeenHostNote(age) && !noteGone;
  const dismissNote = () => { setNoteGone(true); try { localStorage.setItem(TEEN_NOTE_KEY, "1"); } catch { /* the note just shows again next time */ } };
  const isTeen = ageBand(age) === "teen";
  const ageKnown = age !== null;
  // A host can't set a door policy above their own age, and teens don't host public rooms.
  const limitDisabled = (l: AgeLimit) => !ageKnown || age! < minAgeForLimit(l);
  const publicDisabled = !ageKnown || isTeen;
  // A teen's first submit must not fail on the option they can't pick. Only once we know the age: while it is still loading
  // everyone looks "unknown", and switching an adult to Friends at that moment would stick.
  useEffect(() => { if (me && publicDisabled && visibility === "public") setVisibility("friends"); }, [me, publicDisabled, visibility]);

  const screenPreview = useMemo(() => {
    if (!screenUrl.trim()) return null;
    const r = resolveScreen(screenUrl);
    return r.ok ? { ok: true as const, text: r.screen.embedUrl ? `Plays in the room: ${PROVIDER_LABEL[r.screen.provider]}` : r.screen.provider === "image" ? "Shows as an image" : "Shows as a link card" } : { ok: false as const, text: "That link can't be used on the screen." };
  }, [screenUrl]);

  const reset = () => { setTitle(""); setDescription(""); setScreenUrl(""); setError(null); setInvite(null); setWhen("now"); setScheduledFor(""); };

  const create = useMutation({
    mutationFn: async () => {
      const [linkType, linkId] = link === "none" ? [null, null] : link.split(":");
      const input = {
        title, description: description || undefined, kind, visibility, ageLimit,
        eventId: linkType === "event" ? linkId : undefined, venueId: linkType === "venue" ? linkId : undefined,
        scheduledFor: when === "later" && scheduledFor ? new Date(scheduledFor).toISOString() : undefined,
        noDirectInteractions: !directInteractions, screenUrl: LINK_SCREENS ? screenUrl.trim() || undefined : undefined, capacity: Number(capacity),
      };
      const v = validateRoomInput(input);
      if (!v.ok) throw new Error(({ title: "Give the room a title.", capacity: `Capacity must be between 2 and ${ROOM_LIMITS.capacityMax}.`, scheduledFor: "Pick a time in the future, within 90 days.", screenUrl: "That screen link can't be used." } as Record<string, string>)[v.field] ?? `Check the ${v.field} field.`);
      const res = await apiRequest("POST", "/api/rooms", input);
      const created = await res.json();
      if (when === "now") {
        try { await apiRequest("POST", `/api/rooms/${created.room.id}/start`); }
        catch (e: any) { toast({ title: "Room created, but it didn't go live", description: e?.message, variant: "destructive" }); }
      }
      return created as { room: { id: string }; inviteLink?: string };
    },
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["/api/rooms"] });
      if (created.inviteLink) { setInvite({ link: `${window.location.origin}${created.inviteLink}`, roomId: created.room.id }); return; }
      reset(); onOpenChange(false); navigate(`/rooms/${created.room.id}`);
    },
    onError: (e: any) => setError(e?.message || "Couldn't create the room."),
  });

  const copyInvite = async () => {
    if (!invite) return;
    try { await navigator.clipboard.writeText(invite.link); toast({ title: "Invite link copied" }); }
    catch { toast({ title: "Copy it from the box below", variant: "destructive" }); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg" data-testid="dialog-create-room">
        {invite ? (
          <>
            <DialogHeader>
              <DialogTitle>Your room is ready</DialogTitle>
              <DialogDescription>Only people with this link can find it. It's shown once, so copy it now.</DialogDescription>
            </DialogHeader>
            <Input readOnly value={invite.link} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" data-testid="input-invite-link" />
            <div className="flex gap-2">
              <Button variant="outline" onClick={copyInvite} data-testid="button-copy-invite"><CopyIcon className="mr-2 h-4 w-4" />Copy link</Button>
              <Button onClick={() => { const id = invite.roomId; reset(); onOpenChange(false); navigate(`/rooms/${id}`); }} data-testid="button-open-room">Open room</Button>
            </div>
          </>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); setError(null); create.mutate(); }} className="space-y-5">
            <DialogHeader>
              <DialogTitle>Create a room</DialogTitle>
              <DialogDescription>A space for a night, a listening session or a chat. Guests join as their avatar.</DialogDescription>
            </DialogHeader>

            {showNote && <TeenHostNote onDismiss={dismissNote} />}

            {!ageKnown && me && (
              <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="text-room-needs-dob">
                Add your date of birth in your profile before you host a room.
              </p>
            )}

            <div className="space-y-2">
              <Label htmlFor="room-title">Title</Label>
              <Input id="room-title" value={title} maxLength={ROOM_LIMITS.title} onChange={(e) => setTitle(e.target.value)} placeholder="Friday pre-party" required data-testid="input-room-title" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="room-desc">About (optional)</Label>
              <Textarea id="room-desc" value={description} maxLength={ROOM_LIMITS.description} onChange={(e) => setDescription(e.target.value)} rows={2} data-testid="input-room-description" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="room-kind">Kind</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as RoomKind)}>
                <SelectTrigger id="room-kind" data-testid="select-room-kind"><SelectValue /></SelectTrigger>
                <SelectContent>{ROOM_KINDS.map((k) => <SelectItem key={k} value={k}>{KIND_LABEL[k]}</SelectItem>)}</SelectContent>
              </Select>
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Who can find it</legend>
              <RadioGroup value={visibility} onValueChange={(v) => setVisibility(v as RoomVisibility)} className="space-y-2">
                {ROOM_VISIBILITY.map((v) => {
                  const off = v === "public" && publicDisabled;
                  return (
                    <label key={v} className={`flex min-h-[44px] items-start gap-3 rounded-lg border p-3 ${off ? "opacity-60" : "cursor-pointer"}`}>
                      <RadioGroupItem value={v} disabled={off} className="mt-0.5" data-testid={`radio-visibility-${v}`} />
                      <span className="text-sm">
                        <span className="font-medium">{VISIBILITY_LABEL[v]}</span>
                        <span className="block text-muted-foreground">{off ? (isTeen ? "Public rooms are for adults. Friends and invite rooms are open to you." : "Add your date of birth first.") : VISIBILITY_HELP[v]}</span>
                      </span>
                    </label>
                  );
                })}
              </RadioGroup>
            </fieldset>

            <div className="space-y-2">
              <Label htmlFor="room-age">Door policy</Label>
              <Select value={ageLimit} onValueChange={(v) => setAgeLimit(v as AgeLimit)}>
                <SelectTrigger id="room-age" data-testid="select-age-limit"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {AGE_LIMITS.map((l) => <SelectItem key={l} value={l} disabled={limitDisabled(l)}>{ageLimitLabel(l)}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Works like a bouncer: people below the limit can see the room but can't get in. You can't set a limit above your own age.</p>
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">When</legend>
              <RadioGroup value={when} onValueChange={(v) => setWhen(v as "now" | "later")} className="flex gap-4">
                <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm"><RadioGroupItem value="now" data-testid="radio-when-now" />Go live now</label>
                <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm"><RadioGroupItem value="later" data-testid="radio-when-later" />Schedule</label>
              </RadioGroup>
              {when === "later" && (
                <Input type="datetime-local" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} aria-label="Start time" required data-testid="input-room-schedule" />
              )}
            </fieldset>

            {(myEvents.length > 0 || myVenues.length > 0) && (
              <div className="space-y-2">
                <Label htmlFor="room-link">Attach to your event or venue (optional)</Label>
                <Select value={link} onValueChange={setLink}>
                  <SelectTrigger id="room-link" data-testid="select-room-link"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not attached</SelectItem>
                    {myEvents.map((e) => <SelectItem key={e.id} value={`event:${e.id}`}>Event: {e.title}</SelectItem>)}
                    {myVenues.map((v) => <SelectItem key={v.id} value={`venue:${v.id}`}>Venue: {v.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}

            {LINK_SCREENS && <div className="space-y-2">
              <Label htmlFor="room-screen">Screen link (optional)</Label>
              <Input id="room-screen" value={screenUrl} onChange={(e) => setScreenUrl(e.target.value)} placeholder="Paste a YouTube, Vimeo, Spotify, Apple Music or SoundCloud link" inputMode="url" data-testid="input-room-screen" />
              {screenPreview && <p className={`text-xs ${screenPreview.ok ? "text-muted-foreground" : "text-destructive"}`} role="status" data-testid="text-screen-preview">{screenPreview.text}</p>}
              <p className="text-xs text-muted-foreground">Everyone plays it from the provider with their own account. Nothing is recorded or relayed.</p>
            </div>}

            <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
              <div>
                <Label htmlFor="room-direct">Waves and private reactions</Label>
                <p className="text-xs text-muted-foreground">Guests can still chat and react to the whole room.</p>
              </div>
              <Switch id="room-direct" checked={directInteractions} onCheckedChange={setDirectInteractions} data-testid="switch-room-direct" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="room-capacity">Capacity</Label>
              <Input id="room-capacity" type="number" inputMode="numeric" min={2} max={ROOM_LIMITS.capacityMax} value={capacity} onChange={(e) => setCapacity(e.target.value)} className="w-28" data-testid="input-room-capacity" />
            </div>

            {error && <p role="alert" className="text-sm text-destructive" data-testid="text-create-room-error">{error}</p>}

            <Button type="submit" className="min-h-[44px] w-full" disabled={create.isPending || !ageKnown} data-testid="button-create-room">
              {create.isPending ? <Loader2Icon className="mr-2 h-4 w-4 animate-spin" /> : null}
              {when === "now" ? "Create and go live" : "Schedule room"}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
