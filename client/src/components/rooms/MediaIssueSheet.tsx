// Board 11 "Mic blocked", for the camera too: a bottom sheet that says what happened and what to do next. The room carries on.
import { useEffect, useRef } from "react";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { CameraIcon, MicIcon } from "@/components/ui/icons";
import RoomSheetContent from "@/components/rooms/shell/RoomSheetContent";
import { MEDIA_ISSUE_COPY, type MediaIssue } from "@/lib/mediaIssues";

interface Props {
  issue: MediaIssue | null;
  onTryAgain(): void;
  onClose(): void;
  /** Where focus goes when the sheet closes (the control that failed). */
  returnFocusTo?: () => HTMLElement | null;
}

export default function MediaIssueSheet({ issue, onTryAgain, onClose, returnFocusTo }: Props) {
  const first = useRef<HTMLButtonElement>(null);
  const key = issue ? `${issue.device}:${issue.reason}` : "";
  useEffect(() => { if (issue) requestAnimationFrame(() => first.current?.focus()); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const c = issue ? MEDIA_ISSUE_COPY[issue.device][issue.reason] : null;
  const Icon = issue?.device === "camera" ? CameraIcon : MicIcon;
  return (
    <Sheet open={!!issue} onOpenChange={(o) => { if (!o) onClose(); }}>
      <RoomSheetContent side="bottom" className="max-h-[90vh] overflow-y-auto rounded-t-2xl" returnFocusTo={returnFocusTo} data-testid="media-issue-sheet" data-device={issue?.device} data-reason={issue?.reason}>
        {c && (
          <div className="grid gap-3">
            <SheetHeader className="space-y-1.5 text-left">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground" aria-hidden><Icon className="h-6 w-6" /></div>
              <SheetTitle>{c.title}</SheetTitle>
              <SheetDescription role="alert">{c.body}</SheetDescription>
            </SheetHeader>
            <Button ref={first} className="min-h-[48px] rounded-full" onClick={onTryAgain} data-testid="media-issue-retry">{c.primary}</Button>
            <Button variant="outline" className="min-h-[48px] rounded-full" onClick={onClose} data-testid="media-issue-dismiss">{issue?.device === "mic" ? "Keep listening" : "Not now"}</Button>
          </div>
        )}
      </RoomSheetContent>
    </Sheet>
  );
}
