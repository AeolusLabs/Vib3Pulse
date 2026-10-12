import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { isCompleteShortCode, normalizeShortCode } from "@shared/ticketCode";

/** Fallback when a QR will not scan: type the short code printed under it. Dashes are added as you type. */
export default function ManualCodeSheet({ open, onOpenChange, onSubmit, busy }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (code: string) => void;
  busy: boolean;
}) {
  const [text, setText] = useState("");
  useEffect(() => { if (!open) setText(""); }, [open]);

  const hex = normalizeShortCode(text).slice(0, 8);
  const shown = hex.length > 4 ? `${hex.slice(0, 4)}-${hex.slice(4)}`.toUpperCase() : hex.toUpperCase();
  const ready = isCompleteShortCode(hex);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-2xl px-4 pb-6" data-testid="sheet-manual-code">
        <SheetHeader className="text-left">
          <SheetTitle className="font-serif text-2xl">Type a code</SheetTitle>
          <SheetDescription>Use this when a QR will not scan. Type the short code printed under it.</SheetDescription>
        </SheetHeader>
        <form className="mt-4 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) onSubmit(hex); }}>
          <Input
            autoFocus
            value={shown}
            onChange={(e) => setText(e.target.value)}
            placeholder="A3F9-12BC"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            aria-label="Ticket code"
            className="h-14 text-center font-mono text-2xl tracking-[0.14em]"
            data-testid="input-manual-code"
          />
          <p className="text-[13px] text-muted-foreground">Letters A to F and numbers only. Dashes are added for you.</p>
          <Button type="submit" className="h-12 text-base font-semibold" disabled={!ready || busy} data-testid="button-manual-submit">
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Check ticket
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}
