// The Money section: Paid room and Spray switches with one readiness checklist. Used by the create wizard (Features step)
// and the Controls sheet. Always drawn while a platform money flag is on; a room that is not 18+/21+ sees it locked with the reason.
import { Link } from "wouter";
import { CheckIcon, CircleIcon, LockIcon } from "@/components/ui/icons";
import { MONEY_COPY, type MoneyView } from "@/lib/moneySection";
import { SwitchRow } from "./parts";

export interface MoneySectionProps {
  view: MoneyView;
  /** `set` omitted: the switch is shown but cannot be changed here (the Controls sheet; the price is set at creation). */
  paid: { on: boolean; set?(on: boolean): void; note?: string };
  spray: { on: boolean; set(on: boolean): void; busy?: boolean };
  /** A refusal from the server, in plain words. */
  error?: string | null;
  testPrefix?: string;
}

export default function StepSpray({ view, paid, spray, error = null, testPrefix = "money" }: MoneySectionProps) {
  if (!view.visible) return null;
  const locked = view.lockedReason !== null;
  const paidFixed = !paid.set && !locked && view.paid.available;
  // Turning a switch off is always allowed, even if the host is no longer ready to turn it on.
  const sprayReason = spray.busy ? "Saving" : spray.on && !locked ? undefined : locked || !view.spray.available ? view.spray.reason ?? undefined : undefined;
  const paidReason = paidFixed ? paid.note ?? MONEY_COPY.paidFixedInRoom : locked || !view.paid.available ? view.paid.reason ?? undefined : undefined;
  return (
    <section aria-labelledby={`${testPrefix}-title`} className="space-y-3 rounded-2xl border border-border p-3" data-testid={`${testPrefix}-section`}>
      <div>
        <h3 id={`${testPrefix}-title`} className="flex items-center gap-2 text-base font-semibold">
          {locked && <LockIcon className="h-4 w-4 text-muted-foreground" aria-hidden />}
          {MONEY_COPY.title}
        </h3>
        <p className="text-sm text-muted-foreground">{MONEY_COPY.intro}</p>
      </div>

      {locked && <p className="text-sm text-foreground" data-testid={`${testPrefix}-locked`}>{view.lockedReason}</p>}

      <SwitchRow
        id={`${testPrefix}-paid`} label={MONEY_COPY.paidLabel} help={MONEY_COPY.paidHelp} checked={paid.on && !locked}
        onChange={(v) => paid.set?.(v)} disabledReason={paidReason} quietReason={locked} testId="switch-room-paid"
      />
      <SwitchRow
        id={`${testPrefix}-spray`} label={MONEY_COPY.sprayLabel} help={MONEY_COPY.sprayHelp} checked={spray.on && !locked}
        onChange={spray.set} disabledReason={sprayReason} quietReason={locked} testId="switch-room-spray"
      />
      <p className="text-xs text-muted-foreground">{MONEY_COPY.sprayNote}</p>
      {error && <p role="alert" className="text-sm text-destructive" data-testid={`${testPrefix}-error`}>{error}</p>}

      {!locked && (
        <div>
          <h4 className="mb-1 text-sm font-semibold">{MONEY_COPY.checklistTitle}</h4>
          <ul className="space-y-1" data-testid={`${testPrefix}-checklist`}>
            {view.items.map((it) => (
              <li key={it.id} className="flex items-start gap-2 text-sm" data-testid={`${testPrefix}-item-${it.id}`} data-met={it.met}>
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center" aria-hidden>
                  {it.met ? <CheckIcon className="h-4 w-4 text-primary" /> : <CircleIcon className="h-4 w-4 text-muted-foreground" />}
                </span>
                <div className="min-w-0">
                  <p className="font-medium">{it.label}<span className="sr-only">{it.met ? `, ${MONEY_COPY.met}` : `, ${MONEY_COPY.unmet}`}</span></p>
                  {!it.met && it.why && <p className="text-muted-foreground">{it.why}</p>}
                  {!it.met && it.fix && (
                    <Link
                      href={it.fix.href}
                      className="inline-flex min-h-[44px] items-center font-medium text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      data-testid={`${testPrefix}-fix-${it.id}`}
                    >
                      {it.fix.label}
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
