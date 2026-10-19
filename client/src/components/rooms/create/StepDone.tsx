import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckIcon, CopyIcon, Share2Icon } from "@/components/ui/icons";
import { useToast } from "@/hooks/use-toast";
import { COPY } from "@/lib/createRoomWizardUi";

interface Props {
  /** The Done screen's line for this outcome (DONE_COPY): live, made but not live, scheduled, scheduled invite room. */
  body: string;
  /** Why the room did not go live, when the start was refused. */
  note?: string | null;
  url: string;
  /** Invite rooms: the token is in the link and is shown once. */
  inviteOnce: boolean;
  title: string;
}

/** The body of the Done screen. "Go to room" is the wizard footer's main button. */
export default function StepDone({ body, note, url, inviteOnce, title }: Props) {
  const { toast } = useToast();
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); toast({ title: COPY.copied }); }
    catch { toast({ title: COPY.copyFailed, variant: "destructive" }); }
  };
  // Browsers without a share sheet (most desktops) copy the link instead.
  const share = async () => {
    if (typeof navigator.share !== "function") return copy();
    try { await navigator.share({ title, url }); }
    catch (e) { if ((e as { name?: string })?.name !== "AbortError") void copy(); } // closing the share sheet is not a failure
  };
  return (
    <div className="space-y-5">
      <div className="grid justify-items-center gap-3 pt-4 text-center">
        <span className="grid h-16 w-16 place-items-center rounded-full bg-primary text-primary-foreground" aria-hidden><CheckIcon className="h-8 w-8" /></span>
        <p className="text-sm text-muted-foreground" data-testid="text-done-body">{body}</p>
        {note && <p className="text-sm text-muted-foreground" data-testid="text-done-note">{note}</p>}
      </div>
      <div className="space-y-2">
        <label htmlFor="wiz-done-link" className="text-sm font-medium">{COPY.doneLinkLabel}</label>
        <Input id="wiz-done-link" readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="h-11 text-[16px]" data-testid="input-invite-link" />
        {inviteOnce && <p className="text-sm text-muted-foreground">{COPY.doneInviteOnce}</p>}
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button type="button" variant="outline" className="min-h-[44px] rounded-full" onClick={copy} data-testid="button-copy-invite">
          <CopyIcon className="mr-2 h-4 w-4" aria-hidden />{COPY.copy}
        </Button>
        <Button type="button" variant="outline" className="min-h-[44px] rounded-full" onClick={share} data-testid="button-share-room">
          <Share2Icon className="mr-2 h-4 w-4" aria-hidden />{COPY.share}
        </Button>
      </div>
    </div>
  );
}
