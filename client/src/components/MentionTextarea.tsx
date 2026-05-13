import { useState, useRef, useEffect, useCallback, KeyboardEvent } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

interface UserSuggestion {
  id: string;
  username: string;
  displayName?: string | null;
  organizationName?: string | null;
  avatarUrl?: string | null;
}

interface MentionTextareaProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  maxLength?: number;
  className?: string;
  "data-testid"?: string;
}

export default function MentionTextarea({
  value,
  onChange,
  placeholder,
  disabled,
  rows = 4,
  maxLength,
  className,
  "data-testid": testId,
}: MentionTextareaProps) {
  const [suggestions, setSuggestions] = useState<UserSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mentionStartIndex, setMentionStartIndex] = useState(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchUsers = useCallback(async (query: string) => {
    if (query.length < 1) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    try {
      const response = await fetch(`/api/users/search?q=${encodeURIComponent(query)}`);
      if (!response.ok) return;
      const users: UserSuggestion[] = await response.json();
      const top = users.slice(0, 6);
      setSuggestions(top);
      setShowSuggestions(top.length > 0);
      setSelectedIndex(0);
    } catch {
      setSuggestions([]);
      setShowSuggestions(false);
    }
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = maxLength ? e.target.value.slice(0, maxLength) : e.target.value;
    onChange(newValue);

    const cursorPos = e.target.selectionStart || 0;
    const textBeforeCursor = newValue.slice(0, cursorPos);

    // Detect @word pattern right before cursor (no space after @)
    const atMatch = textBeforeCursor.match(/@(\w*)$/);

    if (atMatch) {
      const query = atMatch[1];
      const atIndex = cursorPos - query.length - 1;
      setMentionStartIndex(atIndex);

      if (searchTimeout.current) clearTimeout(searchTimeout.current);
      searchTimeout.current = setTimeout(() => searchUsers(query), 200);
    } else {
      setShowSuggestions(false);
      setMentionStartIndex(-1);
    }
  };

  const insertMention = (user: UserSuggestion) => {
    if (mentionStartIndex === -1 || !textareaRef.current) return;

    const cursorPos = textareaRef.current.selectionStart || value.length;
    const beforeMention = value.slice(0, mentionStartIndex);
    const afterCursor = value.slice(cursorPos);

    const newValue = `${beforeMention}@${user.username} ${afterCursor}`;
    onChange(newValue);
    setShowSuggestions(false);
    setMentionStartIndex(-1);

    // Restore focus and cursor position after React re-render
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const newPos = mentionStartIndex + user.username.length + 2;
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(newPos, newPos);
      }
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!showSuggestions || suggestions.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Tab" || e.key === "Enter") {
      // Only intercept Enter when suggestions are open
      if (e.key === "Enter") {
        e.preventDefault();
      }
      insertMention(suggestions[selectedIndex]);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(e.target as Node) &&
        textareaRef.current &&
        !textareaRef.current.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    return () => {
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
    };
  }, []);

  return (
    <div className="relative">
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows}
        className={className}
        data-testid={testId}
      />

      {showSuggestions && suggestions.length > 0 && (
        <div
          ref={suggestionsRef}
          className="absolute top-full left-0 right-0 mt-1 bg-popover border border-border rounded-xl shadow-xl z-50 max-h-72 overflow-y-auto divide-y divide-border/50"
          data-testid="mention-suggestions-dropdown"
        >
          {suggestions.map((user, index) => {
            const isSelected = index === selectedIndex;
            return (
              <button
                key={user.id}
                type="button"
                className={cn(
                  "w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors",
                  isSelected
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted text-foreground"
                )}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep textarea focus
                  insertMention(user);
                }}
                data-testid={`mention-suggestion-${user.username}`}
              >
                <Avatar className="h-8 w-8 flex-shrink-0">
                  <AvatarImage src={user.avatarUrl || ""} />
                  <AvatarFallback
                    className={cn(
                      "text-xs font-semibold",
                      isSelected
                        ? "bg-primary-foreground/20 text-primary-foreground"
                        : "bg-primary/10 text-primary"
                    )}
                  >
                    {(user.displayName || user.organizationName || user.username)[0].toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-sm truncate leading-tight">
                    {user.displayName || user.organizationName || user.username}
                  </p>
                  <p
                    className={cn(
                      "text-xs leading-tight truncate",
                      isSelected ? "text-primary-foreground/80" : "text-muted-foreground"
                    )}
                  >
                    @{user.username}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
