import { useState, useRef, useEffect, KeyboardEvent } from "react";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { User } from "@shared/schema";
import { cn } from "@/lib/utils";

interface MentionInputProps {
  value: string;
  onChange: (value: string) => void;
  participants: Array<{ user: User }>;
  placeholder?: string;
  disabled?: boolean;
  onSubmit?: () => void;
  className?: string;
  "data-testid"?: string;
}

export function MentionInput({
  value,
  onChange,
  participants,
  placeholder = "Type a message...",
  disabled = false,
  onSubmit,
  className,
  "data-testid": testId,
}: MentionInputProps) {
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<User[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mentionStartIndex, setMentionStartIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    const cursorPos = e.target.selectionStart || 0;
    onChange(newValue);

    const textBeforeCursor = newValue.slice(0, cursorPos);
    const atIndex = textBeforeCursor.lastIndexOf("@");

    if (atIndex !== -1) {
      const textAfterAt = textBeforeCursor.slice(atIndex + 1);
      const hasSpace = textAfterAt.includes(" ");
      
      if (!hasSpace) {
        const query = textAfterAt.toLowerCase();
        const filteredUsers = participants
          .map(p => p.user)
          .filter(user => 
            user.username.toLowerCase().includes(query) ||
            (user.displayName?.toLowerCase().includes(query))
          )
          .slice(0, 5);
        
        if (filteredUsers.length > 0) {
          setSuggestions(filteredUsers);
          setMentionStartIndex(atIndex);
          setSelectedIndex(0);
          setShowSuggestions(true);
          return;
        }
      }
    }
    
    setShowSuggestions(false);
  };

  const insertMention = (user: User) => {
    if (mentionStartIndex === -1) return;
    
    const beforeMention = value.slice(0, mentionStartIndex);
    const cursorPos = inputRef.current?.selectionStart || value.length;
    const afterMention = value.slice(cursorPos);
    
    const newValue = `${beforeMention}@${user.username} ${afterMention}`;
    onChange(newValue);
    setShowSuggestions(false);
    setMentionStartIndex(-1);
    
    setTimeout(() => {
      if (inputRef.current) {
        const newCursorPos = mentionStartIndex + user.username.length + 2;
        inputRef.current.focus();
        inputRef.current.setSelectionRange(newCursorPos, newCursorPos);
      }
    }, 0);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (showSuggestions && suggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % suggestions.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(suggestions[selectedIndex]);
      } else if (e.key === "Escape") {
        setShowSuggestions(false);
      }
    } else if (e.key === "Enter" && onSubmit) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="relative flex-1">
      <Input
        ref={inputRef}
        placeholder={placeholder}
        value={value}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        className={cn("flex-1", className)}
        data-testid={testId}
      />
      
      {showSuggestions && suggestions.length > 0 && (
        <div
          ref={suggestionsRef}
          className="absolute bottom-full left-0 right-0 mb-1 bg-popover border rounded-md shadow-lg z-50 max-h-48 overflow-y-auto"
          data-testid="mention-suggestions"
        >
          {suggestions.map((user, index) => (
            <button
              key={user.id}
              type="button"
              className={cn(
                "w-full flex items-center gap-2 p-2 text-left transition-colors",
                index === selectedIndex ? "bg-accent" : "hover:bg-muted"
              )}
              onClick={() => insertMention(user)}
              data-testid={`mention-suggestion-${user.username}`}
            >
              <Avatar className="h-6 w-6">
                <AvatarImage src={user.avatarUrl || ""} />
                <AvatarFallback className="text-xs">
                  {user.displayName?.[0] || user.username[0]}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-sm truncate">
                  {user.displayName || user.username}
                </p>
                <p className="text-xs text-muted-foreground">@{user.username}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function renderMessageWithMentions(
  content: string, 
  currentUsername?: string,
  onMentionClick?: (username: string) => void
): JSX.Element {
  const mentionRegex = /@(\w+)/g;
  const parts: (string | JSX.Element)[] = [];
  let lastIndex = 0;
  let match;

  while ((match = mentionRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(content.slice(lastIndex, match.index));
    }
    
    const username = match[1];
    // Sanitize username - only allow alphanumeric and underscore
    const sanitizedUsername = username.replace(/[^\w]/g, '');
    if (!sanitizedUsername) {
      parts.push(match[0]);
      lastIndex = match.index + match[0].length;
      continue;
    }
    
    const isCurrentUser = sanitizedUsername.toLowerCase() === currentUsername?.toLowerCase();
    
    parts.push(
      <span
        key={match.index}
        className={cn(
          "font-semibold text-primary cursor-pointer hover:underline",
          isCurrentUser && "bg-primary/20 px-0.5 rounded"
        )}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (onMentionClick) {
            onMentionClick(sanitizedUsername);
          }
        }}
        data-testid={`mention-${sanitizedUsername}`}
      >
        @{sanitizedUsername}
      </span>
    );
    
    lastIndex = match.index + match[0].length;
  }
  
  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }
  
  return <>{parts}</>;
}
