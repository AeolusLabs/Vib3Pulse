import { useState } from "react";
import { AlertTriangle, Info, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import CodeBoxes from "./CodeBoxes";

export type RedeemResult = { ok: true } | { ok: false; reason?: string; message: string };
export type StaffSecret = { pin: string } | { code: string };

const NAME_KEY = "vp_staff_name";
const readName = () => { try { return localStorage.getItem(NAME_KEY) ?? ""; } catch { return ""; } };
const saveName = (n: string) => { try { localStorage.setItem(NAME_KEY, n); } catch { /* the name just is not remembered */ } };

/** Plain-language messages for each way a code can fail, so staff know what to do next. */
export function friendlyRedeemError(reason: string | undefined, message: string, viaLink = false): string {
  switch (reason) {
    case "invalid": return viaLink ? "This link is not valid any more. Ask the organiser for a new one." : "Wrong code. Check the 6 digits and try again.";
    case "revoked": return "This code was cancelled by the organiser. Ask them for a new one.";
    case "expired": return "This code has expired. Ask the organiser for a new one.";
    case "in_use": return "This code is already in use on another phone. Ask the organiser for a new one.";
    case "locked": return "Too many wrong tries. Wait a few minutes, then try again.";
    default: return message || "Could not sign in. Check your connection and try again.";
  }
}

interface StaffLoginProps {
  /** Shown when we already know which event this link is for. */
  eventTitle?: string;
  /** "link": the organiser's link carried the code, so only a name is needed. */
  linkCode?: string;
  onRedeem: (name: string, secret: StaffSecret) => Promise<RedeemResult>;
  onOrganiser?: () => void;
}

/** Door staff sign-in: your name and the 6-digit code from the organiser, valid for one night only. */
export default function StaffLogin({ eventTitle, linkCode, onRedeem, onOrganiser }: StaffLoginProps) {
  const [name, setName] = useState(readName);
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = name.trim().length > 0 && (linkCode ? true : pin.length === 6);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || loading) return;
    setLoading(true);
    setError(null);
    const result = await onRedeem(name.trim(), linkCode ? { code: linkCode } : { pin });
    if (result.ok) {
      saveName(name.trim());
    } else {
      setError(friendlyRedeemError(result.reason, result.message, !!linkCode));
      setPin("");
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col bg-background" data-testid="staff-login">
      <form onSubmit={submit} className="mx-auto flex w-full max-w-md flex-1 flex-col gap-5 px-5 pb-6 pt-10">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Door check-in</p>
          <h1 className="mt-1.5 font-serif text-4xl font-bold leading-[1.05]">Start checking in guests</h1>
          {eventTitle && <p className="mt-2 inline-block rounded-full border bg-card px-3 py-1 text-sm font-medium" data-testid="text-login-event">{eventTitle}</p>}
        </div>
        <p className="text-muted-foreground">
          {linkCode ? "Your organiser's link is ready. Enter your name to start scanning." : "Enter your name and the 6-digit code from your organiser. The code works for one night only."}
        </p>

        <div>
          <label htmlFor="staff-name" className="mb-1.5 block text-[13px] font-medium">Your name</label>
          <Input id="staff-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Maria" autoComplete="name" className="h-[52px] text-[17px]" data-testid="input-staff-name" />
        </div>

        {!linkCode && (
          <div>
            <label className="mb-1.5 block text-[13px] font-medium">6-digit code</label>
            <CodeBoxes value={pin} onChange={(v) => { setPin(v); setError(null); }} disabled={loading} invalid={!!error} />
          </div>
        )}

        {error && (
          <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-destructive/50 bg-destructive/5 px-3.5 py-3 text-sm text-destructive" data-testid="login-error">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />{error}
          </div>
        )}

        <p className="flex items-start gap-2 text-[13px] text-muted-foreground"><Info className="mt-0.5 h-4 w-4 flex-none" />Lost your code? Ask the organiser for a new one. They can cancel old codes at any time.</p>

        <div className="flex-1" />
        <Button type="submit" className="h-12 w-full text-base font-semibold" disabled={!ready || loading} data-testid="button-staff-login">
          {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Start scanning
        </Button>
        {onOrganiser && (
          <button type="button" onClick={onOrganiser} className="min-h-[44px] text-sm text-muted-foreground">I'm the organiser</button>
        )}
      </form>
    </div>
  );
}
