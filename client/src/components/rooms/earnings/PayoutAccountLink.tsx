import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon } from "@/components/ui/icons";
import { fetchPayoutStatus, payoutStatusKey } from "@/lib/earningsApi";
import { useRoomsConfig } from "@/lib/roomsApi";
import { PAYOUT_LINK_COPY, moneyFlagsOn, payoutLinkVisible } from "./earningsUi";

/** Account settings row to /rooms/payouts. Silent (renders nothing, and asks nothing) unless paid rooms or spray is on and the payout status answers 200. */
export default function PayoutAccountLink() {
  const config = useRoomsConfig();
  const moneyOn = moneyFlagsOn(config.data?.features);
  const q = useQuery({ queryKey: payoutStatusKey, queryFn: fetchPayoutStatus, retry: false, staleTime: 60_000, enabled: moneyOn });
  if (!moneyOn || !payoutLinkVisible(q.data)) return null;
  return (
    <Link
      href="/rooms/payouts"
      className="flex min-h-[56px] items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-card-foreground shadow-sm transition-colors hover:border-primary/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      data-testid="link-payout-account"
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium">{PAYOUT_LINK_COPY.title}</span>
        <span className="block text-xs text-muted-foreground">{PAYOUT_LINK_COPY.help}</span>
      </span>
      <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
    </Link>
  );
}
