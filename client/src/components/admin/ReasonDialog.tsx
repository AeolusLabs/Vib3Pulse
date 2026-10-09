import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2Icon } from "@/components/ui/icons";

// Every admin mutation needs a written reason (the server enforces it and audits it). One dialog
// for all of them so the wording and the minimum length stay consistent.
type Props = {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  destructive?: boolean;
  minLength?: number;
  busy?: boolean;
  error?: string | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
};

export default function ReasonDialog({ open, title, description, confirmLabel, destructive, minLength = 5, busy, error, onConfirm, onClose }: Props) {
  const [reason, setReason] = useState("");
  useEffect(() => { if (open) setReason(""); }, [open]);
  const ok = reason.trim().length >= minLength;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="border-slate-700 bg-slate-800 text-white sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription className="text-slate-400">{description}</DialogDescription>}
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); if (ok && !busy) onConfirm(reason.trim()); }} className="space-y-3">
          <Label htmlFor="reason-text" className="text-slate-300">Reason (recorded in the audit log{title.toLowerCase().includes("host") || /strike|ban|warn|reject|hide|remove|edit/i.test(title) ? " and shown to the host" : ""})</Label>
          <Textarea id="reason-text" rows={4} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus className="border-slate-600 bg-slate-700/50 text-white" data-testid="input-reason" />
          <p className="text-xs text-slate-500">{reason.trim().length}/{minLength} characters minimum</p>
          {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} className="text-slate-300">Cancel</Button>
            <Button type="submit" disabled={!ok || busy} className={destructive ? "bg-red-600 hover:bg-red-700" : "bg-purple-600 hover:bg-purple-700"} data-testid="button-confirm-reason">
              {busy && <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />}{confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
