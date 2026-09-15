import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import MentionTextarea from "./MentionTextarea";
import { SendIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

interface CommentComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  avatarUrl?: string | null;
  avatarInitial: string;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  rows?: number;
  className?: string;
  "data-testid"?: string;
}

// Shared avatar + mention-aware textarea + send button used everywhere a
// user composes a comment or reply — was previously duplicated (and
// inconsistent) between CommentDialog and PostDetailDialog.
export default function CommentComposer({
  value,
  onChange,
  onSubmit,
  avatarUrl,
  avatarInitial,
  placeholder = "Add a comment…",
  disabled = false,
  autoFocus = false,
  rows = 2,
  className,
  "data-testid": testId,
}: CommentComposerProps) {
  return (
    <div className={cn("flex items-end gap-2.5", className)}>
      <Avatar className="h-8 w-8 flex-shrink-0 mb-0.5">
        <AvatarImage src={avatarUrl || ""} alt="You" />
        <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
          {avatarInitial}
        </AvatarFallback>
      </Avatar>

      <div className="flex-1 min-w-0">
        <MentionTextarea
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          rows={rows}
          className="text-sm resize-none border-0 bg-muted/40 rounded-xl px-3 py-2 focus-visible:ring-1 focus-visible:ring-primary/50"
          data-testid={testId ? `${testId}-input` : undefined}
        />
      </div>

      <button
        type="button"
        onClick={onSubmit}
        disabled={!value.trim() || disabled}
        className="mb-0.5 h-8 w-8 flex items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40 hover:bg-primary/90 transition-colors flex-shrink-0"
        aria-label="Send comment"
        data-testid={testId ? `${testId}-submit` : undefined}
      >
        <SendIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
