import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { DEFAULT_ROOM_PRIVACY, type InteractionMode, type RoomPrivacy } from "@shared/rooms";
import { UsersIcon } from "@/components/ui/icons";

const MODES: { value: InteractionMode; label: string; help: string }[] = [
  { value: "mutuals", label: "People I follow who follow me back", help: "The default." },
  { value: "everyone", label: "Anyone in the room", help: "Waves, private reactions and messages from any guest your age group." },
  { value: "none", label: "Nobody", help: "You can still chat and react to the whole room." },
];

/** Who may wave at you / react to you / invite you from inside a room. Saves on every change; applies at once, even mid-room. */
export default function RoomPrivacyCard() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ roomPrivacy: RoomPrivacy }>({ queryKey: ["/api/users/me/room-privacy"] });
  const [value, setValue] = useState<RoomPrivacy>(DEFAULT_ROOM_PRIVACY);
  useEffect(() => { if (data) setValue(data.roomPrivacy); }, [data]);

  const save = useMutation({
    mutationFn: async (next: RoomPrivacy) => (await apiRequest("PUT", "/api/users/me/room-privacy", { interactions: next.interactions, appearInLists: next.appearInLists, allowInvites: next.allowInvites, allowCrossAgeDm: next.allowCrossAgeDm, notifyFriendsLive: next.notifyFriendsLive })).json(),
    onSuccess: (session) => {
      queryClient.setQueryData(["/api/users/me/room-privacy"], (old: object | undefined) => ({ ...old, roomPrivacy: session.roomPrivacy })); // keep `age`, which the create dialog reads
      queryClient.setQueryData(["/api/auth/session"], session); // the PUT answers with the refreshed session user
      toast({ title: "Room privacy saved" });
    },
    onError: (e: any) => { if (data) setValue(data.roomPrivacy); toast({ title: "Couldn't save", description: e?.message, variant: "destructive" }); },
  });
  const change = (patch: Partial<RoomPrivacy>) => { const next = { ...value, ...patch }; setValue(next); save.mutate(next); };

  return (
    <Card data-testid="card-room-privacy">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><UsersIcon className="h-5 w-5" />Rooms and messages</CardTitle>
        <CardDescription>Control who can reach you from inside a virtual room, and whether adults and under-18s can message each other. Waves, reactions and invites never cross age groups.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading ? <Skeleton className="h-24 w-full" /> : (
          <>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Who can wave at you, react to you or message you from a room</legend>
              <RadioGroup value={value.interactions} onValueChange={(v) => change({ interactions: v as InteractionMode })} className="space-y-2">
                {MODES.map((m) => (
                  <label key={m.value} className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-lg border p-3">
                    <RadioGroupItem value={m.value} className="mt-0.5" data-testid={`radio-interactions-${m.value}`} />
                    <span className="text-sm"><span className="font-medium">{m.label}</span><span className="block text-muted-foreground">{m.help}</span></span>
                  </label>
                ))}
              </RadioGroup>
            </fieldset>
            <div className="flex items-start justify-between gap-4">
              <div><Label htmlFor="rp-lists">Show my rooms in Rooms lists</Label><p className="text-xs text-muted-foreground">Off: only your followers see your rooms.</p></div>
              <Switch id="rp-lists" checked={value.appearInLists} onCheckedChange={(v) => change({ appearInLists: v })} data-testid="switch-appear-in-lists" />
            </div>
            <div className="space-y-2 rounded-lg border p-3" data-testid="section-cross-age-dm">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Label htmlFor="rp-xage" className="font-medium">Allow messages between adults and under-18s</Label>
                  <p className="text-xs text-muted-foreground">Off by default. While it's off, nobody in the other age group can start a conversation with you, and you can't start one with them. For a chat to be possible, both people must turn this on, and you'll always see a warning first.</p>
                </div>
                <Switch id="rp-xage" checked={value.allowCrossAgeDm} onCheckedChange={(v) => change({ allowCrossAgeDm: v })} data-testid="switch-cross-age-dm" />
              </div>
            </div>
            <div className="flex items-start justify-between gap-4">
              <div><Label htmlFor="rp-invites">Let people invite me to their rooms</Label><p className="text-xs text-muted-foreground">Only from people you could already interact with.</p></div>
              <Switch id="rp-invites" checked={value.allowInvites} onCheckedChange={(v) => change({ allowInvites: v })} data-testid="switch-allow-invites" />
            </div>
            <div className="flex items-start justify-between gap-4">
              <div><Label htmlFor="rp-live">Tell my followers when I go live</Label><p className="text-xs text-muted-foreground">Off: nobody gets a notification when you start a room. People you invite are still told.</p></div>
              <Switch id="rp-live" checked={value.notifyFriendsLive} onCheckedChange={(v) => change({ notifyFriendsLive: v })} data-testid="switch-notify-friends-live" />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
