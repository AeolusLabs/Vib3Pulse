import { useState } from "react";
import { Link } from "wouter";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { BellIcon, ChevronRightIcon, CreditCardIcon, LockIcon, MapPinIcon, MicIcon, SearchIcon, ShieldCheckIcon, ShieldIcon, SparklesIcon, UserIcon } from "@/components/ui/icons";

// One home for every setting: grouped rows, each with a line saying what is inside. A row opens one short screen.
const A = "/account/settings?section=";
const GROUPS = [
  { label: "You", rows: [
    { href: "/avatar", icon: UserIcon, title: "Profile and avatar", sub: "Your avatar and profile photo" },
    { href: `${A}account`, icon: LockIcon, title: "Account and sign in", sub: "Password, username, delete account" },
    { href: `${A}notifications`, icon: BellIcon, title: "Notifications", sub: "Push alerts on this device" },
  ] },
  { label: "Privacy and safety", rows: [
    { href: "/map?sharing=1", icon: MapPinIcon, title: "Map sharing", sub: "Who sees you on the map, including safety buddies" },
    { href: `${A}privacy`, icon: ShieldIcon, title: "Privacy and blocked people", sub: "Who sees your events and rooms" },
    { href: "/buddy/settings", icon: ShieldCheckIcon, title: "Safety buddies", sub: "Buddies, timers and alerts" },
    { href: `${A}verify`, icon: ShieldCheckIcon, title: "Name and Age review and payouts", sub: "Name and Age review, link a payout account" },
  ] },
  { label: "Rooms and money", rows: [
    { href: "/settings/hosting", icon: MicIcon, title: "Hosting defaults", sub: "What every new room starts with" },
    { href: "/settings/spray", icon: SparklesIcon, title: "Spray effects and saved card", sub: "Saved card, quiet effects" },
    { href: "/rooms/payouts", icon: CreditCardIcon, title: "Get paid", sub: "ID, bank account and payouts for spray and tickets" },
  ] },
  { label: "Help", rows: [
    { href: "/privacy", icon: ShieldIcon, title: "Privacy policy", sub: "How we handle your data" },
  ] },
];

export default function SettingsPage() {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const groups = GROUPS.map((g) => ({ ...g, rows: g.rows.filter((r) => !needle || `${r.title} ${r.sub}`.toLowerCase().includes(needle)) })).filter((g) => g.rows.length);

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />
      <main className="mx-auto max-w-2xl px-4 py-6">
        <h1 className="mb-4 font-serif text-4xl font-medium tracking-tight">Settings</h1>
        <label className="mb-6 flex h-11 items-center gap-2.5 rounded-full border bg-card px-4">
          <SearchIcon className="h-[18px] w-[18px] text-muted-foreground" aria-hidden />
          <input
            value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search settings" aria-label="Search settings"
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground" data-testid="input-settings-search"
          />
        </label>
        {groups.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Nothing matches "{q}".</p>}
        {groups.map((g) => (
          <section key={g.label} className="mb-6" aria-label={g.label}>
            <h2 className="mb-2 px-1 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">{g.label}</h2>
            <ul className="divide-y overflow-hidden rounded-2xl border bg-card">
              {g.rows.map(({ href, icon: Icon, title, sub }) => (
                <li key={href}>
                  <Link href={href} className="flex min-h-[60px] items-center gap-3.5 px-3.5 py-2 transition-transform active:scale-[0.985] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary motion-reduce:transition-none" data-testid={`settings-row-${title.toLowerCase().replace(/\W+/g, "-")}`}>
                    <Icon className="h-[22px] w-[22px] shrink-0 text-primary" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block text-base font-medium leading-5">{title}</span>
                      <span className="block truncate text-[13px] leading-[18px] text-muted-foreground">{sub}</span>
                    </span>
                    <ChevronRightIcon className="h-[18px] w-[18px] shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>
      <BottomNavigation />
    </div>
  );
}
