import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SheetDescription, SheetHeader, SheetTitle, Sheet } from "@/components/ui/sheet";
import RoomSheetContent from "@/components/rooms/shell/RoomSheetContent";
import HostAvatar from "@/components/rooms/HostAvatar";
import { Loader2Icon, SearchIcon, UserMinusIcon, UserPlusIcon } from "@/components/ui/icons";
import type { BlockedUser } from "@/components/BlockButton";
import { useAuth } from "@/hooks/useAuth";
import { hostName, type RoomHostSummary } from "@/lib/roomsApi";
import { inviteAdult, listAdultInvites, revokeAdult, type AdultInvite } from "@/lib/minorsRoomApi";
import { ALREADY_INVITED_COPY, INVITE_SHEET_HELP, INVITE_SHEET_TITLE, INVITE_STATUS_LABEL, inviteErrorMessage, inviteStatus } from "@/lib/minorsRoomUi";

type Found = Pick<RoomHostSummary, "id" | "username" | "displayName" | "organizationName" | "avatarUrl" | "avatar">;

interface Props {
  open: boolean;
  onOpenChange(o: boolean): void;
  roomId: string;
  /** Invites taken back this session; the server only lists active ones. Held by the caller so they survive this sheet closing. */
  revoked: Map<string, AdultInvite>;
  onRevokedChange(next: Map<string, AdultInvite>): void;
  /** The button that opened the sheet, so focus goes back to it on close. */
  returnFocusTo?: () => HTMLElement | null;
}

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

/**
 * Host only, and only ever mounted for a room for under 18s. Search for an adult by username, invite them, see who is
 * invited and whether they have read the notice, and take an invite back. The server decides who can be invited; a refusal
 * gets one plain line that never says why (age, blocks and bans stay private).
 */
export default function AdultInviteSheet({ open, onOpenChange, roomId, revoked, onRevokedChange, returnFocusTo }: Props) {
  const { data: me } = useAuth();
  // Read only while the sheet is open, so a minors' room does not fetch the block list on load.
  const { data: blockedData } = useQuery<{ blocked: BlockedUser[] }>({ queryKey: ["/api/blocks"], enabled: open });
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { const t = setTimeout(() => setDebounced(query.trim()), 250); return () => clearTimeout(t); }, [query]);
  useEffect(() => { if (!open) { setQuery(""); setError(null); } }, [open]);

  const invites = useQuery<AdultInvite[]>({
    queryKey: ["room-adult-invites", roomId],
    enabled: open,
    staleTime: 0,
    queryFn: async () => {
      const r = await listAdultInvites(roomId);
      if (!r.ok) throw new Error(inviteErrorMessage(r.status, r.code));
      return r.body.invites;
    },
  });

  const searching = open && debounced.length >= 2;
  const search = useQuery<Found[]>({
    queryKey: ["room-adult-invite-search", debounced],
    enabled: searching,
    queryFn: async () => {
      const res = await fetch(`/api/users/search?q=${encodeURIComponent(debounced)}`, { credentials: "include" });
      if (!res.ok) throw new Error("Search failed");
      return res.json();
    },
  });

  const blocked = useMemo(() => new Set((blockedData?.blocked ?? []).map((b) => b.id)), [blockedData]);
  const active = invites.data ?? [];
  const activeIds = new Set(active.map((i) => i.user.id));
  const results = (search.data ?? []).filter((u) => u.id !== me?.id && !blocked.has(u.id) && !activeIds.has(u.id) && !revoked.has(u.id));
  // Active invites first, then the ones taken back in this session (the server only lists active ones).
  const rows: { invite: AdultInvite; revoked: boolean }[] = [
    ...active.filter((i) => !revoked.has(i.user.id)).map((invite) => ({ invite, revoked: false })),
    ...Array.from(revoked.values()).map((invite) => ({ invite, revoked: true })),
  ];

  const invite = async (u: Found, again = false) => {
    if (busyId) return;
    setBusyId(u.id); setError(null);
    const r = await inviteAdult(roomId, u.id);
    setBusyId(null);
    if (!r.ok) { setError(inviteErrorMessage(r.status, r.code)); return; }
    if (again) { const n = new Map(revoked); n.delete(u.id); onRevokedChange(n); }
    setQuery(""); setDebounced("");
    void invites.refetch();
  };

  const revoke = async (i: AdultInvite) => {
    if (busyId) return;
    setBusyId(i.user.id); setError(null);
    const r = await revokeAdult(roomId, i.user.id);
    setBusyId(null);
    if (!r.ok) { setError(inviteErrorMessage(r.status, r.code)); return; }
    onRevokedChange(new Map(revoked).set(i.user.id, i));
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <RoomSheetContent side="bottom" returnFocusTo={returnFocusTo} className="max-h-[88dvh] overflow-y-auto rounded-t-3xl pb-[calc(20px+env(safe-area-inset-bottom,0px))] sm:mx-auto sm:max-w-lg" data-testid="adult-invite-sheet">
        <SheetHeader className="pr-10 text-left">
          <SheetTitle className="font-sans text-lg font-semibold">{INVITE_SHEET_TITLE}</SheetTitle>
          <SheetDescription>{INVITE_SHEET_HELP}</SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-2">
          <Label htmlFor="adult-invite-search">Search by username</Label>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input id="adult-invite-search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} className="h-11 pl-9" data-testid="input-adult-search" />
          </div>
        </div>

        {error && <p role="alert" className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" data-testid="adult-invite-error">{error}</p>}

        {searching && (
          <ul className="mt-2 grid gap-0.5" aria-label="Search results" data-testid="adult-search-results">
            {search.isLoading && <li className="px-2 py-3 text-sm text-muted-foreground" role="status">Searching…</li>}
            {!search.isLoading && results.length === 0 && <li className="px-2 py-3 text-sm text-muted-foreground" role="status">{search.isError ? "Search didn't work. Try again." : (search.data ?? []).length > 0 && (search.data ?? []).every((u) => activeIds.has(u.id)) ? ALREADY_INVITED_COPY : "Nobody found."}</li>}
            {results.map((u) => (
              <li key={u.id} className="flex min-h-[52px] items-center gap-3 px-2 py-1.5">
                <HostAvatar person={u} className="h-9 w-9 shrink-0 rounded-full" />
                <span className="min-w-0 flex-1 truncate text-sm">{hostName(u)}<span className="text-muted-foreground"> @{u.username}</span></span>
                <Button variant="outline" className={`min-h-[44px] shrink-0 ${FOCUS}`} disabled={!!busyId} onClick={() => void invite(u)} aria-label={`Invite ${u.username}`} data-testid={`button-invite-${u.id}`}>
                  {busyId === u.id ? <Loader2Icon className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <UserPlusIcon className="mr-2 h-4 w-4" aria-hidden />}Invite
                </Button>
              </li>
            ))}
          </ul>
        )}

        <h3 className="mt-5 text-sm font-semibold">Invited adults</h3>
        {invites.isLoading ? (
          <p className="mt-2 text-sm text-muted-foreground" role="status">Loading…</p>
        ) : invites.isError ? (
          <p className="mt-2 text-sm text-destructive" role="alert">{(invites.error as Error).message}</p>
        ) : rows.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground" data-testid="adult-invites-empty">Nobody invited yet.</p>
        ) : (
          <ul className="mt-1 grid gap-0.5" aria-label="Invited adults" data-testid="adult-invites-list">
            {rows.map(({ invite: i, revoked: gone }) => {
              const status = inviteStatus(i, gone);
              return (
                <li key={i.user.id} className="flex min-h-[52px] items-center gap-3 px-2 py-1.5" data-testid={`adult-invite-${i.user.id}`}>
                  <HostAvatar person={i.user} className="h-9 w-9 shrink-0 rounded-full" />
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block truncate">{hostName(i.user)}</span>
                    <span className="block text-xs text-muted-foreground" data-testid={`adult-invite-status-${i.user.id}`}>{INVITE_STATUS_LABEL[status]}</span>
                  </span>
                  {gone ? (
                    <Button variant="outline" className={`min-h-[44px] shrink-0 ${FOCUS}`} disabled={!!busyId} onClick={() => void invite(i.user, true)} aria-label={`Invite ${i.user.username} again`}>
                      <UserPlusIcon className="mr-2 h-4 w-4" aria-hidden />Invite again
                    </Button>
                  ) : (
                    <Button variant="outline" className={`min-h-[44px] shrink-0 ${FOCUS}`} disabled={!!busyId} onClick={() => void revoke(i)} aria-label={`Revoke the invite for ${i.user.username}`} data-testid={`button-revoke-${i.user.id}`}>
                      {busyId === i.user.id ? <Loader2Icon className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <UserMinusIcon className="mr-2 h-4 w-4" aria-hidden />}Revoke
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </RoomSheetContent>
    </Sheet>
  );
}
