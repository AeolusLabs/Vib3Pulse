// The create-a-room wizard: Basics, Audience, Features, (Price, paid rooms only), When, Review, then Done. Options come from the shared wizard rules
// (createRoomRules, task 3.2), so it never offers what the server would refuse; the server still checks everything.
// Full screen on phones (footer pinned above the keyboard and the home bar), a centred panel from the sm breakpoint.
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Loader2Icon, XIcon } from "@/components/ui/icons";
import { useToast } from "@/hooks/use-toast";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { queryClient } from "@/lib/queryClient";
import { LINK_SCREENS } from "@/lib/roomsApi";
import { showTeenHostNote } from "@/lib/minorsRoomUi";
import { accountTooNewFor, normalizeWizard, stepsFor, validateWizard, wizardOptions, type WizardState } from "@/lib/createRoomRules";
import {
  COPY, DONE_COPY, HOST_REFUSAL, KNOWN_STEPS, LAST_VISIBILITY_KEY, TEEN_NOTE_KEY, createErrorMessage, defaultWizardState, doneKind,
  fieldForFailure, fieldSelectors, linkChoiceOf, localProblem, parseLinkChoice, progressPrefix, roomShareUrl, ruleMessage, stepForFailure,
  stepOfField, uiStepTitle, uiSteps, type DoneKind, type RoomLink, type UiStep,
} from "@/lib/createRoomWizardUi";
import {
  PRICE_COPY, TICKET_FIELDS, defaultTicketDraft, formatNaira, isTicketFailure, priceKoboOf, priceStepAvailable, ticketCreateMessage,
  ticketDraftProblem, ticketFieldSelectors, ticketsTooManyForVideo, type TicketDraft,
} from "@/lib/roomTickets";
import { createRoom, useWizardHost } from "./createRoomApi";
import StepBasics, { type FieldError } from "./StepBasics";
import StepAudience from "./StepAudience";
import StepFeatures from "./StepFeatures";
import StepWhen from "./StepWhen";
import StepPrice from "./StepPrice";
import StepReview from "./StepReview";
import StepDone from "./StepDone";

export interface CreateRoomWizardProps {
  open: boolean;
  onOpenChange(o: boolean): void;
  defaults?: Partial<WizardState>;
  /** Opened from an event or venue page: the room is attached to it (the owner can still change or clear it). */
  link?: RoomLink;
  /** The button that started it all (Start a room). Focus goes back there when the wizard closes. */
  returnFocusTo?: () => HTMLElement | null;
}

const noteSeen = () => { try { return localStorage.getItem(TEEN_NOTE_KEY) === "1"; } catch { return false; } };

interface Done { roomId: string; url: string; kind: DoneKind; inviteOnce: boolean; note: string | null }

export default function CreateRoomWizard({ open, onOpenChange, defaults, link, returnFocusTo }: CreateRoomWizardProps) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [accountTooNew, setAccountTooNew] = useState(false);
  const { host, flags, minAccountAgeDays, failed: hostFailed } = useWizardHost(open, accountTooNew);
  // Public is closed when the account is younger than the server's minimum (known from the config, or from a refusal).
  const publicBlocked = accountTooNew || (!!host && accountTooNewFor(host, minAccountAgeDays));
  const { data: myEvents = [] } = useQuery<{ id: string; title: string }[]>({ queryKey: ["/api/events/my-events"], enabled: open });
  const { data: myVenues = [] } = useQuery<{ id: string; name: string }[]>({ queryKey: ["/api/my-venues"], enabled: open });

  const [state, setState] = useState<WizardState>(() => defaultWizardState(defaults));
  const [linkChoice, setLinkChoiceRaw] = useState(() => linkChoiceOf(link));
  const [direct, setDirectRaw] = useState(true);
  const [screenUrl, setScreenUrlRaw] = useState("");
  // Paid room draft (price step). Kept beside WizardState, like the screen link: only sent when the price step is on.
  const [ticket, setTicketRaw] = useState<TicketDraft>(defaultTicketDraft);
  const [stepIdx, setStepIdx] = useState(0);
  const [error, setError] = useState<FieldError | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [touched, setTouched] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [noteGone, setNoteGone] = useState(noteSeen);
  // A field to focus on the next step change instead of the heading (after a refusal sends the host back to fix it).
  const [focusReq, setFocusReq] = useState<{ field: string; n: number } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const keyboard = useKeyboardInset(open);

  /** The shared rules for this host, plus public closed for a new account. Never run on every keystroke (see below). */
  const fit = (s: WizardState): WizardState => {
    if (!host) return s;
    const n = normalizeWizard(s, host);
    return publicBlocked && n.visibility === "public" ? { ...n, visibility: "friends" } : n;
  };

  // A fresh wizard every time it opens. When the host is already known (reopening), the fresh state is fitted at once:
  // the host effect below only runs when the host changes, so it would leave a default public pick in place.
  useEffect(() => {
    if (!open) return;
    const fresh = defaultWizardState(defaults);
    setState(host ? fit(fresh) : fresh); setLinkChoiceRaw(linkChoiceOf(link)); setDirectRaw(true); setScreenUrlRaw(""); setTicketRaw(defaultTicketDraft());
    setStepIdx(0); setError(null); setSubmitError(null); setBusy(false); setDone(null); setTouched(false); setConfirmClose(false); setFocusReq(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Once we know who is hosting, force a legal combination (no age limit above the host, teen: no public, new account: no
  // public). Not on every keystroke: normalizeWizard also clamps capacity, which would fight someone typing "15".
  const hostKey = host ? `${host.age}:${publicBlocked}` : "";
  useEffect(() => {
    if (!host) return;
    setState(fit);
  }, [hostKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<WizardState>) => {
    setState((s) => {
      const next = { ...s, ...patch };
      // Audience picks are re-checked at once so a forbidden pair can never sit on screen; text and numbers wait for Continue.
      return host && ("ageLimit" in patch || "visibility" in patch) ? normalizeWizard(next, host) : next;
    });
    setTouched(true); setError(null); setSubmitError(null);
  };
  const setLinkChoice = (v: string) => { setLinkChoiceRaw(v); setTouched(true); setError(null); };
  const setDirect = (v: boolean) => { setDirectRaw(v); setTouched(true); };
  const setScreenUrl = (v: string) => { setScreenUrlRaw(v); setTouched(true); };
  const setTicket = (patch: Partial<TicketDraft>) => { setTicketRaw((t) => ({ ...t, ...patch })); setTouched(true); setError(null); setSubmitError(null); };

  const options = useMemo(
    () => (host ? wizardOptions(host, flags, minAccountAgeDays, state.ageLimit) : null),
    [host?.age, host?.idVerifiedAdult, host?.accountAgeDays, minAccountAgeDays, flags.paidRooms, flags.spray, state.ageLimit], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Fallback for when the config did not say the account age: the server told us this account is too new for public
  // rooms, so never offer public again in this wizard.
  const visibilityOptions = useMemo(() => (options?.visibilityOptions ?? []).map((o) =>
    accountTooNew && o.value === "public" && !o.disabledReason ? { ...o, disabledReason: HOST_REFUSAL.ACCOUNT_TOO_NEW } : o), [options, accountTooNew]);

  // Paid room: the switch shows only with the paidRooms flag on and money unlocked for this room (18+/21+, adult host);
  // the price step only when it is also switched on. With the flag off none of it exists, and nothing is sent.
  const priceAvailable = priceStepAvailable(flags.paidRooms, options?.moneyLocked);
  const priceStepOn = priceAvailable && ticket.on;
  // Live video is refused above ROOM_LIMITS.liveVideoMax people (lane S1): with more tickets than that, the switch is off
  // with the reason, the price step says so, and live video is not asked for (review and create both drop it).
  const videoOverTickets = priceStepOn && ticketsTooManyForVideo(ticket);
  const withVideoRule = (s: WizardState): WizardState => (videoOverTickets && s.liveVideo ? { ...s, liveVideo: false } : s);
  const steps: UiStep[] = useMemo(() => {
    const raw: readonly string[] = host ? stepsFor(state, flags, host) : KNOWN_STEPS;
    const known = uiSteps(raw, priceStepOn);
    return known.length ? known : [...KNOWN_STEPS];
  }, [state, flags.paidRooms, flags.spray, host?.age, priceStepOn]); // eslint-disable-line react-hooks/exhaustive-deps
  const idx = Math.min(stepIdx, steps.length - 1);
  const current = steps[idx];

  const ageUnknown = !!host && host.age === null;
  const adultHost = !!host && host.age !== null && host.age >= 18;
  const showNote = !!host && !!options && Boolean(options.teenHostNote) && showTeenHostNote(host.age) && !noteGone;
  const dismissNote = () => { setNoteGone(true); try { localStorage.setItem(TEEN_NOTE_KEY, "1"); } catch { /* shows again next time */ } };
  const moneyPlaceholder = (flags.paidRooms || flags.spray) && adultHost && (state.ageLimit === "18+" || state.ageLimit === "21+") && options?.moneyLocked === null;

  const heading = done ? DONE_COPY[done.kind].title : uiStepTitle(current);

  // Step changes are announced once: focus moves to the step heading, which starts with "Step 2 of 5:" for screen readers
  // (there is no separate live region). After a refusal the field in error takes focus instead, so the host lands on it.
  useEffect(() => {
    if (!open) return;
    const t = requestAnimationFrame(() => {
      const el = focusReq
        ? [...ticketFieldSelectors(focusReq.field), ...fieldSelectors(focusReq.field)].map((sel) => document.querySelector<HTMLElement>(sel)).find((x) => !!x) ?? null
        : null;
      (el ?? headingRef.current)?.focus();
    });
    return () => cancelAnimationFrame(t);
  }, [open, idx, !!done, focusReq?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const focusField = (field: string) => setFocusReq((r) => ({ field, n: (r?.n ?? 0) + 1 }));

  const closeNow = () => { setConfirmClose(false); onOpenChange(false); };
  const requestClose = () => {
    if (busy) return; // a create in flight finishes first; the footer shows it is working
    if (touched && !done) setConfirmClose(true);
    else closeNow();
  };

  /**
   * The earliest step with a problem. This file's own checks look at what the host typed (`raw`), so a capacity that is
   * empty or out of range is reported instead of silently replaced; the shared rules look at the fitted state `s`.
   */
  const firstProblem = (raw: WizardState, s: WizardState, now: Date): (FieldError & { step: number }) | null => {
    const found: Array<FieldError & { step: number }> = [];
    const local = localProblem(raw, now);
    if (local) found.push({ ...local, step: indexOf(local.field) });
    const priced = priceStepOn ? ticketDraftProblem(ticket) : null;
    if (priced) found.push({ ...priced, step: indexOf(priced.field) });
    if (host) {
      const r = validateWizard(s, host, now, minAccountAgeDays);
      if (!r.ok) found.push({ field: r.field, reason: ruleMessage(r.field, r.reason), step: indexOf(r.field) });
    }
    found.sort((a, b) => (a.step < 0 ? 99 : a.step) - (b.step < 0 ? 99 : b.step));
    return found[0] ?? null;
  };
  const indexOf = (field: string) => {
    const st: UiStep | null = (TICKET_FIELDS as readonly string[]).includes(field) ? "money" : stepOfField(field);
    return st ? steps.indexOf(st) : -1;
  };

  const goBack = () => { setError(null); setSubmitError(null); setFocusReq(null); setStepIdx(Math.max(0, idx - 1)); };

  const goNext = () => {
    if (done) { const id = done.roomId; closeNow(); navigate(`/rooms/${id}`); return; }
    if (!host || ageUnknown || busy) return;
    const now = new Date();
    const s = fit(state);
    const p = firstProblem(state, s, now);
    if (p && p.step >= 0 && p.step <= idx) {
      // Keep what they typed on screen (not the fitted copy) so they can see and fix it.
      setError({ field: p.field, reason: p.reason });
      setStepIdx(p.step); focusField(p.field);
      return;
    }
    setState(s);
    if (current === "review") {
      if (p) { setSubmitError(p.reason); return; } // a problem no step owns: say it here, never send it
      void submit(s);
      return;
    }
    setError(null); setFocusReq(null);
    setStepIdx(idx + 1);
  };

  const submit = async (s: WizardState) => {
    setBusy(true); setSubmitError(null);
    const res = await createRoom(withVideoRule(s), { noDirectInteractions: !direct, screenUrl: LINK_SCREENS ? screenUrl : undefined, ticket, ticketsEnabled: priceStepOn }, parseLinkChoice(linkChoice));
    setBusy(false);
    if (!res.ok) {
      if (res.code === "ACCOUNT_TOO_NEW") setAccountTooNew(true);
      const msg = ticketCreateMessage(res) ?? createErrorMessage(res);
      const target: UiStep | null = isTicketFailure(res) ? (steps.includes("money") ? "money" : "features") : stepForFailure(res);
      const t = target ? steps.indexOf(target) : -1;
      const field = fieldForFailure(res);
      // A ticket code with no field (NO_PAYOUT_ACCOUNT, HOST_NOT_VERIFIED, ...) keeps field "": the price step shows it in
      // its general alert box (StepPrice), so it is never invisible.
      if (t >= 0 && t < idx) { setStepIdx(t); setError({ field, reason: msg }); if (field) focusField(field); }
      else setSubmitError(msg);
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["/api/rooms"] });
    if (adultHost) { try { localStorage.setItem(LAST_VISIBILITY_KEY, s.visibility); } catch { /* only a convenience */ } }
    if (res.voiceFailed) toast({ title: COPY.voiceLate });
    else if (res.videoFailed) toast({ title: COPY.videoLate });
    // Intended: a live public or friends room skips Done and goes straight in, because the host has only a short grace
    // period to arrive before an empty room closes and Done has nothing they need. An invite room stops at Done first (its
    // link is shown only once), and so does a room that was made but did not start (Done says so, and why).
    if (s.when === "now" && !res.inviteLink && !res.startFailure) { closeNow(); navigate(`/rooms/${res.roomId}`); return; }
    setDone({
      roomId: res.roomId,
      url: roomShareUrl(window.location.origin, res.roomId, res.inviteLink),
      kind: doneKind({ when: s.when, live: res.live, invite: !!res.inviteLink }),
      inviteOnce: !!res.inviteLink,
      note: res.startFailure ? createErrorMessage(res.startFailure) : null,
    });
  };

  const linkedText = (() => {
    const l = parseLinkChoice(linkChoice);
    if (l.eventId) return myEvents.find((e) => e.id === l.eventId)?.title ?? COPY.linkedEvent;
    if (l.venueId) return myVenues.find((v) => v.id === l.venueId)?.name ?? COPY.linkedVenue;
    return null;
  })();
  const ageText = options?.ageOptions.find((o) => o.value === state.ageLimit)?.label ?? state.ageLimit;
  const ticketKobo = priceStepOn ? priceKoboOf(ticket.priceNaira) : null;
  const ticketText = ticketKobo !== null ? `${formatNaira(ticketKobo)} · ${PRICE_COPY.reviewTickets(ticket.capacity)}` : null;

  const mainLabel = done ? COPY.goToRoom : current === "review" ? (state.when === "now" ? COPY.goLive : COPY.schedule) : COPY.next;
  const mainDisabled = !done && (busy || !host || ageUnknown);
  const loadingOptions = !options && current !== "basics" && !done;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (o) onOpenChange(true); else requestClose(); }}>
      <DialogPortal>
        <DialogOverlay className="motion-reduce:animate-none" />
        <DialogPrimitive.Content
          onOpenAutoFocus={(e) => { e.preventDefault(); headingRef.current?.focus(); }}
          onCloseAutoFocus={(e) => {
            // Opened from the quick start sheet, the element Radix would return to is gone: go back to Start a room.
            const el = returnFocusTo?.();
            if (el && el.isConnected) { e.preventDefault(); el.focus(); }
          }}
          className="fixed inset-x-0 top-0 z-50 flex h-[100dvh] flex-col bg-background text-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none sm:inset-x-auto sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[90dvh] sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:border-border"
          // With the on-screen keyboard open, shrink to the visible part of the screen so the footer sits right above it.
          style={keyboard > 0 ? { height: `calc(100dvh - ${keyboard}px)` } : undefined}
          data-testid="dialog-create-room"
        >
          <header className="flex shrink-0 items-center gap-1 px-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
            <button
              type="button" onClick={requestClose} aria-label={COPY.close}
              className="grid h-11 w-11 place-items-center rounded-full hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              data-testid="button-wizard-close"
            >
              <XIcon className="h-5 w-5" aria-hidden />
            </button>
            <DialogPrimitive.Title className="text-base font-semibold">{done ? heading : COPY.wizardTitle}</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">{COPY.wizardDesc}</DialogPrimitive.Description>
          </header>

          {!done && (
            <div className="flex shrink-0 gap-1.5 px-4 pb-1 pt-2" aria-hidden>
              {steps.map((s, i) => <span key={s} className={`h-1 flex-1 rounded-full ${i <= idx ? "bg-primary" : "bg-muted"}`} />)}
            </div>
          )}

          <form noValidate onSubmit={(e) => { e.preventDefault(); goNext(); }} className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6">
              <h2 ref={headingRef} tabIndex={-1} className="mb-4 mt-3 font-serif text-3xl font-bold tracking-tight outline-none" data-testid="wizard-step-heading">
                {!done && <span className="sr-only" data-testid="wizard-progress">{progressPrefix(idx, steps.length)}</span>}
                {heading}
              </h2>

              {ageUnknown && !done && (
                <p role="alert" className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="text-room-needs-dob">{COPY.needsDob}</p>
              )}
              {hostFailed && !host && (
                <p role="alert" className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">{createErrorMessage({ status: 0 })}</p>
              )}

              {done ? (
                <StepDone body={DONE_COPY[done.kind].body} note={done.note} url={done.url} inviteOnce={done.inviteOnce} title={state.title.trim()} />
              ) : loadingOptions ? (
                <div className="grid place-items-center py-10">
                  {/* The animated icons drop aria props, so the wrapper carries the status. */}
                  <span role="status" aria-label="Loading"><Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden /></span>
                </div>
              ) : current === "basics" ? (
                <StepBasics state={state} set={set} error={error} linkChoice={linkChoice} setLinkChoice={setLinkChoice} myEvents={myEvents} myVenues={myVenues} />
              ) : current === "audience" && options ? (
                <StepAudience
                  state={state} set={set} error={error} ageOptions={options.ageOptions} visibilityOptions={visibilityOptions}
                  showTeenNote={showNote} onDismissTeenNote={dismissNote}
                />
              ) : current === "features" ? (
                <StepFeatures
                  state={state} set={set} error={error} directInteractions={direct} setDirectInteractions={setDirect}
                  screenUrl={screenUrl} setScreenUrl={setScreenUrl} moneyPlaceholder={moneyPlaceholder && !priceAvailable}
                  paid={priceAvailable ? { on: ticket.on, set: (on) => setTicket({ on }), needsId: !host?.idVerifiedAdult } : null}
                  videoBlocked={videoOverTickets ? PRICE_COPY.videoNeedsFewer : null}
                />
              ) : current === "money" && priceStepOn ? (
                <StepPrice draft={ticket} set={setTicket} error={error} liveVideo={state.voice && state.liveVideo} />
              ) : current === "when" ? (
                <StepWhen state={state} set={set} error={error} now={new Date()} />
              ) : (
                <StepReview state={withVideoRule(state)} ageText={ageText} linkedText={linkedText} error={submitError} ticketText={ticketText} ticketCount={ticketKobo !== null ? ticket.capacity : null} />
              )}
            </div>

            <footer className="flex shrink-0 gap-3 border-t border-border bg-background px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
              {idx > 0 && !done && (
                <Button type="button" variant="ghost" className="h-12 rounded-full px-6" onClick={goBack} disabled={busy} data-testid="button-wizard-back">{COPY.back}</Button>
              )}
              <Button type="submit" className="h-12 flex-1 rounded-full text-base" disabled={mainDisabled} aria-busy={busy || undefined} data-testid="button-wizard-next">
                {busy && <Loader2Icon className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}
                {busy ? COPY.working : mainLabel}
              </Button>
            </footer>
          </form>

          <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{COPY.leaveTitle}</AlertDialogTitle>
                <AlertDialogDescription>{COPY.leaveBody}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="min-h-[44px]" data-testid="button-wizard-keep">{COPY.leaveStay}</AlertDialogCancel>
                <AlertDialogAction className="min-h-[44px]" onClick={closeNow} data-testid="button-wizard-leave">{COPY.leaveGo}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </DialogPrimitive.Content>
      </DialogPortal>
    </DialogPrimitive.Root>
  );
}
