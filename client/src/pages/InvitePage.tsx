import { useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarIcon, CheckCircleIcon, ClockIcon, Loader2Icon, MapPinIcon } from "@/components/ui/icons";
import { ensureCsrfToken } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import { SOCIAL_TYPE_LABEL, type SocialEventType } from "@/components/social/SocialEventForm";
import ReportDialog from "@/components/ReportDialog";

type Invite = {
  id?: string; // present for public events only
  visibility: "private" | "public";
  requiresLogin: boolean;
  title: string;
  description: string;
  socialType: SocialEventType;
  eventDate: string;
  eventEndDate: string | null;
  area: string;
  dressCode: string | null;
  schedule: { name: string; time?: string }[];
  ageRestriction: "all" | "18+" | "21+";
  servesAlcohol: boolean;
  maxPlusOnes: number;
  privacy?: { controller: string; retentionDays: number; contactEmail: string | null };
  hostName: string;
  cancelled: boolean;
  closed: boolean;
  full: boolean;
};

type Rsvp = { responded: false } | { responded: true; name: string | null; attending: boolean; plusOneCount: number; address: string | null; addressPending: boolean; removed: boolean };

const storageKey = (token: string) => `vp_rsvp_${token}`;
const readStored = (token: string): string | null => { try { return localStorage.getItem(storageKey(token)); } catch { return null; } };
const writeStored = (token: string, v: string) => { try { localStorage.setItem(storageKey(token), v); } catch { /* private mode: they just can't edit later on this device */ } };

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });

// Module-level on purpose: defined inside InvitePage it would remount (dropping input focus) on every keystroke.
const Page = ({ children }: { children: React.ReactNode }) => (
  <div className="min-h-screen bg-background px-4 py-10">
    <div className="mx-auto max-w-[520px]">{children}</div>
  </div>
);

// What we collect, who sees it, how long it lives, how to delete it. Kept short and literal: it is
// shown before anyone is asked for anything.
function PrivacyNotice({ hostName, p }: { hostName: string; p: NonNullable<Invite["privacy"]> }) {
  return (
    <details className="mt-3 rounded-xl border bg-muted/30 px-4 py-3 text-xs text-muted-foreground" data-testid="privacy-notice">
      <summary className="cursor-pointer font-medium text-foreground">Your privacy</summary>
      <div className="mt-2 space-y-2 leading-relaxed">
        <p><strong className="text-foreground">{p.controller}</strong> is responsible for the information you give here.</p>
        <p>We collect only your <strong className="text-foreground">name</strong>, whether you're <strong className="text-foreground">coming</strong>, and <strong className="text-foreground">how many people</strong> you're bringing. Nothing else: no contact details, dietary or health information.</p>
        <p>Only {hostName} can see it, not other guests. They can look at it but not download it, and every look is logged.</p>
        <p>It's deleted <strong className="text-foreground">{p.retentionDays} days after the event</strong>, or right away if you delete it yourself.{p.contactEmail && <> Questions: <a className="underline" href={`mailto:${p.contactEmail}`}>{p.contactEmail}</a>.</>}</p>
      </div>
    </details>
  );
}

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const qc = useQueryClient();
  const { data: user, isLoading: authLoading } = useAuth();
  const [reporting, setReporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState("");
  const [attending, setAttending] = useState<boolean | null>(null);
  const [plus, setPlus] = useState(0);
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);


  const invite = useQuery<Invite>({
    queryKey: ["invite", token],
    retry: false,
    queryFn: async () => {
      const res = await fetch(`/api/invite/${token}`, { credentials: "include" });
      if (!res.ok) throw new Error(res.status === 404 ? "invalid" : "failed");
      return res.json();
    },
  });

  const rsvp = useQuery<Rsvp>({
    queryKey: ["invite-rsvp", token, user?.id ?? "guest"],
    enabled: invite.isSuccess,
    queryFn: async () => {
      const stored = readStored(token);
      const res = await fetch(`/api/invite/${token}/rsvp`, { credentials: "include", headers: stored ? { "x-rsvp-token": stored } : {} });
      if (!res.ok) return { responded: false };
      return res.json();
    },
  });

  const visibility = invite.data?.visibility;
  // Private invitation links stay out of search engines; public event pages are meant to be found.
  useEffect(() => {
    if (visibility === "public") return;
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.appendChild(meta);
    return () => { document.head.removeChild(meta); };
  }, [visibility]);

  useEffect(() => {
    if (rsvp.data?.responded) {
      setName(rsvp.data.name ?? "");
      setAttending(rsvp.data.attending);
      setPlus(rsvp.data.plusOneCount);
    } else if (user && !name) {
      setName(user.displayName || user.username || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rsvp.data, user]);

  // Opt out: deletes my name, my answer and my plus-one count for this event, server-side.
  const deleteMyData = async () => {
    setDeleting(true);
    setError(null);
    try {
      const csrf = await ensureCsrfToken();
      const stored = readStored(token);
      const res = await fetch(`/api/invite/${token}/rsvp`, { method: "DELETE", credentials: "include", headers: { "x-csrf-token": csrf, ...(stored ? { "x-rsvp-token": stored } : {}) } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.message || "We couldn't delete your response. Please try again."); return; }
      try { localStorage.removeItem(storageKey(token)); } catch { /* nothing to clear */ }
      qc.setQueryData(["invite-rsvp", token, user?.id ?? "guest"], { responded: false });
      setConfirmDelete(false); setEditing(false); setAttending(null); setPlus(0); setName(user?.displayName || user?.username || "");
      setDeleted(true);
      invite.refetch();
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setDeleting(false);
    }
  };

  const submit = async () => {
    if (attending === null || !name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const csrf = await ensureCsrfToken();
      const stored = readStored(token);
      const res = await fetch(`/api/invite/${token}/rsvp`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrf, ...(stored ? { "x-rsvp-token": stored } : {}) },
        body: JSON.stringify({ name: name.trim(), attending, plusOneCount: attending ? plus : 0 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.code === "FULL" ? "Sorry, the last spot just went. You can still tell the host you can't make it." : data.message || "Something went wrong. Please try again.");
        if (data.code === "FULL") invite.refetch();
        return;
      }
      if (data.manageToken) writeStored(token, data.manageToken);
      qc.setQueryData(["invite-rsvp", token, user?.id ?? "guest"], { ...data, manageToken: undefined });
      setEditing(false);
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (invite.isLoading) return <Page><Skeleton className="mb-4 h-8 w-3/4" /><Skeleton className="h-64 rounded-2xl" /></Page>;
  if (invite.isError || !invite.data) {
    return (
      <Page>
        <div className="rounded-2xl border px-6 py-14 text-center" data-testid="invite-invalid">
          <p className="font-medium">This invitation link isn't valid</p>
          <p className="mx-auto mt-1 max-w-xs text-sm text-muted-foreground">It may have been replaced or removed. Ask your host for a fresh link.</p>
        </div>
      </Page>
    );
  }

  const ev = invite.data;
  const mine = rsvp.data?.responded ? rsvp.data : null; // narrowed: this guest's saved answer, if any
  const answered = mine !== null;
  const locked = ev.cancelled || ev.closed;
  const showForm = !locked && (!answered || editing);

  return (
    <Page>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{SOCIAL_TYPE_LABEL[ev.socialType] ?? "Event"} · You're invited</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight" data-testid="invite-title">{ev.title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">Hosted by {ev.hostName}</p>

      {ev.cancelled && <p className="mt-5 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm" data-testid="invite-cancelled">This event has been cancelled.</p>}
      {!ev.cancelled && ev.closed && <p className="mt-5 rounded-2xl border bg-muted/40 px-4 py-3 text-sm">This event has already happened.</p>}

      <dl className="mt-6 space-y-3 text-sm">
        <div className="flex gap-3"><CalendarIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /><div><dt className="sr-only">When</dt><dd>{when(ev.eventDate)}</dd></div></div>
        <div className="flex gap-3"><MapPinIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /><div><dt className="sr-only">Where</dt><dd>{ev.area}</dd>
          {!mine?.address && <dd className="text-xs text-muted-foreground">The full address appears once you say yes.</dd>}</div></div>
        {ev.dressCode && <div className="flex gap-3"><svg className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z" /></svg><div><dt className="sr-only">Dress code</dt><dd>{ev.dressCode}</dd></div></div>}
        {(ev.ageRestriction !== "all" || ev.servesAlcohol) && (
          <div className="flex gap-3"><ClockIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /><div><dt className="sr-only">Notes</dt>
            <dd>{[ev.ageRestriction !== "all" ? `${ev.ageRestriction} only` : null, ev.servesAlcohol ? "Alcohol served" : null].filter(Boolean).join(" · ")}</dd></div></div>
        )}
      </dl>

      <p className="mt-6 whitespace-pre-wrap text-[15px] leading-relaxed">{ev.description}</p>

      {ev.schedule.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-semibold">Schedule</h2>
          <ol className="divide-y overflow-hidden rounded-2xl border bg-card text-sm">
            {ev.schedule.map((s, i) => (
              <li key={i} className="flex gap-4 px-4 py-2.5"><span className="w-20 shrink-0 text-muted-foreground tabular-nums">{s.time || "—"}</span><span>{s.name}</span></li>
            ))}
          </ol>
        </section>
      )}

      <section className="mt-8 rounded-2xl border bg-card p-5" aria-live="polite">
        {deleted && !answered && (
          <p className="mb-4 flex items-center gap-2 rounded-xl bg-muted/50 px-4 py-3 text-sm" role="status" data-testid="deleted-notice"><CheckCircleIcon className="h-4 w-4 text-primary" />Your response and name have been deleted. You can still answer again if you change your mind.</p>
        )}
        {rsvp.isLoading && <Skeleton className="h-24 rounded-xl" />}

        {!rsvp.isLoading && mine && !editing && (
          <div data-testid="rsvp-confirmed">
            <p className="flex items-center gap-2 font-medium">
              <CheckCircleIcon className="h-5 w-5 text-primary" />
              {mine.removed ? "The host has removed your RSVP" : mine.attending ? (mine.addressPending ? "Request sent" : `You're going${mine.plusOneCount > 0 ? ` (+${mine.plusOneCount})` : ""}`) : "You've told the host you can't make it"}
            </p>
            {mine.attending && mine.addressPending && !ev.cancelled && (
              <p className="mt-3 rounded-xl bg-muted/50 px-4 py-3 text-sm" data-testid="address-pending">Your spot is held. The host approves guests one by one, and the exact address will appear here once they approve you.</p>
            )}
            {mine.attending && mine.address && !ev.cancelled && (
              <p className="mt-3 rounded-xl bg-muted/50 px-4 py-3 text-sm"><span className="block text-xs text-muted-foreground">Address</span><span data-testid="invite-address">{mine.address}</span></p>
            )}
            {!locked && !mine.removed && <Button variant="outline" className="mt-4 min-h-[44px] rounded-full" onClick={() => setEditing(true)} data-testid="button-change-rsvp">Change my answer</Button>}
            {!confirmDelete ? (
              <button type="button" className="mt-3 block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setConfirmDelete(true)} data-testid="button-delete-my-data">Delete my response and data</button>
            ) : (
              <div className="mt-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alertdialog" aria-label="Confirm deletion" data-testid="delete-confirm">
                <p>This deletes your name and answer for this event and frees your spot. It can't be undone.</p>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="destructive" className="rounded-full" disabled={deleting} onClick={deleteMyData} data-testid="button-confirm-delete">{deleting ? "Deleting…" : "Yes, delete it"}</Button>
                  <Button size="sm" variant="ghost" className="rounded-full" onClick={() => setConfirmDelete(false)}>Keep it</Button>
                </div>
              </div>
            )}
            {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
          </div>
        )}

        {!rsvp.isLoading && !authLoading && showForm && ev.requiresLogin && !user && (
          <div data-testid="login-required">
            <h2 className="font-semibold">Log in to RSVP</h2>
            <p className="mt-1 text-sm text-muted-foreground">This is a public event, so hosts see who's asking. You'll need an account{ev.ageRestriction !== "all" ? ` and a date of birth on your profile (${ev.ageRestriction})` : ""}.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href={`/login?redirect=${encodeURIComponent(`/i/${token}`)}`}><Button className="min-h-[48px] rounded-full" data-testid="button-login-to-rsvp">Log in</Button></Link>
              <Link href={`/signup?redirect=${encodeURIComponent(`/i/${token}`)}`}><Button variant="outline" className="min-h-[48px] rounded-full">Create an account</Button></Link>
            </div>
          </div>
        )}

        {!rsvp.isLoading && showForm && !(ev.requiresLogin && !user) && (
          <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <h2 className="font-semibold">Will you come?</h2>
            {ev.privacy ? <PrivacyNotice hostName={ev.hostName} p={ev.privacy} /> : <p className="text-xs text-muted-foreground">Only the host sees your name and answer.</p>}
            <div className="space-y-2">
              <Label htmlFor="rsvp-name">Your name</Label>
              <Input id="rsvp-name" className="min-h-[44px]" maxLength={80} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="So the host knows who you are" data-testid="input-rsvp-name" />
            </div>
            <div className="grid grid-cols-2 gap-3" role="group" aria-label="Your answer">
              <Button type="button" variant={attending === true ? "default" : "outline"} className="min-h-[48px] rounded-full" disabled={ev.full && !mine?.attending} aria-pressed={attending === true} onClick={() => setAttending(true)} data-testid="button-rsvp-yes">
                {ev.full && !mine?.attending ? "Event is full" : "Yes, I'll be there"}
              </Button>
              <Button type="button" variant={attending === false ? "default" : "outline"} className="min-h-[48px] rounded-full" aria-pressed={attending === false} onClick={() => setAttending(false)} data-testid="button-rsvp-no">Can't make it</Button>
            </div>
            {attending && ev.maxPlusOnes > 0 && (
              <div className="flex items-center justify-between gap-3 rounded-xl border px-4 py-3">
                <div><p className="text-sm font-medium">Bringing anyone?</p><p className="text-xs text-muted-foreground">Up to {ev.maxPlusOnes}. Just the number, no names needed.</p></div>
                <div className="flex items-center gap-1">
                  <Button type="button" variant="outline" size="icon" className="min-h-[44px] min-w-[44px] rounded-full" aria-label="One fewer" disabled={plus <= 0} onClick={() => setPlus((p) => Math.max(0, p - 1))}>−</Button>
                  <span className="w-8 text-center tabular-nums" data-testid="text-plus-count" aria-live="polite">{plus}</span>
                  <Button type="button" variant="outline" size="icon" className="min-h-[44px] min-w-[44px] rounded-full" aria-label="One more" disabled={plus >= ev.maxPlusOnes} onClick={() => setPlus((p) => Math.min(ev.maxPlusOnes, p + 1))}>+</Button>
                </div>
              </div>
            )}
            {error && <p role="alert" className="text-sm text-destructive" data-testid="rsvp-error">{error}</p>}
            <div className="flex items-center gap-3">
              <Button type="submit" className="min-h-[48px] flex-1 rounded-full" disabled={submitting || attending === null || !name.trim()} data-testid="button-rsvp-submit">
                {submitting && <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />}Send answer
              </Button>
              {editing && <Button type="button" variant="ghost" className="min-h-[48px] rounded-full" onClick={() => setEditing(false)}>Cancel</Button>}
            </div>
          </form>
        )}

        {!rsvp.isLoading && locked && !answered && <p className="text-sm text-muted-foreground">Answers are closed for this event.</p>}
      </section>
      {ev.visibility === "public" && ev.id && user && (
        <>
          <button type="button" className="mt-6 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setReporting(true)} data-testid="button-report-event">Report this event</button>
          <ReportDialog open={reporting} onClose={() => setReporting(false)} endpoint={`/api/events/${ev.id}/report`} itemLabel="event" />
        </>
      )}
    </Page>
  );
}
