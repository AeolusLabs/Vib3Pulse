import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2Icon } from "@/components/ui/icons";
import { apiRequest, queryClient } from "@/lib/queryClient";

type Props = { open: boolean; onClose: () => void; onVerified: () => void };

// Two steps: number -> 6-digit text-message code. The server owns every limit (cooldown, attempts,
// per-number caps); this only shows what it says.
export default function PhoneVerifyDialog({ open, onClose, onVerified }: Props) {
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setStep("phone"); setPhone(""); setCode(""); setError(null); setBusy(false); };
  const close = () => { reset(); onClose(); };

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiRequest("POST", "/api/auth/phone/request", { phone });
      setStep("code");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiRequest("POST", "/api/auth/phone/verify", { code });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/phone/status"] });
      reset();
      onVerified();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Verify your phone number</DialogTitle>
          <DialogDescription>
            Public events need a verified number. It helps keep fake and scam events off Vib3Pulse. We never show it to guests.
          </DialogDescription>
        </DialogHeader>

        {step === "phone" ? (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (phone.trim()) send(); }}>
            <div className="space-y-2">
              <Label htmlFor="pv-phone">Mobile number</Label>
              <Input id="pv-phone" type="tel" inputMode="tel" autoComplete="tel" className="min-h-[44px]" placeholder="+44 7700 900123" value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="input-verify-phone" />
              <p className="text-xs text-muted-foreground">Include the country code, like +44 or +234.</p>
            </div>
            {error && <p role="alert" className="text-sm text-destructive" data-testid="phone-error">{error}</p>}
            <Button type="submit" className="min-h-[48px] w-full rounded-full" disabled={busy || !phone.trim()} data-testid="button-send-code">
              {busy && <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />}Text me a code
            </Button>
          </form>
        ) : (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (code.length === 6) verify(); }}>
            <div className="space-y-2">
              <Label htmlFor="pv-code">6-digit code</Label>
              <Input id="pv-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="min-h-[48px] text-center text-xl tracking-[0.4em]" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} data-testid="input-verify-code" />
              <p className="text-xs text-muted-foreground">Sent to {phone}. It expires in 10 minutes.</p>
            </div>
            {error && <p role="alert" className="text-sm text-destructive" data-testid="phone-error">{error}</p>}
            <Button type="submit" className="min-h-[48px] w-full rounded-full" disabled={busy || code.length !== 6} data-testid="button-verify-code">
              {busy && <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />}Verify
            </Button>
            <Button type="button" variant="ghost" className="w-full rounded-full" onClick={() => { setStep("phone"); setCode(""); setError(null); }}>Use a different number</Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
