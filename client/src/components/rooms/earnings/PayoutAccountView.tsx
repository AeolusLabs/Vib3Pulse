// "Get paid" (flows.html board 8, Settlement account): the bank account by its last four digits only, whether the name
// matches the ID, and the identity check. A verified adult with no account, or one whose name does not match, gets the
// form. The server resolves the account with the bank, compares the name and never sends the name or the full number back,
// so this screen can only ever say "matches" or "does not match".
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangleIcon, CheckCircleIcon, ChevronRightIcon, ClockIcon, Loader2Icon, ShieldCheckIcon } from "@/components/ui/icons";
import { banksKey, fetchBanks, fetchPayoutStatus, payoutStatusKey, savePayoutAccount } from "@/lib/earningsApi";
import { useRoomsConfig } from "@/lib/roomsApi";
import { useAgeReview } from "@/hooks/useAgeReview";
import { COPY as AGE_COPY, payoutCta, waitLabel } from "@/lib/ageReview";
import {
  PAYOUT_COPY, VERIFY_AGE_HREF, VERIFY_NAME_HREF, accountFailureCta, accountNeedsRefetch, accountNumberValid, canLinkHere, payoutErrorMessage, payoutPanel,
  payoutStage, readFailureMessage, savedAccountOf, type PayoutStatus,
} from "./earningsUi";

function Spinner({ label }: { label: string }) {
  return (
    <div className="grid place-items-center py-10">
      <span role="status" aria-label={label}><Loader2Icon className="h-6 w-6 animate-spin motion-reduce:animate-none" aria-hidden /></span>
    </div>
  );
}

/** One row of the checklist: a mark, the label and line, and a word on the right. */
function CheckRow({ ok, label, line, word, testId }: { ok: boolean; label: string; line: string; word: string; testId: string }) {
  return (
    <li className="flex min-h-[56px] items-center gap-3 px-4 py-3" data-testid={testId}>
      {ok
        ? <CheckCircleIcon className="h-5 w-5 shrink-0 text-primary" aria-hidden />
        : <AlertTriangleIcon className="h-5 w-5 shrink-0 text-destructive" aria-hidden />}
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{label}</span>
        <span className="block text-sm text-muted-foreground">{line}</span>
      </span>
      <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${ok ? "bg-primary/15 text-foreground" : "bg-destructive/15 text-foreground"}`}>{word}</span>
    </li>
  );
}

interface FormProps {
  /** Called after a save the server accepted, with the last four digits if the answer carried them. */
  onSaved(last4: string | null, waitingForName?: boolean): void;
  /** Shown only when there is an account to keep. */
  onCancel?: () => void;
  /** Move focus to the first field (when the person opened the form with a button, not on page load). */
  autoFocus?: boolean;
}

/** Bank and account number. The number lives in this component's state only, and is cleared after every answer. */
export function AccountForm({ onSaved, onCancel, autoFocus = false }: FormProps) {
  const qc = useQueryClient();
  const banks = useQuery({ queryKey: banksKey, queryFn: fetchBanks, staleTime: 60 * 60 * 1000 });
  const [bankCode, setBankCode] = useState("");
  const [number, setNumber] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cta, setCta] = useState<"verify_name" | "recheck" | null>(null);
  const bankRef = useRef<HTMLSelectElement>(null);
  useEffect(() => { if (autoFocus) bankRef.current?.focus(); }, [autoFocus]);

  const numberOk = accountNumberValid(number);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setTried(true);
    if (!bankCode || !numberOk) return;
    setBusy(true); setError(null);
    const r = await savePayoutAccount(bankCode, number);
    setBusy(false);
    setNumber(""); // never kept after the bank has answered, whatever it said
    setTried(false);
    if (r.ok) {
      void qc.invalidateQueries({ queryKey: payoutStatusKey });
      const acct = savedAccountOf(r.body);
      onSaved(acct?.last4 ?? null, !!acct && !acct.nameMatches);
      return;
    }
    setError(payoutErrorMessage(r));
    setCta(accountFailureCta(r));
    if (accountNeedsRefetch(r) || r.code === "NAME_MISMATCH" || r.status === 422 || r.status === 403) void qc.invalidateQueries({ queryKey: payoutStatusKey });
  };

  const bankList = banks.data?.ok ? banks.data.data : null;
  const showNumberError = tried && !numberOk;
  return (
    <form className="space-y-4" onSubmit={submit} noValidate data-testid="payout-account-form">
      <div className="space-y-2">
        <Label htmlFor="payout-bank">{PAYOUT_COPY.bankLabel}</Label>
        <select
          id="payout-bank" ref={bankRef}
          className="h-11 w-full rounded-md border border-input bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
          value={bankCode} onChange={(e) => { setBankCode(e.target.value); setError(null); }}
          disabled={busy || !bankList} aria-invalid={tried && !bankCode ? true : undefined}
          data-testid="select-payout-bank"
        >
          <option value="">{banks.isLoading ? PAYOUT_COPY.banksLoading : PAYOUT_COPY.bankPlaceholder}</option>
          {bankList?.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
        </select>
        {banks.data && !banks.data.ok && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm text-destructive">{PAYOUT_COPY.banksFailed}</p>
            <Button type="button" variant="outline" className="min-h-[44px]" onClick={() => banks.refetch()}>{PAYOUT_COPY.retry}</Button>
          </div>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="payout-number">{PAYOUT_COPY.numberLabel}</Label>
        <Input
          id="payout-number" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={14}
          className="h-11" value={number} disabled={busy}
          onChange={(e) => { setNumber(e.target.value.replace(/[^\d\s-]/g, "")); setError(null); }}
          aria-invalid={showNumberError ? true : undefined}
          aria-describedby={showNumberError ? "payout-number-help payout-number-error" : "payout-number-help"}
          data-testid="input-payout-number"
        />
        <p id="payout-number-help" className="text-sm text-muted-foreground">{PAYOUT_COPY.numberHelp}</p>
        {showNumberError && <p id="payout-number-error" role="alert" className="text-sm text-destructive">{PAYOUT_COPY.numberInvalid}</p>}
      </div>
      {error && (
        <div role="alert" className="space-y-1 rounded-xl border border-destructive/60 p-3 text-sm" data-testid="payout-account-error">
          <p>{error}</p>
          {cta && (
            <Link href={VERIFY_NAME_HREF} className="inline-flex min-h-[44px] items-center font-medium text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" data-testid="payout-name-cta">
              {cta === "recheck" ? PAYOUT_COPY.recheckCta : PAYOUT_COPY.needNameCta}
            </Link>
          )}
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" className="min-h-[48px] flex-1 rounded-full" disabled={busy || (tried && (!bankCode || !numberOk))} aria-busy={busy || undefined} data-testid="button-save-payout-account">
          {busy && <Loader2Icon className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}
          {busy ? PAYOUT_COPY.saving : PAYOUT_COPY.save}
        </Button>
        {onCancel && <Button type="button" variant="ghost" className="min-h-[48px] rounded-full" onClick={onCancel} disabled={busy}>{PAYOUT_COPY.cancelChange}</Button>}
      </div>
    </form>
  );
}

/** The whole "Get paid" body (the page adds the app's navigation; the dev fixture draws this on its own). */
export default function PayoutAccountView() {
  const q = useQuery({ queryKey: payoutStatusKey, queryFn: fetchPayoutStatus, staleTime: 0 });
  // Linking is offered only while paid rooms or spray is switched on (the server checks the same flags). Until the config
  // has loaded, it counts as off: the form never shows on a guess.
  const config = useRoomsConfig();
  const moneyOn = config.data?.features.paidRooms === true || config.data?.features.spray === true;
  const [changing, setChanging] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const changeBtn = useRef<HTMLButtonElement>(null);
  const savedRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (saved) savedRef.current?.focus(); }, [saved]);

  const res = q.data;
  return (
    <section className="space-y-5" aria-labelledby="payouts-title" data-testid="room-payouts">
      <header className="space-y-1">
        <h1 id="payouts-title" className="font-serif text-3xl font-bold">{PAYOUT_COPY.title}</h1>
        <p className="text-sm text-muted-foreground">{PAYOUT_COPY.intro}</p>
      </header>
      {saved && <p ref={savedRef} tabIndex={-1} role="status" className="rounded-xl border border-border p-3 text-sm outline-none" data-testid="payout-saved">{saved}</p>}
      {q.isLoading || !res ? <Spinner label={PAYOUT_COPY.loading} /> : !res.ok ? (
        <div className="space-y-3 rounded-2xl border border-border p-6 text-center">
          <p role="alert" className="text-sm text-muted-foreground">{readFailureMessage(res.status, PAYOUT_COPY.loadFailed)}</p>
          <Button variant="outline" className="min-h-[44px] rounded-full" onClick={() => q.refetch()}>{PAYOUT_COPY.retry}</Button>
        </div>
      ) : (
        <PayoutBody
          status={res.data} moneyOn={moneyOn} changing={changing}
          onChange={() => { setSaved(null); setChanging(true); }}
          onCancel={() => { setChanging(false); requestAnimationFrame(() => changeBtn.current?.focus()); }}
          onSaved={(last4, waiting) => { setChanging(false); setSaved(last4 ? (waiting ? PAYOUT_COPY.savedWaiting(last4) : PAYOUT_COPY.saved(last4)) : PAYOUT_COPY.savedPlain); }}
          changeBtn={changeBtn}
        />
      )}
      <nav aria-label="Money" className="flex flex-col gap-1 border-t border-border pt-4 text-sm">
        <Link href="/rooms/earnings" className="inline-flex min-h-[44px] items-center gap-1 font-medium underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" data-testid="link-earnings">{PAYOUT_COPY.earningsLink}<ChevronRightIcon className="h-4 w-4" aria-hidden /></Link>
        <Link href="/rooms/payments" className="inline-flex min-h-[44px] items-center gap-1 font-medium underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" data-testid="link-payments">{PAYOUT_COPY.paymentsLink}<ChevronRightIcon className="h-4 w-4" aria-hidden /></Link>
      </nav>
    </section>
  );
}

/** The whole path in one line: ID, then the name for payouts, then a bank account that matches it. The first step not done is the current one. */
function PayoutSteps({ steps }: { steps: { label: string; done: boolean }[] }) {
  const current = steps.findIndex((s) => !s.done);
  return (
    <ol className="flex gap-2" aria-label="Steps to get paid" data-testid="payout-steps">
      {steps.map((s, i) => (
        <li key={s.label} className="flex-1" aria-current={i === current ? "step" : undefined}>
          <span className={`block h-1.5 rounded-full ${s.done ? "bg-primary" : i === current ? "bg-primary/40" : "bg-muted"}`} aria-hidden />
          <span className={`mt-1.5 block text-xs ${i === current ? "font-semibold" : "text-muted-foreground"}`}>{i + 1}. {s.label}<span className="sr-only">{s.done ? ", done" : i === current ? ", next" : ""}</span></span>
        </li>
      ))}
    </ol>
  );
}

function PayoutBody({ status, moneyOn, changing, onChange, onCancel, onSaved, changeBtn }: {
  status: PayoutStatus; moneyOn: boolean; changing: boolean; onChange(): void; onCancel(): void; onSaved(last4: string | null, waitingForName?: boolean): void;
  changeBtn: RefObject<HTMLButtonElement>;
}) {
  const stage = payoutStage(status, moneyOn);
  const panel = payoutPanel(status, moneyOn);
  const { me: ageMe } = useAgeReview();
  const cta = payoutCta(ageMe);
  // The bank form is open before the name is on file; once an account is saved it waits for the name check, so no second form.
  const canLink = canLinkHere(status, moneyOn) && !(panel === "needs_name" && status.awaitingName);
  const a = status.account;
  return (
    <div className="space-y-5" data-stage={stage} data-testid="payout-stage">
      <PayoutSteps steps={[
        { label: "Name and Age review", done: status.verifiedAdult && status.hasVerifiedName },
        { label: "Bank account", done: status.subaccountReady },
      ]} />
      <ul className="divide-y divide-border rounded-2xl bg-muted/60" aria-label="Payout checks">
        {a && (
          panel === "needs_name"
            ? <CheckRow ok={false} label={PAYOUT_COPY.bankRow} line={PAYOUT_COPY.notCheckedLine(a.bankName, a.last4)} word={PAYOUT_COPY.notChecked} testId="payout-row-bank" />
            : <CheckRow ok={a.nameMatches} label={PAYOUT_COPY.bankRow} line={PAYOUT_COPY.bankLine(a.bankName, a.last4, a.nameMatches)}
              word={a.nameMatches ? PAYOUT_COPY.verified : PAYOUT_COPY.notVerified} testId="payout-row-bank" />
        )}
        {stage === "setup" && panel !== "needs_name" && (
          <CheckRow ok label={PAYOUT_COPY.bankRow} line={PAYOUT_COPY.setupLine} word={PAYOUT_COPY.verified} testId="payout-row-bank" />
        )}
        <CheckRow ok={status.verifiedAdult} label={PAYOUT_COPY.idRow} line={status.verifiedAdult ? PAYOUT_COPY.idVerified : PAYOUT_COPY.idMissing}
          word={status.verifiedAdult ? PAYOUT_COPY.verified : PAYOUT_COPY.notVerified} testId="payout-row-id" />
      </ul>

      {stage === "unverified" && (
        <div className="space-y-2 rounded-2xl border border-border p-4" data-testid="payout-unverified">
          <h2 className="flex items-center gap-2 font-semibold"><ShieldCheckIcon className="h-5 w-5 text-primary" aria-hidden />{PAYOUT_COPY.needAgeTitle}</h2>
          <p className="text-sm text-muted-foreground">{PAYOUT_COPY.needAgeBody}</p>
          {cta === "link" && <Button asChild className="min-h-[44px] rounded-full" data-testid="payout-verify-age-cta"><Link href={VERIFY_AGE_HREF}>{PAYOUT_COPY.needAgeCta}</Link></Button>}
          {cta === "paused" && <p role="status" className="text-sm font-medium" data-testid="payout-cta-paused">{AGE_COPY.agePaused}</p>}
          {cta === "cooldown" && <p role="status" className="text-sm font-medium" data-testid="payout-cta-cooldown-age">Your last check was declined. You can start a new one {waitLabel(ageMe?.retryAfter ?? null)}.</p>}
        </div>
      )}

      {panel === "needs_name" && (
        <div className="space-y-2 rounded-2xl border border-border p-4" data-testid="payout-needs-name">
          <h2 className="flex items-center gap-2 font-semibold"><ShieldCheckIcon className="h-5 w-5 text-primary" aria-hidden />{status.awaitingName ? PAYOUT_COPY.waitingTitle : PAYOUT_COPY.needNameTitle}</h2>
          <p className="text-sm text-muted-foreground">{status.awaitingName ? PAYOUT_COPY.waitingBody : PAYOUT_COPY.needNameBody}</p>
          {cta === "link" && <Button asChild className="min-h-[44px] rounded-full" data-testid="payout-verify-name-cta"><Link href={VERIFY_NAME_HREF}>{PAYOUT_COPY.needNameCta}</Link></Button>}
          {cta === "paused" && <p role="status" className="text-sm font-medium" data-testid="payout-cta-paused">{AGE_COPY.payoutsPaused}</p>}
          {cta === "cooldown" && <p role="status" className="text-sm font-medium" data-testid="payout-cta-cooldown">Your last check was declined. You can start a new one {waitLabel(ageMe?.retryAfter ?? null)}.</p>}
          {cta === "in_review" && (
            <div role="status" className="space-y-1" data-testid="payout-cta-in-review">
              <p className="text-sm font-medium">{AGE_COPY.payoutsInReview}</p>
              <p className="text-sm text-muted-foreground">{AGE_COPY.payoutsInReviewBody}</p>
            </div>
          )}
        </div>
      )}

      {stage === "mismatch" && !changing && panel !== "needs_name" && (
        <div role="alert" className="space-y-2 rounded-2xl border border-destructive/60 p-4" data-testid="payout-mismatch">
          <h2 className="font-semibold">{PAYOUT_COPY.mismatchTitle}</h2>
          <p className="text-sm">{PAYOUT_COPY.mismatchBody}</p>
          <Link href={VERIFY_NAME_HREF} className="inline-flex min-h-[44px] items-center font-medium text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" data-testid="payout-recheck-cta">{PAYOUT_COPY.recheckCta}</Link>
        </div>
      )}

      {stage === "pending" && panel !== "needs_name" && (
        <div role="status" className="space-y-2 rounded-2xl border border-border p-4" data-testid="payout-pending">
          <h2 className="flex items-center gap-2 font-semibold"><ClockIcon className="h-5 w-5 text-primary" aria-hidden />{PAYOUT_COPY.pendingTitle}</h2>
          <p className="text-sm text-muted-foreground">{PAYOUT_COPY.pendingBody}</p>
        </div>
      )}

      {stage === "ready" && !changing && panel !== "needs_name" && <p className="text-sm text-muted-foreground" data-testid="payout-ready">{PAYOUT_COPY.readyBody}</p>}

      {stage === "setup" && panel !== "needs_name" && (
        <div className="space-y-2" data-testid="payout-setup">
          <p className="text-sm text-muted-foreground">{PAYOUT_COPY.setupBody}</p>
          <p className="text-sm text-muted-foreground">{PAYOUT_COPY.readyBody}</p>
        </div>
      )}

      {panel !== "needs_name" && (stage === "soon" || (stage === "mismatch" && !canLink)) && (
        <div role="status" className="space-y-2 rounded-2xl border border-border p-4" data-testid="payout-soon">
          <h2 className="flex items-center gap-2 font-semibold"><ClockIcon className="h-5 w-5 text-primary" aria-hidden />{PAYOUT_COPY.soonTitle}</h2>
          <p className="text-sm text-muted-foreground">{PAYOUT_COPY.soonBody}</p>
        </div>
      )}

      {/* The form only when the server takes an account from this page now; never in "setup" (no details to replace). */}
      {canLink && (stage === "none" || stage === "mismatch" || stage === "pending" || stage === "ready") && (panel !== "needs_name" || stage === "none") && (
        stage === "none" || stage === "mismatch" ? (
          <div className="space-y-3">
            {stage === "none" && (
              <div className="space-y-1">
                <h2 className="font-semibold">{PAYOUT_COPY.noneTitle}</h2>
                <p className="text-sm text-muted-foreground">{PAYOUT_COPY.noneBody}</p>
              </div>
            )}
            <AccountForm onSaved={onSaved} />
          </div>
        ) : changing ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{PAYOUT_COPY.changeNote}</p>
            <AccountForm onSaved={onSaved} onCancel={onCancel} autoFocus />
          </div>
        ) : (
          <Button ref={changeBtn} variant="outline" className="min-h-[44px] rounded-full" onClick={onChange} data-testid="button-change-payout-account">{PAYOUT_COPY.change}</Button>
        )
      )}
    </div>
  );
}
