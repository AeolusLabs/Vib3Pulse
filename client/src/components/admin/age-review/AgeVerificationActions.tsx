import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ShieldIcon } from "@/components/ui/icons";
import ReasonDialog from "@/components/admin/ReasonDialog";
import { useToast } from "@/hooks/use-toast";
import { errText, markVerified, revokeVerification } from "@/lib/adminAgeReviewApi";
import { canMarkVerified, canRevoke } from "@/lib/adminAgeReviewUi";

type Action = "verify" | "revoke" | null;

/** Admin user row control: mark verified or revoke, both with a written reason. Hidden for roles that may not do it. */
export default function AgeVerificationActions({ userId, username }: { userId: string; username: string }) {
  const { data: me } = useQuery<{ role: string }>({ queryKey: ["/api/admin/me"], retry: false });
  const { toast } = useToast();
  const [action, setAction] = useState<Action>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!me || !canRevoke(me.role)) return null;
  const mark = canMarkVerified(me.role);

  return (
    <>
      {mark && <Button size="sm" variant="ghost" className="min-h-[44px] text-emerald-400 hover:text-emerald-300" onClick={() => { setError(null); setAction("verify"); }} aria-label={`Mark ${username} as age verified`} data-testid={`button-mark-verified-${userId}`}>
        <ShieldIcon className="h-4 w-4" aria-hidden />
      </Button>}
      <Button size="sm" variant="ghost" className="min-h-[44px] text-xs text-slate-300 hover:text-white" onClick={() => { setError(null); setAction("revoke"); }} data-testid={`button-revoke-verification-${userId}`}>
        Revoke
      </Button>
      <ReasonDialog
        open={action !== null}
        title={action === "revoke" ? `Revoke verification for ${username}` : `Mark ${username} as age verified`}
        description={action === "revoke" ? "This clears the verified flag. Tipping, tickets and paid rooms stop for them." : "Use this only when you have seen proof. It is an override and is audited."}
        confirmLabel={action === "revoke" ? "Revoke" : "Mark verified"} destructive={action === "revoke"} minLength={3} maxLength={300} busy={busy} error={error}
        onClose={() => setAction(null)}
        onConfirm={async (reason) => {
          setBusy(true); setError(null);
          try {
            if (action === "revoke") await revokeVerification(userId, reason); else await markVerified(userId, true, reason);
            toast({ title: action === "revoke" ? "Verification revoked" : "Marked as verified" });
            setAction(null);
          } catch (e) { setError(errText(e)); } finally { setBusy(false); }
        }}
      />
    </>
  );
}
