// Board 7 "Spray tray" (img/f-spraytray). Naira price and V3C on every tier, the room limit and the card always in view.
// The tray only exists for a viewer the server sent a spray block to (an ID-verified adult in a live 18+ room); the
// tiles mirror the limits for the UI, and the server checks every one of them again.
// Artwork is an abstract game token in the theme's violet and amber: no currency sign, no denomination, no banknote look.
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SPRAY_TIERS, formatV3c, type SprayTier } from "@shared/money";
import { sprayPrice } from "@shared/spray";
import { AMBER } from "@/lib/roomTickets";
import NonRefundableNotice from "./NonRefundableNotice";
import { SPRAY_COPY, TIER_LINE, cardInSentence, cardLabel, tileAction, type SprayBlock, type SprayMe } from "@/lib/sprayUi";

/** A small drawing of each tier for the tray and the confirm step. Decorative. */
export function TierMark({ tier, className = "h-10 w-14" }: { tier: SprayTier; className?: string }) {
  return (
    <svg viewBox="0 0 56 40" className={className} aria-hidden focusable="false" data-testid={`tier-mark-${tier}`}>
      {tier === "note" && (
        // A game ticket (about 1.6:1), not a banknote: flat fill, one V3 disc.
        <g>
          <rect x="10" y="6" width="36" height="23" rx="6" className="fill-primary" />
          <circle cx="30" cy="17.5" r="7" className="fill-primary-foreground" opacity="0.9" />
          <text x="30" y="20.5" textAnchor="middle" fontSize="7" fontWeight="700" className="fill-primary">V3</text>
        </g>
      )}
      {tier === "bundle" && (
        <g>
          <rect x="8" y="14" width="40" height="20" rx="3" className="fill-primary" opacity="0.55" />
          <rect x="6" y="9" width="40" height="20" rx="3" className="fill-primary" />
          <rect x="22" y="7" width="8" height="24" rx="1.5" className="fill-secondary" />
        </g>
      )}
      {tier === "bag" && (
        <g>
          <path d="M18 12 a10 9 0 0 1 20 0" fill="none" strokeWidth="3.5" className="stroke-primary" />
          <rect x="6" y="12" width="44" height="22" rx="6" className="fill-primary" />
          <rect x="12" y="15" width="32" height="2.5" rx="1" className="fill-secondary" />
          <circle cx="28" cy="25" r="5" className="fill-secondary" />
        </g>
      )}
      {tier === "rain" && (
        <g>
          <ellipse cx="28" cy="12" rx="18" ry="7" className="fill-primary" />
          <rect x="15" y="24" width="7" height="4" rx="1" className="fill-secondary" />
          <rect x="26" y="28" width="7" height="4" rx="1" className="fill-secondary" />
          <rect x="36" y="23" width="7" height="4" rx="1" className="fill-secondary" />
        </g>
      )}
    </svg>
  );
}

interface Props {
  block: SprayBlock;
  me: SprayMe | null;
  meError: boolean;
  onRetryMe(): void;
  /** People who can be sprayed now: the host first, then the stage. */
  targets: { id: string; name: string }[];
  targetId: string;
  onTarget(id: string): void;
  online: boolean;
  onPick(tier: SprayTier): void;
  onLimits(): void;
  quiet: boolean;
  onQuiet(on: boolean): void;
  onDone(): void;
}

export default function SprayTray({ block, me, meError, onRetryMe, targets, targetId, onTarget, online, onPick, onLimits, quiet, onQuiet, onDone }: Props) {
  const target = targets.find((t) => t.id === targetId);
  const card = cardLabel(me?.method ?? null);
  return (
    <div className="grid gap-3" data-testid="spray-tray">
      <SheetHeader className="space-y-1 text-left">
        <SheetTitle>Spray {target?.name ?? "someone"}</SheetTitle>
        <SheetDescription>{SPRAY_COPY.trayIntro}</SheetDescription>
      </SheetHeader>
      <NonRefundableNotice />

      {targets.length > 1 && (
        // Plain toggle buttons (aria-pressed) in a labelled group: Tab reaches each one, no roving focus needed (review M14).
        <div className="flex gap-2 overflow-x-auto [scrollbar-width:none]" role="group" aria-label="Who to spray" data-testid="spray-targets">
          {targets.map((t) => (
            <button key={t.id} type="button" aria-pressed={t.id === targetId} onClick={() => onTarget(t.id)}
              className={`min-h-[44px] shrink-0 rounded-full border px-4 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${t.id === targetId ? "border-primary bg-primary text-primary-foreground" : "border-border bg-muted"}`}
              data-testid={`spray-target-${t.id}`}>{t.name}</button>
          ))}
        </div>
      )}

      {meError && (
        <div role="alert" className="flex items-center justify-between gap-2 rounded-xl border border-destructive/50 bg-destructive/10 p-3 text-sm" data-testid="spray-me-error">
          <span>Couldn't load your card and limits.</span>
          <Button variant="outline" className="min-h-[44px]" onClick={onRetryMe}>{SPRAY_COPY.tryAgain}</Button>
        </div>
      )}

      <ul className="grid gap-2" data-testid="spray-tiles">
        {SPRAY_TIERS.map((tier) => {
          const p = sprayPrice(tier);
          const a = tileAction(tier, block, me, online);
          const blocked = a.kind === "blocked";
          return (
            <li key={tier}>
              {/* aria-disabled, not disabled: a blocked tile stays focusable so screen readers reach its reason (review M13). */}
              <button type="button" aria-disabled={blocked || undefined} onClick={() => { if (!blocked) onPick(tier); }}
                aria-describedby={blocked ? `spray-why-${tier}` : undefined}
                className="flex min-h-[64px] w-full items-center gap-3 rounded-2xl border border-border bg-muted/60 px-3 py-2 text-left aria-disabled:cursor-not-allowed aria-disabled:opacity-50 [@media(hover:hover)_and_(pointer:fine)]:hover:border-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary motion-safe:transition-transform motion-safe:active:scale-[0.98]"
                data-testid={`spray-tile-${tier}`} data-action={a.kind}>
                <TierMark tier={tier} />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{p.label} · {p.display}</span>
                  <span className="block text-xs text-muted-foreground">{formatV3c(p.v3c)} · {TIER_LINE[tier]}</span>
                  {blocked && <span id={`spray-why-${tier}`} className="block text-xs text-destructive">{a.reason}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center justify-between gap-2">
        <Button className="min-h-[44px] rounded-full px-6" onClick={onDone} data-testid="spray-done">{SPRAY_COPY.done}</Button>
      </div>

      {/* The whole 44 px row toggles the switch (the switch itself is smaller), review M15. */}
      <div className="flex min-h-[44px] items-center justify-between gap-2 text-sm">
        <label htmlFor="spray-quiet" className="flex min-h-[44px] min-w-0 flex-1 cursor-pointer flex-col justify-center">
          <span className="block font-medium">{SPRAY_COPY.quietLabel}</span>
          <span className="block text-xs text-muted-foreground">{SPRAY_COPY.quietHint}</span>
        </label>
        <label htmlFor="spray-quiet" className="flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center">
          <Switch id="spray-quiet" checked={quiet} onCheckedChange={onQuiet} data-testid="spray-quiet" />
        </label>
      </div>

      <p className="text-xs text-muted-foreground" data-testid="spray-card-line">
        {card ? `Paying with ${cardInSentence(card)}. ` : "No card saved. Your bank asks you to add one the first time. "}
        <button type="button" onClick={onLimits} className="min-h-[44px] font-medium text-primary underline-offset-2 hover:underline" data-testid="spray-open-limits">{SPRAY_COPY.openLimits}</button>
      </p>
    </div>
  );
}
