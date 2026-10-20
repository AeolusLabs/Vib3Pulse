// Dev-only: the room money screens (phase 6) with no network. ?earn=empty|week|clawback|noaccount|mismatch|soon|attention picks the data,
// &page=earnings|payouts|payments the screen (mismatch opens on payouts), &theme=dark|light. Rendered from RoomFixture,
// which App.tsx loads only in development builds. A fake fetch is installed in a layout effect, before any child's
// effects start a request, and answers every money route; a save on the mismatch scene is refused with NAME_MISMATCH,
// on the others it succeeds with a new account (last four only). Receipt links open the real server route in a new tab.
import { useEffect, useLayoutEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import EarningsView from "@/components/rooms/earnings/EarningsView";
import PayoutAccountView from "@/components/rooms/earnings/PayoutAccountView";
import PaymentsView from "@/components/rooms/earnings/PaymentsView";
import {
  EARN_PAGES, FIXTURE_BANKS, FIXTURE_SAVED_STATUS, fixtureEarnings, fixturePayments, fixturePayoutStatus, type EarnPage, type EarnScene,
} from "@/components/rooms/earnings/earningsFixtures";
import { banksKey, paymentsKey, payoutStatusKey } from "@/lib/earningsApi";

const PAGE_LABEL: Record<EarnPage, string> = { earnings: "Earnings", payouts: "Get paid", payments: "Payments" };

export default function EarningsFixture({ scene, page: first, theme }: { scene: EarnScene; page: EarnPage; theme: "dark" | "light" }) {
  const qc = useQueryClient();
  useLayoutEffect(() => {
    // Drop anything the real app already cached for these routes (the rooms config is cached for 5 minutes), so every
    // screen here reads the fake answers below.
    const keys = [payoutStatusKey, banksKey, paymentsKey, ["/api/users/me/room-earnings"], ["/api/rooms/config"]];
    for (const key of keys) qc.removeQueries({ queryKey: key });
    const real = window.fetch;
    let status: unknown = fixturePayoutStatus(scene);
    const json = (body: unknown, code = 200, delay = 250) => new Promise<Response>((res) =>
      setTimeout(() => res(new Response(JSON.stringify(body), { status: code, headers: { "Content-Type": "application/json" } })), delay));
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const u = new URL(url, window.location.origin);
      const method = (init?.method ?? "GET").toUpperCase();
      const now = Date.now();
      if (u.pathname === "/api/csrf-token") return json({ csrfToken: "fixture" }, 200, 0);
      if (u.pathname === "/api/rooms/config") return json({ features: { paidRooms: true, spray: true }, limits: {}, currency: "NGN", region: "NG" }, 200, 0);
      if (u.pathname === "/api/rooms/payouts/status") return json(status);
      if (u.pathname === "/api/rooms/payouts/banks") return json(FIXTURE_BANKS);
      if (u.pathname === "/api/rooms/payouts/account" && method === "POST") {
        if (scene === "mismatch") return json({ code: "NAME_MISMATCH" }, 422, 900);
        status = FIXTURE_SAVED_STATUS;
        return json(FIXTURE_SAVED_STATUS, 200, 900);
      }
      if (u.pathname === "/api/users/me/room-earnings") return json(fixtureEarnings(scene, u.searchParams.get("range") ?? "week", now));
      if (u.pathname === "/api/users/me/room-payments") return json(fixturePayments(scene, u.searchParams.get("cursor"), now), 200, 400);
      return real(input, init);
    }) as typeof window.fetch;
    return () => {
      window.fetch = real;
      // The fixture's answers must not linger in the cache for the real pages.
      for (const key of keys) qc.removeQueries({ queryKey: key });
    };
  }, [scene, qc]);
  useEffect(() => {
    const root = document.documentElement;
    const was = root.classList.contains("dark");
    root.classList.toggle("dark", theme === "dark");
    return () => { root.classList.toggle("dark", was); };
  }, [theme]);
  const [page, setPage] = useState<EarnPage>(first);
  return (
    <div className="min-h-screen bg-background font-sans text-foreground" data-testid="room-fixture" data-scene={`earn-${scene}-${page}`}>
      <main className="mx-auto max-w-lg space-y-6 px-4 py-4">
        <nav aria-label="Fixture screens" className="flex gap-2">
          {EARN_PAGES.map((p) => (
            <button key={p} type="button" aria-pressed={p === page} onClick={() => setPage(p)}
              className={`min-h-[44px] rounded-full border px-3 text-sm ${p === page ? "bg-primary text-primary-foreground" : "border-border"}`}>
              {PAGE_LABEL[p]}
            </button>
          ))}
        </nav>
        {page === "earnings" && <EarningsView />}
        {page === "payouts" && <PayoutAccountView />}
        {page === "payments" && <PaymentsView />}
      </main>
    </div>
  );
}
