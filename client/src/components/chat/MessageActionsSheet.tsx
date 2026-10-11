import { Copy, Reply, Trash2 } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import type { ChatMessage } from "./types";

interface MessageActionsSheetProps {
  message: ChatMessage | null;
  isOwn: boolean;
  onClose: () => void;
  onReply: (message: ChatMessage) => void;
  onDelete: (message: ChatMessage) => void;
}

const action =
  "flex min-h-[48px] w-full items-center gap-3 rounded-lg px-3 text-left font-medium transition-colors hover:bg-muted active:scale-[0.99] disabled:opacity-50";

/** Tap a bubble to get these. Replaces the hover-only buttons, which could not be reached on a phone. */
export default function MessageActionsSheet({ message, isOwn, onClose, onReply, onDelete }: MessageActionsSheetProps) {
  const { toast } = useToast();

  const copy = async () => {
    if (!message?.content) return;
    try {
      await navigator.clipboard.writeText(message.content);
      toast({ title: "Copied" });
    } catch {
      toast({ title: "Couldn't copy", description: "Select the text and copy it instead." });
    }
    onClose();
  };

  return (
    <Sheet open={!!message} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="bottom" className="rounded-t-2xl px-3 pb-6 pt-2" data-testid="sheet-message-actions">
        <SheetHeader className="sr-only">
          <SheetTitle>Message options</SheetTitle>
          <SheetDescription>Reply to, copy or delete this message</SheetDescription>
        </SheetHeader>
        <div className="mx-auto mb-3 mt-1 h-1 w-10 rounded-full bg-border" aria-hidden="true" />
        {message && (
          <div className="flex flex-col">
            <button type="button" className={action} onClick={() => { onReply(message); onClose(); }} data-testid="action-reply">
              <Reply className="h-5 w-5" />Reply
            </button>
            {!!message.content && (
              <button type="button" className={action} onClick={copy} data-testid="action-copy">
                <Copy className="h-5 w-5" />Copy text
              </button>
            )}
            {isOwn && (
              <button type="button" className={`${action} text-destructive`} onClick={() => { onDelete(message); onClose(); }} data-testid="action-delete">
                <Trash2 className="h-5 w-5" />Delete for everyone
              </button>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
