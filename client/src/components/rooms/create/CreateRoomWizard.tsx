// The create-a-room wizard: Basics, Audience, Features, When, Review, then Done. Options come from the shared wizard rules
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
import { normalizeWizard, stepsFor, validateWizard, wizardOptions, type WizardState } from "@/lib/createRoomRules";
import {
  COPY, HOST_REFUSAL, KNOWN_STEPS, LAST_VISIBILITY_KEY, STEP_TITLE, TEEN_NOTE_KEY, createErrorMessage, defaultWizardState, fieldForFailure,
  isKnownStep, linkChoiceOf, localProblem, parseLinkChoice, progressLine, roomShareUrl, ruleMessage, stepForFailure, stepOfField,
  type RoomLink, type WizardStep,
} from "@/lib/createRoomWizardUi";
import { createRoom, useWizardHost } from "./createRoomApi";
import StepBasics, { type FieldError } from "./StepBasics";
import StepAudience from "./StepAudience";
import StepFeatures from "./StepFeatures";
import StepWhen from "./StepWhen";
import StepReview from "./StepReview";
import StepDone from "./StepDone";

export interface CreateRoomWizardProps {
  open: boolean;
  onOpenChange(o: boolean): void;
  defaults?: Partial<WizardState>;
  /** Opened from an event or venue page: the room is attached to it (the owner can still change or clear it). */
  link?: RoomLink;
}

const noteSeen = () => { try { return localStorage.getItem(TEEN_NOTE_KEY) === "1"; } catch { return false; } };

interface Done { roomId: string; url: string; live: boolean; inviteOnce: boolean }

export default function CreateRoomWizard({ open, onOpenChange, defaults, link }: CreateRoomWizardProps) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [accountTooNew, setAccountTooNew] = useState(false);
  const { host, flags, failed: hostFailed } = useWizardHost(open, accountTooNew);
  const { data: myEvents = [] } = useQuery<{ id: string; title: string }[]>({ queryKey: ["/api/events/my-events"], enabled: open });
  const { data: myVenues = [] } = useQuery<{ id: string; name: string }[]>({ queryKey: ["/api/my-venues"], enabled: open });

  const [state, setState] = useState<WizardState>(() => defaultWizardState(defaults));
  const [linkChoice, setLinkChoiceRaw] = useState(() => linkChoiceOf(link));
  const [direct, setDirectRaw] = useState(true);
  const [screenUrl, setScreenUrlRaw] = useState("");
  const [stepIdx, setStepIdx] = useState(0);
  const [error, setError] = useState<FieldError | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [touched, setTouched] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [noteGone, setNoteGone] = useState(noteSeen);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const keyboard = useKeyboardInset(open);

  // A fresh wizard every time it opens.
  useEffect(() => {
    if (!open) return;
    setState(defaultWizardState(defaults)); setLinkChoiceRaw(linkChoiceOf(link)); setDirectRaw(true); setScreenUrlRaw("");
    setStepIdx(0); setError(null); setSubmitError(null); setBusy(false); setDone(null); setTouched(false); setConfirmClose(false);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Once we know who is hosting, force a legal combination (teen: no 18+/21+, no public). Not on every keystroke:
  // normalizeWizard also clamps capacity, which would fight someone typing "15" (the "1" would become 2).
  const hostKey = host ? `${host.age}:${accountTooNew}` : "";
  useEffect(() => {
    if (!host) return;
    setState((s) => {
      const n = normalizeWizard(s, host);
      return accountTooNew && n.visibility === "public" ? { ...n, visibility: "friends" } : n;
    });
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

  const options = useMemo(() => (host ? wizardOptions(host, flags, 0, state.ageLimit) : null), [host?.age, host?.idVerifiedAdult, flags.paidRooms, flags.spray, state.ageLimit]); // eslint-disable-line react-hooks/exhaustive-deps
  // The server told us this account is too new for public rooms: never offer public again in this wizard.
  const visibilityOptions = useMemo(() => (options?.visibilityOptions ?? []).map((o) =>
    accountTooNew && o.value === "public" && !o.disabledReason ? { ...o, disabledReason: HOST_REFUSAL.ACCOUNT_TOO_NEW } : o), [options, accountTooNew]);

  const steps: WizardStep[] = useMemo(() => {
    const raw: readonly string[] = host ? stepsFor(state, flags, host) : KNOWN_STEPS;
    const known = raw.filter(isKnownStep);
    return known.length ? known : [...KNOWN_STEPS];
  }, [state, flags.paidRooms, flags.spray, host?.age]); // eslint-disable-line react-hooks/exhaustive-deps
  const idx = Math.min(stepIdx, steps.length - 1);
  const current = steps[idx];

  const ageUnknown = !!host && host.age === null;
  const adultHost = !!host && host.age !== null && host.age >= 18;
  const showNote = !!host && !!options && Boolean(options.teenHostNote) && showTeenHostNote(host.age) && !noteGone;
  const dismissNote = () => { setNoteGone(true); try { localStorage.setItem(TEEN_NOTE_KEY, "1"); } catch { /* shows again next time */ } };
  const moneyPlaceholder = (flags.paidRooms || flags.spray) && adultHost && (state.ageLimit === "18+" || state.ageLimit === "21+") && options?.moneyLocked === null;

  const heading = done ? (done.live ? COPY.doneLiveTitle : COPY.doneScheduledTitle) : STEP_TITLE[current];
  const announce = done ? heading : progressLine(idx, steps.length, heading);

  // Focus the step heading on every step change, so keyboard and screen reader users start at the top of the new step.
  useEffect(() => {
    if (!open) return;
    const t = requestAnimationFrame(() => headingRef.current?.focus());
    return () => cancelAnimationFrame(t);
  }, [open, idx, !!done]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeNow = () => { setConfirmClose(false); onOpenChange(false); };
  const requestClose = () => {
    if (busy) return; // a create in flight finishes first; the footer shows it is working
    if (touched && !done) setConfirmClose(true);
    else closeNow();
  };

  /** The earliest step with a problem, from this file's own checks and from the shared rules. */
  const firstProblem = (s: WizardState, now: Date): (FieldError & { step: number }) | null => {
    const found: Array<FieldError & { step: number }> = [];
    const local = localProblem(s, now);
    if (local) found.push({ ...local, step: indexOf(local.field) });
    if (host) {
      const r = validateWizard(s, host, now);
      if (!r.ok) found.push({ field: r.field, reason: ruleMessage(r.field, r.reason), step: indexOf(r.field) });
    }
    found.sort((a, b) => (a.step < 0 ? 99 : a.step) - (b.step < 0 ? 99 : b.step));
    return found[0] ?? null;
  };
  const indexOf = (field: string) => { const st = stepOfField(field); return st ? steps.indexOf(st) : -1; };

  const goBack = () => { setError(null); setSubmitError(null); setStepIdx(Math.max(0, idx - 1)); };

  const goNext = () => {
    if (done) { const id = done.roomId; closeNow(); navigate(`/rooms/${id}`); return; }
    if (!host || ageUnknown || busy) return;
    const now = new Date();
    const s = normalizeWizard(state, host);
    if (s !== state) setState(s);
    const p = firstProblem(s, now);
    if (p && p.step >= 0 && p.step <= idx) { setError({ field: p.field, reason: p.reason }); setStepIdx(p.step); return; }
    if (current === "review") {
      if (p) { setSubmitError(p.reason); return; } // a problem no step owns: say it here, never send it
      void submit(s);
      return;
    }
    setError(null);
    setStepIdx(idx + 1);
  };

  const submit = async (s: WizardState) => {
    setBusy(true); setSubmitError(null);
    const res = await createRoom(s, { noDirectInteractions: !direct, screenUrl: LINK_SCREENS ? screenUrl : undefined }, parseLinkChoice(linkChoice));
    setBusy(false);
    if (!res.ok) {
      if (res.code === "ACCOUNT_TOO_NEW") setAccountTooNew(true);
      const msg = createErrorMessage(res);
      const target = stepForFailure(res);
      const t = target ? steps.indexOf(target) : -1;
      if (t >= 0 && t < idx) { setStepIdx(t); setError({ field: fieldForFailure(res), reason: msg }); }
      else setSubmitError(msg);
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["/api/rooms"] });
    if (adultHost) { try { localStorage.setItem(LAST_VISIBILITY_KEY, s.visibility); } catch { /* only a convenience */ } }
    if (res.startFailure) toast({ title: COPY.startedLate, description: createErrorMessage(res.startFailure), variant: "destructive" });
    else if (res.voiceFailed) toast({ title: COPY.voiceLate });
    else if (res.videoFailed) toast({ title: COPY.videoLate });
    // "Go live now" goes straight in: the host has a short grace period to arrive before an empty room closes.
    // An invite room stops at Done first, because its link is shown only once.
    if (s.when === "now" && !res.inviteLink) { closeNow(); navigate(`/rooms/${res.roomId}`); return; }
    setDone({ roomId: res.roomId, url: roomShareUrl(window.location.origin, res.roomId, res.inviteLink), live: res.live, inviteOnce: !!res.inviteLink });
  };

  const linkedText = (() => {
    const l = parseLinkChoice(linkChoice);
    if (l.eventId) return myEvents.find((e) => e.id === l.eventId)?.title ?? COPY.linkedEvent;
    if (l.venueId) return myVenues.find((v) => v.id === l.venueId)?.name ?? COPY.linkedVenue;
    return null;
  })();
  const ageText = options?.ageOptions.find((o) => o.value === state.ageLimit)?.label ?? state.ageLimit;

  const mainLabel = done ? COPY.goToRoom : current === "review" ? (state.when === "now" ? COPY.goLive : COPY.schedule) : COPY.next;
  const mainDisabled = !done && (busy || !host || ageUnknown);
  const loadingOptions = !options && current !== "basics" && !done;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (o) onOpenChange(true); else requestClose(); }}>
      <DialogPortal>
        <DialogOverlay className="motion-reduce:animate-none" />
        <DialogPrimitive.Content
          onOpenAutoFocus={(e) => { e.preventDefault(); headingRef.current?.focus(); }}
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
            <DialogPrimitive.Description className="sr-only">{announce}</DialogPrimitive.Description>
          </header>

          {!done && (
            <div className="flex shrink-0 gap-1.5 px-4 pb-1 pt-2" aria-hidden>
              {steps.map((s, i) => <span key={s} className={`h-1 flex-1 rounded-full ${i <= idx ? "bg-primary" : "bg-muted"}`} />)}
            </div>
          )}
          <p aria-live="polite" className="sr-only" data-testid="wizard-progress">{announce}</p>

          <form noValidate onSubmit={(e) => { e.preventDefault(); goNext(); }} className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6">
              <h2 ref={headingRef} tabIndex={-1} className="mb-4 mt-3 font-serif text-3xl font-bold tracking-tight outline-none" data-testid="wizard-step-heading">
                {heading}
              </h2>

              {ageUnknown && !done && (
                <p role="alert" className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="text-room-needs-dob">{COPY.needsDob}</p>
              )}
              {hostFailed && !host && (
                <p role="alert" className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">{createErrorMessage({ status: 0 })}</p>
              )}

              {done ? (
                <StepDone live={done.live} url={done.url} inviteOnce={done.inviteOnce} title={state.title.trim()} />
              ) : loadingOptions ? (
                <div className="grid place-items-center py-10"><Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground motion-reduce:animate-none" aria-label="Loading" /></div>
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
                  screenUrl={screenUrl} setScreenUrl={setScreenUrl} moneyPlaceholder={moneyPlaceholder}
                />
              ) : current === "when" ? (
                <StepWhen state={state} set={set} error={error} now={new Date()} />
              ) : (
                <StepReview state={state} ageText={ageText} linkedText={linkedText} error={submitError} />
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
