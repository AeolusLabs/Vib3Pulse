import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { ensureCsrfToken } from "@/lib/queryClient";

/** Thrown by `start` callers' mutations when nothing more should be shown (the user said no, or the toast was already shown). */
export class DmHandled extends Error {}

interface Warning { message: string; otherIs: "minor" | "adult" }

async function postDirect(userId: string, acknowledgeAgeGap: boolean) {
  const token = await ensureCsrfToken();
  const res = await fetch("/api/conversations/direct", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json", "x-csrf-token": token },
    body: JSON.stringify({ userId, ...(acknowledgeAgeGap ? { acknowledgeAgeGap: true } : {}) }),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

/**
 * Starts (or opens) a direct conversation. Between an adult and an under-18 the server first answers with a warning;
 * this shows it to the person who is starting the chat and only continues if they choose to. Returns null when the chat
 * wasn't started (they backed out, or the other side's settings don't allow it: an explanation toast is shown).
 */
export function useDirectMessage() {
  const { toast } = useToast();
  const [warning, setWarning] = useState<Warning | null>(null);
  const answer = useRef<((go: boolean) => void) | null>(null);

  const ask = (w: Warning) => new Promise<boolean>((resolve) => { answer.current = resolve; setWarning(w); });
  const settle = (go: boolean) => { const r = answer.current; answer.current = null; setWarning(null); r?.(go); };

  const start = useCallback(async (userId: string): Promise<{ id: string } | null> => {
    let r = await postDirect(userId, false);
    if (r.status === 409 && r.json?.code === "AGE_GAP_WARNING") {
      if (!(await ask({ message: r.json.message, otherIs: r.json.otherIs }))) return null;
      r = await postDirect(userId, true);
    }
    if (r.status >= 200 && r.status < 300) return r.json;
    toast({ title: "Can't start this chat", description: r.json?.message ?? "Please try again.", variant: "destructive" });
    return null;
  }, [toast]); // eslint-disable-line react-hooks/exhaustive-deps

  const dialog: ReactNode = (
    <AlertDialog open={warning !== null} onOpenChange={(o) => { if (!o) settle(false); }}>
      <AlertDialogContent data-testid="age-gap-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{warning?.otherIs === "minor" ? "This person is under 18" : "This person is an adult"}</AlertDialogTitle>
          <AlertDialogDescription>{warning?.message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-age-gap-cancel">Don't message</AlertDialogCancel>
          <AlertDialogAction onClick={() => settle(true)} data-testid="button-age-gap-continue">Message anyway</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { start, dialog };
}
