// "Start a room": one sheet to choose how. Voice room and Live video go live in one tap with sane defaults; Schedule for later
// and Set it up yourself open the full wizard. Money options are not offered (paid rooms and spray are off).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import RoomSheetContent from "@/components/rooms/shell/RoomSheetContent";
import { CalendarIcon, CameraIcon, ChevronRightIcon, Loader2Icon, MicIcon, SettingsIcon } from "@/components/ui/icons";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { queryClient } from "@/lib/queryClient";
import { accountTooNewFor, normalizeWizard, type WizardState } from "@/lib/createRoomRules";
import { COPY, LAST_VISIBILITY_KEY, createErrorMessage, quickStartState, quickVisibilityLine } from "@/lib/createRoomWizardUi";
import { createRoom, useWizardHost } from "./createRoomApi";

interface Props {
  open: boolean;
  onOpenChange(o: boolean): void;
  /** Opens the full wizard (closing this sheet first), optionally with some choices made. */
  onCustomize(defaults?: Partial<WizardState>): void;
  /** The Start a room button: focus goes back there when the sheet closes (not when it hands over to the wizard). */
  returnFocusTo?: () => HTMLElement | null;
}

const lastVisibility = () => { try { return localStorage.getItem(LAST_VISIBILITY_KEY); } catch { return null; } };

function Row({ icon, title, sub, onClick, disabled, busy, testId }: { icon: ReactNode; title: string; sub: string; onClick(): void; disabled?: boolean; busy?: boolean; testId: string }) {
  return (
    <button
      type="button" onClick={onClick} disabled={disabled} aria-busy={busy || undefined}
      className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl border border-border bg-card p-3 text-left transition-colors hover:border-primary/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
      data-testid={testId}
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary/10 text-primary" aria-hidden>
        {busy ? <Loader2Icon className="h-5 w-5 animate-spin motion-reduce:animate-none" /> : icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        <span className="block text-sm text-muted-foreground">{sub}</span>
      </span>
      <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );
}

export default function QuickStartSheet({ open, onOpenChange, onCustomize, returnFocusTo }: Props) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { data: me } = useAuth();
  // Set once the server answers ACCOUNT_TOO_NEW, for when the config did not say the account age.
  const [tooNew, setTooNew] = useState(false);
  const { host, minAccountAgeDays } = useWizardHost(open, tooNew);
  const [busy, setBusy] = useState<"voice" | "video" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // True while the sheet closes to open the wizard: focus then belongs to the wizard, not to the Start a room button.
  const handingOff = useRef(false);
  useEffect(() => { if (open) handingOff.current = false; }, [open]);

  const ageUnknown = !!host && host.age === null;
  const publicBlocked = tooNew || (!!host && accountTooNewFor(host, minAccountAgeDays));
  /** The one-tap room: the quick start defaults, fitted to the shared rules, and never public for a new account. */
  const quickState = (opts: { name?: string | null; liveVideo?: boolean } = {}): WizardState | null => {
    if (!host) return null;
    const s = normalizeWizard(quickStartState(host, { ...opts, lastVisibility: lastVisibility() }), host);
    return publicBlocked && s.visibility === "public" ? { ...s, visibility: "friends" } : s;
  };
  const preview = quickState();

  const quick = async (kind: "voice" | "video") => {
    if (!host || ageUnknown || busy) return;
    const s = quickState({ name: me?.displayName || me?.username, liveVideo: kind === "video" });
    if (!s) return;
    setError(null); setBusy(kind);
    const res = await createRoom(s, {}, {});
    setBusy(null);
    if (!res.ok) {
      // Too new for public: forget public as the last pick, so the next tap (and the line above) uses Friends.
      if (res.code === "ACCOUNT_TOO_NEW") { setTooNew(true); try { localStorage.removeItem(LAST_VISIBILITY_KEY); } catch { /* only a convenience */ } }
      setError(createErrorMessage(res));
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["/api/rooms"] });
    if (res.startFailure) toast({ title: COPY.startedLate, description: createErrorMessage(res.startFailure), variant: "destructive" });
    else if (res.voiceFailed) toast({ title: COPY.voiceLate });
    else if (res.videoFailed) toast({ title: COPY.videoLate });
    onOpenChange(false);
    navigate(`/rooms/${res.roomId}`);
  };
  const customize = (defaults?: Partial<WizardState>) => { handingOff.current = true; onOpenChange(false); onCustomize(defaults); };

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!busy) { setError(null); onOpenChange(o); } }}>
      <RoomSheetContent
        side="bottom"
        onCloseAutoFocus={(e) => { if (handingOff.current) e.preventDefault(); }}
        returnFocusTo={() => (handingOff.current ? null : returnFocusTo?.() ?? null)}
        className="max-h-[88dvh] overflow-y-auto rounded-t-3xl pb-[calc(20px+env(safe-area-inset-bottom,0px))] sm:mx-auto sm:max-w-lg" data-testid="quick-start-sheet">
        <SheetHeader className="pr-10 text-left">
          <SheetTitle className="font-sans text-lg font-semibold">{COPY.quickTitle}</SheetTitle>
          <SheetDescription>{COPY.quickDesc}{preview ? ` ${quickVisibilityLine(preview.visibility)}` : ""}</SheetDescription>
        </SheetHeader>
        {ageUnknown && <p role="alert" className="mt-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">{COPY.needsDob}</p>}
        <div className="mt-4 space-y-2">
          <Row icon={<MicIcon className="h-5 w-5" />} title={COPY.quickVoice} sub={COPY.quickVoiceSub} onClick={() => quick("voice")} disabled={!host || ageUnknown || !!busy} busy={busy === "voice"} testId="button-quick-voice" />
          <Row icon={<CameraIcon className="h-5 w-5" />} title={COPY.quickVideo} sub={COPY.quickVideoSub} onClick={() => quick("video")} disabled={!host || ageUnknown || !!busy} busy={busy === "video"} testId="button-quick-video" />
          <Row icon={<CalendarIcon className="h-5 w-5" />} title={COPY.quickLater} sub={COPY.quickLaterSub} onClick={() => customize({ when: "later" })} disabled={!!busy} testId="button-quick-later" />
          <Row icon={<SettingsIcon className="h-5 w-5" />} title={COPY.quickCustom} sub={COPY.quickCustomSub} onClick={() => customize()} disabled={!!busy} testId="button-quick-custom" />
        </div>
        {error && <p role="alert" className="mt-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="text-quick-start-error">{error}</p>}
      </RoomSheetContent>
    </Sheet>
  );
}
