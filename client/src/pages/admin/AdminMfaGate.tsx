import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ShieldIcon, Loader2Icon } from "@/components/ui/icons";

// Shown by AdminLayout instead of the page when a super-admin hasn't passed two-factor yet.
// The server enforces this on every route; this screen is just how a person gets through it.
type Props = { enrolled: boolean; onLogout: () => void };

export default function AdminMfaGate({ enrolled, onLogout }: Props) {
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/me"] });

  useEffect(() => {
    if (enrolled || setup || recoveryCodes) return;
    apiRequest("POST", "/api/admin/mfa/setup")
      .then((r) => r.json())
      .then(setSetup)
      .catch((e) => setError(e.message));
  }, [enrolled, setup, recoveryCodes]);

  const confirm = async () => {
    setBusy(true); setError(null);
    try {
      const r = await (await apiRequest("POST", "/api/admin/mfa/confirm", { code })).json();
      setRecoveryCodes(r.recoveryCodes);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const verify = async () => {
    setBusy(true); setError(null);
    try {
      await apiRequest("POST", "/api/admin/mfa/verify", useRecovery ? { recoveryCode: code } : { code });
      await finish();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const shell = (title: string, desc: string, body: React.ReactNode) => (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center p-4">
      <Card className="w-full max-w-md bg-slate-800/60 border-purple-500/20">
        <CardHeader className="text-center space-y-3">
          <div className="mx-auto w-14 h-14 bg-purple-600/20 rounded-full flex items-center justify-center"><ShieldIcon className="w-7 h-7 text-purple-400" /></div>
          <CardTitle className="text-xl text-white" data-testid="mfa-title">{title}</CardTitle>
          <CardDescription className="text-slate-400">{desc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {body}
          {error && <p role="alert" className="text-sm text-red-400" data-testid="mfa-error">{error}</p>}
          <Button variant="ghost" className="w-full text-slate-400" onClick={onLogout}>Sign out</Button>
        </CardContent>
      </Card>
    </div>
  );

  if (recoveryCodes) {
    return shell("Save your recovery codes", "Each code works once if you lose your phone. They won't be shown again.", (
      <>
        <ul className="grid grid-cols-2 gap-2 rounded-lg bg-slate-900/60 p-3 font-mono text-sm text-slate-200" data-testid="recovery-codes">
          {recoveryCodes.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} data-testid="checkbox-saved-codes" /> I've stored these somewhere safe
        </label>
        <Button className="w-full bg-purple-600 hover:bg-purple-700" disabled={!saved} onClick={finish} data-testid="button-mfa-done">Continue</Button>
      </>
    ));
  }

  if (!enrolled) {
    return shell("Set up two-factor authentication", "Super-admin accounts require an authenticator app (Google Authenticator, 1Password, Authy…).", (
      <>
        {!setup ? <div className="flex justify-center py-6"><Loader2Icon className="h-6 w-6 animate-spin text-purple-400" /></div> : (
          <>
            <img src={setup.qrDataUrl} alt="Scan with your authenticator app" className="mx-auto h-44 w-44 rounded bg-white p-1" data-testid="mfa-qr" />
            <p className="text-center text-xs text-slate-400">Can't scan? Enter this key: <span className="select-all font-mono text-slate-200" data-testid="mfa-secret">{setup.secret}</span></p>
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (/^\d{6}$/.test(code)) confirm(); }}>
              <Label htmlFor="mfa-code" className="text-slate-300">6-digit code from the app</Label>
              <Input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} className="bg-slate-700/50 border-slate-600 text-center text-lg tracking-[0.4em] text-white" data-testid="input-mfa-code" />
              <Button type="submit" className="w-full bg-purple-600 hover:bg-purple-700" disabled={busy || code.length !== 6} data-testid="button-mfa-confirm">Turn on two-factor</Button>
            </form>
          </>
        )}
      </>
    ));
  }

  return shell("Two-factor authentication", useRecovery ? "Enter one of your recovery codes." : "Enter the 6-digit code from your authenticator app.", (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (code) verify(); }}>
      <Input aria-label={useRecovery ? "Recovery code" : "Authenticator code"} inputMode={useRecovery ? "text" : "numeric"} autoComplete="one-time-code" maxLength={useRecovery ? 24 : 6} value={code} autoFocus
        onChange={(e) => setCode(useRecovery ? e.target.value : e.target.value.replace(/\D/g, ""))} className="bg-slate-700/50 border-slate-600 text-center text-lg tracking-widest text-white" data-testid="input-mfa-verify" />
      <Button type="submit" className="w-full bg-purple-600 hover:bg-purple-700" disabled={busy || (useRecovery ? code.length < 10 : code.length !== 6)} data-testid="button-mfa-verify">Verify</Button>
      <button type="button" className="w-full text-xs text-slate-400 underline" onClick={() => { setUseRecovery(!useRecovery); setCode(""); setError(null); }}>{useRecovery ? "Use my authenticator app instead" : "Use a recovery code"}</button>
    </form>
  ));
}
