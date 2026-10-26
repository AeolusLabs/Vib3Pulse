import type { ReactNode } from "react";
import { Link } from "wouter";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Switch } from "@/components/ui/switch";

/** One settings topic: back link, title, content. */
export function SettingsShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />
      <main className="mx-auto max-w-2xl px-4 py-6">
        <Link href="/settings" className="mb-1 inline-flex min-h-[44px] items-center text-sm text-muted-foreground" data-testid="link-back-settings">Back to Settings</Link>
        <h1 className="mb-6 font-serif text-3xl font-medium tracking-tight">{title}</h1>
        {children}
      </main>
      <BottomNavigation />
    </div>
  );
}

export const GROUP = "mb-6 divide-y overflow-hidden rounded-2xl border bg-card";

/** A whole row is the tap target: label, one line of help, switch. */
export function SwitchRow({ title, sub, checked, disabled, onChange, testId }: { title: string; sub: string; checked: boolean; disabled?: boolean; onChange(v: boolean): void; testId: string }) {
  return (
    <label className={`flex min-h-[60px] items-center gap-3.5 px-3.5 py-2 ${disabled ? "opacity-60" : "cursor-pointer"}`}>
      <span className="min-w-0 flex-1">
        <span className="block text-base font-medium leading-5">{title}</span>
        <span className="block text-[13px] leading-[18px] text-muted-foreground">{sub}</span>
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={title} data-testid={testId} />
    </label>
  );
}
