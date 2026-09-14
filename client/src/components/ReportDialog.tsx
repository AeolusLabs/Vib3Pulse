import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const REPORT_REASONS = [
  { value: "spam", label: "Spam" },
  { value: "harassment", label: "Harassment or bullying" },
  { value: "hate_speech", label: "Hate speech" },
  { value: "misinformation", label: "Misinformation" },
  { value: "inappropriate", label: "Inappropriate content" },
  { value: "other", label: "Other" },
];

interface ReportDialogProps {
  open: boolean;
  onClose: () => void;
  endpoint: string;
  itemLabel?: string;
}

export default function ReportDialog({ open, onClose, endpoint, itemLabel = "content" }: ReportDialogProps) {
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [description, setDescription] = useState("");

  const reportMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest("POST", endpoint, { reason, description: description.trim() || undefined });
    },
    onSuccess: () => {
      toast({ title: "Report submitted", description: `Thanks for helping keep the community safe.` });
      handleClose();
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error?.message || "Failed to submit report. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleClose = () => {
    setReason("");
    setDescription("");
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Report {itemLabel}</DialogTitle>
          <DialogDescription>
            Let us know what's wrong. Our moderation team will review it.
          </DialogDescription>
        </DialogHeader>

        <RadioGroup value={reason} onValueChange={setReason} className="gap-2.5 py-1">
          {REPORT_REASONS.map((r) => (
            <div key={r.value} className="flex items-center gap-2.5">
              <RadioGroupItem value={r.value} id={`report-reason-${r.value}`} />
              <Label htmlFor={`report-reason-${r.value}`} className="font-normal cursor-pointer">
                {r.label}
              </Label>
            </div>
          ))}
        </RadioGroup>

        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Additional details (optional)"
          rows={3}
          maxLength={500}
          className="resize-none"
          data-testid="input-report-description"
        />

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} data-testid="button-cancel-report">
            Cancel
          </Button>
          <Button
            onClick={() => reportMutation.mutate()}
            disabled={!reason || reportMutation.isPending}
            data-testid="button-submit-report"
          >
            Submit report
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
