import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ChartBar, Plus, X, Loader2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface CreatePollModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
}

export default function CreatePollModal({ open, onOpenChange, conversationId }: CreatePollModalProps) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const { toast } = useToast();

  const createPollMutation = useMutation({
    mutationFn: async (data: { question: string; options: string[]; allowMultiple: boolean }) => {
      const response = await apiRequest("POST", `/api/conversations/${conversationId}/polls`, data);
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Poll created!" });
      queryClient.invalidateQueries({ queryKey: ['/api/conversations', conversationId, 'messages'] });
      setQuestion("");
      setOptions(["", ""]);
      setAllowMultiple(false);
      onOpenChange(false);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create poll", variant: "destructive" });
    },
  });

  const addOption = () => {
    if (options.length < 10) {
      setOptions([...options, ""]);
    }
  };

  const removeOption = (index: number) => {
    if (options.length > 2) {
      setOptions(options.filter((_, i) => i !== index));
    }
  };

  const updateOption = (index: number, value: string) => {
    const newOptions = [...options];
    newOptions[index] = value;
    setOptions(newOptions);
  };

  const handleCreate = () => {
    const validOptions = options.filter((o) => o.trim());
    if (!question.trim()) {
      toast({ title: "Enter a question", variant: "destructive" });
      return;
    }
    if (validOptions.length < 2) {
      toast({ title: "Add at least 2 options", variant: "destructive" });
      return;
    }
    createPollMutation.mutate({
      question: question.trim(),
      options: validOptions,
      allowMultiple,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="modal-create-poll">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ChartBar className="h-5 w-5" />
            Create Poll
          </DialogTitle>
          <DialogDescription>
            Ask the group a question and let everyone vote
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="poll-question">Question</Label>
            <Input
              id="poll-question"
              placeholder="What should we do tonight?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              data-testid="input-poll-question"
            />
          </div>

          <div className="space-y-2">
            <Label>Options</Label>
            {options.map((option, index) => (
              <div key={index} className="flex gap-2">
                <Input
                  placeholder={`Option ${index + 1}`}
                  value={option}
                  onChange={(e) => updateOption(index, e.target.value)}
                  data-testid={`input-poll-option-${index}`}
                />
                {options.length > 2 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removeOption(index)}
                    data-testid={`button-remove-option-${index}`}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
            {options.length < 10 && (
              <Button
                variant="outline"
                size="sm"
                onClick={addOption}
                className="w-full"
                data-testid="button-add-option"
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Option
              </Button>
            )}
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="allow-multiple">Allow multiple votes</Label>
              <p className="text-xs text-muted-foreground">
                Let people select more than one option
              </p>
            </div>
            <Switch
              id="allow-multiple"
              checked={allowMultiple}
              onCheckedChange={setAllowMultiple}
              data-testid="switch-allow-multiple"
            />
          </div>

          <div className="flex gap-2 justify-end">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              data-testid="button-cancel-poll"
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={createPollMutation.isPending}
              data-testid="button-create-poll"
            >
              {createPollMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Poll
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
