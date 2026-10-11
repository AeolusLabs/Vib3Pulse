import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchIcon, CheckCircle2Icon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { User } from "@shared/schema";

export const personName = (u: Pick<User, "displayName" | "organizationName" | "username">) =>
  u.displayName || u.organizationName || u.username;

interface PeoplePickerProps {
  selectedIds?: Set<string> | string[];
  onToggle?: (user: User) => void;
  onPick?: (user: User) => void; // single-pick mode: tapping a row calls this
  excludeIds?: string[];
  multi?: boolean;
  disabled?: boolean;
}

// People you follow, plus server search once the query has 2+ chars.
export default function PeoplePicker({ selectedIds, onToggle, onPick, excludeIds, multi, disabled }: PeoplePickerProps) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const searching = debounced.length >= 2;

  const { data: following, isLoading: loadingFollowing } = useQuery<User[]>({
    queryKey: ["/api/follows/me/following"],
  });

  // Explicit queryFn: the default one joins queryKey parts with "/", so it would never send ?q=.
  const { data: results, isLoading: loadingSearch } = useQuery<User[]>({
    queryKey: ["/api/users/search", debounced],
    queryFn: async () => {
      const res = await fetch(`/api/users/search?q=${encodeURIComponent(debounced)}`, { credentials: "include" });
      if (!res.ok) throw new Error("Search failed");
      return res.json();
    },
    enabled: searching,
  });

  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds ?? []);
  const excluded = new Set(excludeIds ?? []);
  const list = ((searching ? results : following) ?? []).filter((u) => !excluded.has(u.id));
  const loading = searching ? loadingSearch : loadingFollowing;

  const handle = (u: User) => {
    if (disabled) return;
    if (multi) onToggle?.(u);
    else (onPick ?? onToggle)?.(u);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative px-4 pb-2">
        <SearchIcon className="pointer-events-none absolute left-7 top-[22px] h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people"
          aria-label="Search people"
          className="h-11 pl-9"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="divide-y divide-border">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex h-16 items-center gap-3 px-4">
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="space-y-2">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
            ))}
          </div>
        ) : list.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            {searching ? "No matches" : "You're not following anyone yet"}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {list.map((u) => {
              const isSelected = selected.has(u.id);
              return (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => handle(u)}
                    disabled={disabled}
                    aria-pressed={multi ? isSelected : undefined}
                    className="flex min-h-[44px] w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-60"
                  >
                    <Avatar className="h-10 w-10">
                      <AvatarImage src={u.avatarUrl || ""} alt="" />
                      <AvatarFallback>{personName(u)[0]?.toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{personName(u)}</span>
                        {u.userType === "organizer" && (
                          <span className="shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                            Organiser
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">@{u.username}</span>
                    </span>
                    {multi && (
                      <span
                        aria-hidden
                        className={cn(
                          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
                          isSelected ? "border-primary bg-primary text-primary-foreground" : "border-border"
                        )}
                      >
                        {isSelected && <CheckCircle2Icon className="h-4 w-4" />}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
