import { useState } from "react";
import { Link, useParams } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import SocialEventForm, { SOCIAL_TYPE_LABEL, toLocalInput, valuesToPayload, type SocialEventType, type SocialEventValues } from "@/components/social/SocialEventForm";
import { formatWhen, type SocialEventSummary } from "@/pages/SocialEventsPage";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { CopyIcon, MapPinIcon, PencilIcon, RefreshCwIcon, UsersIcon } from "@/components/ui/icons";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type HostEvent = SocialEventSummary & {
  description: string;
  address: string;
  eventEndDate: string | null;
  maxPlusOnes: number;
  dressCode: string | null;
  schedule: { name: string; time?: string }[];
  ageRestriction: "all" | "18+" | "21+";
  servesAlcohol: boolean;
  inviteUrl: string | null;
  publicUrl: string | null;
  visibility: "private" | "public";
  moderationStatus: string;
  reviewNote: string | null;
};

type Guest = { id: string; name: string; attending: boolean; plusOneCount: number; hasAccount: boolean; addressApproved: boolean; removed: boolean };

const toValues = (e: HostEvent): SocialEventValues => ({
  visibility: e.visibility,
  socialType: e.socialType as SocialEventType,
  title: e.title,
  description: e.description,
  eventDate: toLocalInput(e.eventDate),
  eventEndDate: toLocalInput(e.eventEndDate),
  location: e.location,
  exactAddress: e.address ?? "",
  capacity: e.capacity,
  maxPlusOnes: e.maxPlusOnes,
  dressCode: e.dressCode ?? "",
  schedule: (e.schedule ?? []).map((s) => ({ name: s.name, time: s.time ?? "" })),
  ageRestriction: e.ageRestriction,
  servesAlcohol: e.servesAlcohol,
});

// Module-level on purpose: defined inside the page it would remount (and wipe the edit form) on every render.
const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="min-h-screen bg-background pb-20 md:pb-0">
    <Navigation />
    <main className="mx-auto max-w-[760px] px-4 py-8 sm:px-6">{children}</main>
    <BottomNavigation />
  </div>
);

export default function SocialEventHostPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [showGuests, setShowGuests] = useState(false);
  const [appealing, setAppealing] = useState(false);
  const [appealText, setAppealText] = useState("");
  const key = [`/api/social-events/${id}`];

  const { data: ev, isLoading, isError } = useQuery<HostEvent>({ queryKey: key });
  const privacy = useQuery<{ retentionDays: number }>({ queryKey: ["/api/social-events/privacy-info"] });
  // Opening the guest list is an audited read, so it only loads when asked for.
  const guestsQuery = useQuery<{ guests: Guest[] }>({ queryKey: [`/api/social-events/${id}/guests`], enabled: showGuests, staleTime: 0, gcTime: 0 });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: key });
    queryClient.invalidateQueries({ queryKey: ["/api/social-events"] });
  };
  const onError = (title: string) => (err: Error) => toast({ title, description: err.message, variant: "destructive" });

  const save = useMutation({
    mutationFn: (v: SocialEventValues) => apiRequest("PATCH", `/api/social-events/${id}`, valuesToPayload(v, { includeType: false })),
    onSuccess: () => { refresh(); setEditing(false); toast({ title: "Saved" }); },
    onError: onError("Couldn't save changes"),
  });
  const cancel = useMutation({
    mutationFn: () => apiRequest("POST", `/api/social-events/${id}/cancel`),
    onSuccess: () => { refresh(); toast({ title: "Event cancelled", description: "Guests opening their link will see that it's off." }); },
    onError: onError("Couldn't cancel"),
  });
  const rotate = useMutation({
    mutationFn: () => apiRequest("POST", `/api/social-events/${id}/rotate-invite`),
    onSuccess: () => { refresh(); toast({ title: "New link created", description: "The old link no longer works. Your guests' answers are kept." }); },
    onError: onError("Couldn't replace the link"),
  });

  const guestAction = useMutation({
    mutationFn: ({ ticketId, action }: { ticketId: string; action: "approve" | "remove" }) => apiRequest("POST", `/api/social-events/${id}/guests/${ticketId}/${action}`),
    onSuccess: (_d, v) => {
      guestsQuery.refetch();
      refresh();
      toast({ title: v.action === "approve" ? "Approved. They can now see the address." : "Guest removed" });
    },
    onError: onError("Couldn't update that guest"),
  });
  const appeal = useMutation({
    mutationFn: () => apiRequest("POST", `/api/social-events/${id}/appeal`, { message: appealText }),
    onSuccess: () => { setAppealing(false); setAppealText(""); toast({ title: "Appeal sent", description: "We'll review it and get back to you." }); },
    onError: onError("Couldn't send your appeal"),
  });

  const shareUrl = ev?.visibility === "public" ? ev.publicUrl : ev?.inviteUrl;
  const copy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast({ title: "Link copied" });
    } catch {
      toast({ title: "Couldn't copy", description: "Select the link and copy it manually.", variant: "destructive" });
    }
  };

  if (isLoading) return <Shell><Skeleton className="mb-4 h-10 w-2/3" /><Skeleton className="h-40 rounded-2xl" /></Shell>;
  if (isError || !ev) {
    return (
      <Shell>
        <p className="rounded-2xl border px-6 py-14 text-center text-sm text-muted-foreground">We couldn't find that event. <Link href="/social-events"><a className="underline">Back to your invitations</a></Link></p>
      </Shell>
    );
  }

  if (editing) {
    return (
      <Shell>
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">Edit event</h1>
        <SocialEventForm initial={toValues(ev)} lockType submitLabel="Save changes" isSubmitting={save.isPending} onSubmit={(v) => save.mutate(v)} />
        <Button variant="ghost" className="mt-3 min-h-[44px] rounded-full" onClick={() => setEditing(false)}>Discard changes</Button>
      </Shell>
    );
  }

  const stat = (label: string, value: string | number) => (
    <div className="rounded-2xl border bg-card px-4 py-3">
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );

  return (
    <Shell>
      <Link href="/social-events"><a className="text-sm text-muted-foreground hover:underline">&larr; Your invitations</a></Link>
      <div className="mb-6 mt-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{SOCIAL_TYPE_LABEL[ev.socialType] ?? "Event"} · {ev.visibility === "public" ? "Public" : "Private"}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight" data-testid="heading-social-host">{ev.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{formatWhen(ev.eventDate)}</p>
          <p className="mt-0.5 inline-flex items-center gap-1 text-sm text-muted-foreground"><MapPinIcon className="h-3.5 w-3.5" />{ev.address}</p>
        </div>
        {!ev.isCancelled && (
          <Button variant="outline" className="min-h-[44px] shrink-0 rounded-full" onClick={() => setEditing(true)} data-testid="button-edit-social"><PencilIcon className="mr-2 h-4 w-4" />Edit</Button>
        )}
      </div>

      {ev.reviewNote && (
        <section className="mb-6 rounded-2xl border bg-card p-4" data-testid="review-banner">
          <p className="text-sm font-medium">{ev.reviewNote}</p>
          {["hidden", "rejected", "removed", "changes_requested"].includes(ev.moderationStatus) && ev.moderationStatus !== "changes_requested" && (
            appealing ? (
              <form className="mt-3 space-y-3" onSubmit={(e) => { e.preventDefault(); appeal.mutate(); }}>
                <Textarea rows={4} maxLength={1000} value={appealText} onChange={(e) => setAppealText(e.target.value)} placeholder="Tell us why this event is fine" aria-label="Appeal message" data-testid="input-appeal" />
                <div className="flex gap-2">
                  <Button type="submit" className="min-h-[44px] rounded-full" disabled={appeal.isPending || appealText.trim().length < 10} data-testid="button-send-appeal">Send appeal</Button>
                  <Button type="button" variant="ghost" className="min-h-[44px] rounded-full" onClick={() => setAppealing(false)}>Cancel</Button>
                </div>
              </form>
            ) : (
              <Button variant="outline" className="mt-3 min-h-[44px] rounded-full" onClick={() => setAppealing(true)} data-testid="button-appeal">Appeal this decision</Button>
            )
          )}
        </section>
      )}

      {ev.isCancelled && <p className="mb-6 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">This event is cancelled. Guests opening their link can see that.</p>}

      <div className="mb-6 grid grid-cols-3 gap-3">
        {stat("Coming", ev.yesCount)}
        {stat("Seats taken", `${ev.headcount}/${ev.capacity}`)}
        {stat("Can't make it", ev.declinedCount)}
      </div>

      {!ev.isCancelled && shareUrl && (
        <section className="mb-6 rounded-2xl border bg-card p-4">
          <h2 className="text-sm font-semibold">{ev.visibility === "public" ? "Public link" : "Invitation link"}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{ev.visibility === "public" ? "Guests log in to RSVP. You choose who gets the address." : "Anyone with this link can RSVP, no account needed. Share it only with people you want there."}</p>
          <div className="mt-3 flex gap-2">
            <input readOnly aria-label="Invitation link" value={shareUrl} onFocus={(e) => e.currentTarget.select()} className="min-h-[44px] min-w-0 flex-1 rounded-md border bg-background px-3 text-sm" data-testid="input-invite-url" />
            <Button className="min-h-[44px] rounded-full" onClick={copy} data-testid="button-copy-invite"><CopyIcon className="mr-2 h-4 w-4" />Copy</Button>
          </div>
          {ev.visibility === "private" && <Button variant="ghost" size="sm" className="mt-2 rounded-full text-muted-foreground" disabled={rotate.isPending}
            onClick={() => { if (window.confirm("Replace the link? The current one will stop working straight away.")) rotate.mutate(); }}>
            <RefreshCwIcon className="mr-2 h-3.5 w-3.5" />Replace link
          </Button>}
        </section>
      )}

      <section className="mb-6 rounded-2xl border bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Guest list</h2>
          {!showGuests ? (
            <Button variant="outline" className="min-h-[44px] rounded-full" onClick={() => setShowGuests(true)} data-testid="button-show-guests"><UsersIcon className="mr-2 h-4 w-4" />Show guests</Button>
          ) : (
            <Button variant="ghost" className="min-h-[44px] rounded-full" onClick={() => setShowGuests(false)}>Hide</Button>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground" data-testid="guest-privacy-note">Only you can see this. Each time you open it, we log that you did. Guests' names are deleted {privacy.data ? `${privacy.data.retentionDays} days` : "a set number of days"} after the event, or sooner if they delete them. It can't be downloaded or exported.</p>
        {showGuests && (
          <div className="mt-3">
            {guestsQuery.isLoading && <Skeleton className="h-16 rounded-xl" />}
            {guestsQuery.isError && <p className="text-sm text-muted-foreground">Couldn't load the guest list.</p>}
            {guestsQuery.data && guestsQuery.data.guests.length === 0 && <p className="text-sm text-muted-foreground">No answers yet. Share your link to get started.</p>}
            {guestsQuery.data && guestsQuery.data.guests.length > 0 && (
              <ul className="divide-y rounded-xl border" data-testid="list-guests">
                {guestsQuery.data.guests.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2.5 text-sm">
                    <span className="min-w-0 truncate font-medium">{g.name}{g.plusOneCount > 0 && <span className="font-normal text-muted-foreground"> +{g.plusOneCount}</span>}</span>
                    <span className="flex items-center gap-2">
                      <span className={g.attending ? "text-xs font-medium text-primary" : "text-xs text-muted-foreground"}>
                        {g.removed ? "Removed" : !g.attending ? "Can't make it" : ev.visibility === "public" && !g.addressApproved ? "Waiting for approval" : "Coming"}
                      </span>
                      {ev.visibility === "public" && g.attending && !g.removed && (
                        <>
                          {!g.addressApproved && <Button size="sm" className="min-h-[36px] rounded-full" disabled={guestAction.isPending} onClick={() => guestAction.mutate({ ticketId: g.id, action: "approve" })} data-testid={`button-approve-${g.id}`}>Approve</Button>}
                          <Button size="sm" variant="ghost" className="min-h-[36px] rounded-full text-muted-foreground" disabled={guestAction.isPending}
                            onClick={() => { if (window.confirm(`Remove ${g.name}? Their seats are freed and they can't RSVP again.`)) guestAction.mutate({ ticketId: g.id, action: "remove" }); }}>Remove</Button>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {!ev.isCancelled && (
        <Button variant="ghost" className="min-h-[44px] rounded-full text-destructive hover:text-destructive" disabled={cancel.isPending}
          onClick={() => { if (window.confirm("Cancel this event? Guests will see that it's off. This can't be undone.")) cancel.mutate(); }} data-testid="button-cancel-social">
          Cancel event
        </Button>
      )}
    </Shell>
  );
}
