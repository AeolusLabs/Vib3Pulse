import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { Avatar } from "./Avatar";
import { defaultAvatar } from "@shared/avatar";

const key = (userId: string) => `vp.avatarPrompt.dismissed.${userId}`;

// Storage can throw (private windows, blocked site data), so every access is guarded and the
// card still works for the session.
const wasDismissed = (userId: string) => { try { return localStorage.getItem(key(userId)) === "1"; } catch { return false; } };
const remember = (userId: string) => { try { localStorage.setItem(key(userId), "1"); } catch { /* session only */ } };

/** One dismissible card nudging users with no avatar to make one. Renders nothing otherwise. */
export default function AvatarPrompt() {
  const { data: user } = useAuth();
  // Dismissal is remembered per account, so someone else signing in on this device still sees the card.
  const [dismissedNow, setDismissedNow] = useState(false);
  if (!user || user.avatar || dismissedNow || wasDismissed(user.id)) return null;
  return (
    <section aria-label="Create your avatar" className="mb-5 flex items-center gap-4 rounded-2xl border bg-card p-4">
      <Avatar config={defaultAvatar()} mode="head" decorative className="w-16 shrink-0 rounded-xl bg-muted/50" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">Make your avatar</p>
        <p className="text-sm text-muted-foreground">It becomes your pin on the map and your picture across Vib3Pulse.</p>
      </div>
      <div className="flex shrink-0 flex-col gap-1.5">
        <Button asChild size="sm" className="min-h-11"><Link href="/avatar">Create</Link></Button>
        <Button size="sm" variant="ghost" className="min-h-11" onClick={() => { remember(user.id); setDismissedNow(true); }}>Not now</Button>
      </div>
    </section>
  );
}
