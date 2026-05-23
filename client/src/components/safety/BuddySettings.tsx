import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { CheckInTimer } from "./CheckInTimer";
import {
  ShieldIcon,
  XIcon,
  CheckCircleIcon,
  XCircleIcon,
  PhoneIcon,
  UserPlusIcon,
  ClockIcon,
  SearchIcon,
} from "@/components/ui/icons";

interface Buddy {
  id: string;
  userId: string;
  buddyUserId: string | null;
  name: string;
  phoneNumber: string | null;
  confirmationStatus: "pending" | "confirmed" | "declined" | "expired";
  isPrimary: boolean;
  createdAt: string;
}

interface FollowerEntry {
  user: {
    id: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  existingBuddy: Buddy | null;
}

interface IncomingRequest {
  id: string;
  name: string;
  confirmationStatus: string;
  createdAt: string;
  requester: {
    id: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
}

const STATUS_CONFIG = {
  confirmed: {
    dot: "bg-green-500",
    label: "Confirmed",
    icon: <CheckCircleIcon className="h-3 w-3" />,
    labelClass: "text-green-700 dark:text-green-400",
    hint: null,
  },
  pending: {
    dot: "bg-amber-400 animate-pulse",
    label: "Awaiting reply",
    icon: <ClockIcon className="h-3 w-3" />,
    labelClass: "text-amber-700 dark:text-amber-400",
    hint: null,
  },
  declined: {
    dot: "bg-destructive/70",
    label: "Declined",
    icon: <XCircleIcon className="h-3 w-3" />,
    labelClass: "text-destructive",
    hint: "Remove and try again",
  },
  expired: {
    dot: "bg-muted-foreground/40",
    label: "Expired",
    icon: <XCircleIcon className="h-3 w-3" />,
    labelClass: "text-muted-foreground",
    hint: "Remove and resend",
  },
} as const;

function initials(displayName: string | null, username: string) {
  return ((displayName || username) ?? "?").charAt(0).toUpperCase();
}

function BuddyRow({ buddy, onRemove, removing, isApp }: {
  buddy: Buddy;
  onRemove: () => void;
  removing: boolean;
  isApp?: boolean;
}) {
  const cfg = STATUS_CONFIG[buddy.confirmationStatus];
  return (
    <div className="flex items-center gap-3 p-3 rounded-xl border bg-card transition-colors hover:bg-muted/30">
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${cfg.dot}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="font-medium text-sm truncate">{buddy.name}</p>
          {buddy.isPrimary && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
              Primary
            </span>
          )}
          <span className={`flex items-center gap-1 text-xs font-medium ${cfg.labelClass}`}>
            {cfg.icon}
            {cfg.label}
          </span>
        </div>
        {isApp ? (
          <p className="text-xs text-muted-foreground mt-0.5">In-app buddy</p>
        ) : buddy.phoneNumber ? (
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{buddy.phoneNumber}</p>
        ) : null}
        {cfg.hint && (
          <p className="text-xs text-muted-foreground mt-0.5 italic">{cfg.hint}</p>
        )}
        {buddy.confirmationStatus === "pending" && !isApp && (
          <p className="text-xs text-muted-foreground mt-0.5 italic">They can text YES or NO</p>
        )}
        {buddy.confirmationStatus === "pending" && isApp && (
          <p className="text-xs text-muted-foreground mt-0.5 italic">Waiting for them to accept in the app</p>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
        onClick={onRemove}
        disabled={removing}
        aria-label={`Remove ${buddy.name}`}
        style={{ touchAction: "manipulation" }}
      >
        <XIcon className="h-4 w-4" />
      </Button>
    </div>
  );
}

function IncomingRequestRow({ request, onAccept, onDecline, processing }: {
  request: IncomingRequest;
  onAccept: () => void;
  onDecline: () => void;
  processing: boolean;
}) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-xl border border-primary/20 bg-primary/5 animate-in fade-in duration-200">
      <Avatar className="h-9 w-9 shrink-0">
        <AvatarImage src={request.requester.avatarUrl ?? ""} />
        <AvatarFallback className="text-xs">
          {initials(request.requester.displayName, request.requester.username)}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm truncate">
          {request.requester.displayName || request.requester.username}
        </p>
        <p className="text-xs text-muted-foreground">Wants you to be their safety buddy</p>
      </div>
      <div className="flex gap-1.5 shrink-0">
        <Button
          size="sm"
          className="rounded-full h-7 px-3 text-xs"
          onClick={onAccept}
          disabled={processing}
          style={{ touchAction: "manipulation" }}
        >
          Accept
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full h-7 px-3 text-xs text-muted-foreground"
          onClick={onDecline}
          disabled={processing}
          style={{ touchAction: "manipulation" }}
        >
          Decline
        </Button>
      </div>
    </div>
  );
}

function FollowerPicker({ onSelect, onCancel, existingAppBuddyIds }: {
  onSelect: (user: FollowerEntry["user"], name: string) => void;
  onCancel: () => void;
  existingAppBuddyIds: Set<string>;
}) {
  const [search, setSearch] = useState("");

  const { data, isLoading } = useQuery<{ followers: FollowerEntry[] }>({
    queryKey: ["/api/safety/followers-for-buddy"],
  });

  const followers = data?.followers ?? [];
  const filtered = followers.filter((f) => {
    const q = search.toLowerCase();
    return (
      (f.user.displayName?.toLowerCase().includes(q) || f.user.username.toLowerCase().includes(q))
    );
  });

  return (
    <div className="space-y-3 p-4 border rounded-xl bg-muted/20 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-center gap-2">
        <SearchIcon className="h-4 w-4 text-muted-foreground shrink-0" />
        <Input
          placeholder="Search people you follow…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
          className="rounded-xl h-8 text-sm border-none bg-transparent shadow-none focus-visible:ring-0 px-0"
        />
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-12 w-full rounded-xl" />
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-4">
          {followers.length === 0
            ? "Follow someone on Vib3Pulse to add them as an in-app buddy."
            : "No matches found."}
        </p>
      ) : (
        <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
          {filtered.map((entry) => {
            const alreadyAdded = existingAppBuddyIds.has(entry.user.id);
            const status = entry.existingBuddy?.confirmationStatus;
            return (
              <button
                key={entry.user.id}
                disabled={alreadyAdded}
                onClick={() => {
                  if (!alreadyAdded) {
                    onSelect(entry.user, entry.user.displayName || entry.user.username);
                  }
                }}
                style={{ touchAction: "manipulation" }}
                className={[
                  "w-full flex items-center gap-3 p-2.5 rounded-xl text-left transition-colors",
                  alreadyAdded
                    ? "opacity-50 cursor-not-allowed"
                    : "hover:bg-muted/50 cursor-pointer",
                ].join(" ")}
              >
                <Avatar className="h-8 w-8 shrink-0">
                  <AvatarImage src={entry.user.avatarUrl ?? ""} />
                  <AvatarFallback className="text-xs">
                    {initials(entry.user.displayName, entry.user.username)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {entry.user.displayName || entry.user.username}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">@{entry.user.username}</p>
                </div>
                {alreadyAdded && (
                  <span className="text-[10px] text-muted-foreground shrink-0 capitalize">
                    {status}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <Button
        variant="ghost"
        className="rounded-full w-full text-sm"
        onClick={onCancel}
        style={{ touchAction: "manipulation" }}
      >
        Cancel
      </Button>
    </div>
  );
}

export function BuddySettings() {
  const { toast } = useToast();

  // Phone buddy form state
  const [phoneName, setPhoneName] = useState("");
  const [phone, setPhone] = useState("");
  const [showPhoneForm, setShowPhoneForm] = useState(false);

  // App buddy state
  const [showFollowerPicker, setShowFollowerPicker] = useState(false);

  const [distressMessage, setDistressMessage] = useState("");

  const { data: buddiesData, isLoading: buddiesLoading } = useQuery<{ buddies: Buddy[] }>({
    queryKey: ["/api/safety/buddies"],
  });

  const { data: requestsData, isLoading: requestsLoading } = useQuery<{ requests: IncomingRequest[] }>({
    queryKey: ["/api/safety/buddy-requests"],
    refetchInterval: 30_000,
  });

  const { data: distressMsgData } = useQuery<{ message: string | null }>({
    queryKey: ["/api/safety/distress-message"],
  });

  useEffect(() => {
    if (distressMsgData !== undefined) {
      setDistressMessage(distressMsgData.message ?? "");
    }
  }, [distressMsgData]);

  const addPhoneBuddyMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/safety/buddy-assignment", {
        name: phoneName.trim(),
        phone_number: phone.trim(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/buddies"] });
      setPhoneName("");
      setPhone("");
      setShowPhoneForm(false);
      toast({ title: "Invitation sent", description: "They'll get a text to confirm." });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const addAppBuddyMutation = useMutation({
    mutationFn: ({ targetUserId, name }: { targetUserId: string; name: string }) =>
      apiRequest("POST", "/api/safety/buddy-assignment/app", { targetUserId, name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/buddies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/safety/followers-for-buddy"] });
      setShowFollowerPicker(false);
      toast({ title: "Request sent", description: "They'll get a notification to confirm." });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const removeBuddyMutation = useMutation({
    mutationFn: (buddyId: string) => apiRequest("DELETE", `/api/safety/buddies/${buddyId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/buddies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/safety/followers-for-buddy"] });
      toast({ title: "Buddy removed" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const acceptRequestMutation = useMutation({
    mutationFn: (buddyId: string) =>
      apiRequest("POST", `/api/safety/buddy-requests/${buddyId}/accept`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/buddy-requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/safety/buddies"] });
      toast({ title: "Accepted", description: "You're now their safety buddy." });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const declineRequestMutation = useMutation({
    mutationFn: (buddyId: string) =>
      apiRequest("POST", `/api/safety/buddy-requests/${buddyId}/decline`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/buddy-requests"] });
      toast({ title: "Declined" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const saveMessageMutation = useMutation({
    mutationFn: (msg: string) =>
      apiRequest("POST", "/api/safety/distress-message", { message: msg }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/distress-message"] });
      toast({ title: "Message saved" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const allBuddies = buddiesData?.buddies ?? [];
  const appBuddies = allBuddies.filter((b) => b.buddyUserId && !b.phoneNumber);
  const phoneBuddies = allBuddies.filter((b) => b.phoneNumber);
  const confirmedBuddies = allBuddies.filter((b) => b.confirmationStatus === "confirmed");
  const hasConfirmedBuddy = confirmedBuddies.length > 0;
  const incomingRequests = requestsData?.requests ?? [];

  const existingAppBuddyIds = new Set(
    appBuddies.map((b) => b.buddyUserId).filter(Boolean) as string[]
  );

  const confirmedAppCount = appBuddies.filter((b) => b.confirmationStatus === "confirmed").length;
  const confirmedPhoneCount = phoneBuddies.filter((b) => b.confirmationStatus === "confirmed").length;

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground bg-muted rounded-xl px-4 py-3">
        This feature notifies your contact with your location. It is <strong>NOT</strong> an emergency service — in an emergency, call 999 (UK), 112 (Nigeria/EU), or 911 (US).
      </p>

      {/* Incoming buddy requests */}
      {(incomingRequests.length > 0 || requestsLoading) && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <CardTitle className="text-base">Buddy Requests</CardTitle>
              {incomingRequests.length > 0 && (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                  {incomingRequests.length}
                </span>
              )}
            </div>
            <CardDescription>
              These people want you to be their safety buddy.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {requestsLoading ? (
              <Skeleton className="h-14 w-full rounded-xl" />
            ) : (
              incomingRequests.map((req) => (
                <IncomingRequestRow
                  key={req.id}
                  request={req}
                  onAccept={() => acceptRequestMutation.mutate(req.id)}
                  onDecline={() => declineRequestMutation.mutate(req.id)}
                  processing={acceptRequestMutation.isPending || declineRequestMutation.isPending}
                />
              ))
            )}
          </CardContent>
        </Card>
      )}

      {/* Safety Buddies card */}
      <Card data-testid="card-buddy-settings">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <ShieldIcon className="h-5 w-5" />
              <CardTitle>Safety Buddies</CardTitle>
            </div>
            {confirmedBuddies.length > 0 && (
              <span className="flex items-center gap-1 text-xs font-medium text-green-700 dark:text-green-400 bg-green-500/10 px-2.5 py-1 rounded-full shrink-0">
                <CheckCircleIcon className="h-3 w-3" />
                {confirmedBuddies.length} confirmed
              </span>
            )}
          </div>
          <CardDescription>
            Add up to 5 in-app buddies and 5 phone buddies. All confirmed buddies receive your SOS alerts.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          {buddiesLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full rounded-xl" />
              <Skeleton className="h-14 w-full rounded-xl" />
            </div>
          ) : (
            <>
              {/* ── In-App Buddies ── */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <ShieldIcon className="h-3.5 w-3.5 text-muted-foreground" />
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
                      In-App Buddies
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {confirmedAppCount}/5
                  </p>
                </div>

                {appBuddies.length > 0 && (
                  <div className="space-y-2">
                    {appBuddies.map((buddy, i) => (
                      <div
                        key={buddy.id}
                        className="animate-in fade-in slide-in-from-bottom-1 duration-200 fill-mode-both"
                        style={{ animationDelay: `${i * 50}ms` }}
                      >
                        <BuddyRow
                          buddy={buddy}
                          onRemove={() => removeBuddyMutation.mutate(buddy.id)}
                          removing={removeBuddyMutation.isPending}
                          isApp
                        />
                      </div>
                    ))}
                  </div>
                )}

                {showFollowerPicker ? (
                  <FollowerPicker
                    existingAppBuddyIds={existingAppBuddyIds}
                    onSelect={(user, name) =>
                      addAppBuddyMutation.mutate({ targetUserId: user.id, name })
                    }
                    onCancel={() => setShowFollowerPicker(false)}
                  />
                ) : (
                  appBuddies.length < 5 && (
                    <Button
                      variant="outline"
                      className="rounded-full w-full"
                      onClick={() => setShowFollowerPicker(true)}
                      style={{ touchAction: "manipulation" }}
                    >
                      <UserPlusIcon className="h-4 w-4 mr-2" />
                      Add from followers
                    </Button>
                  )
                )}

                {appBuddies.length === 0 && !showFollowerPicker && (
                  <p className="text-xs text-muted-foreground text-center py-2">
                    Pick someone you follow — they confirm in-app, no phone needed.
                  </p>
                )}
              </div>

              <Separator />

              {/* ── Phone Buddies ── */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <PhoneIcon className="h-3.5 w-3.5 text-muted-foreground" />
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
                      Phone Buddies
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {confirmedPhoneCount}/5
                  </p>
                </div>

                {phoneBuddies.length > 0 && (
                  <div className="space-y-2">
                    {phoneBuddies.map((buddy, i) => (
                      <div
                        key={buddy.id}
                        className="animate-in fade-in slide-in-from-bottom-1 duration-200 fill-mode-both"
                        style={{ animationDelay: `${i * 50}ms` }}
                      >
                        <BuddyRow
                          buddy={buddy}
                          onRemove={() => removeBuddyMutation.mutate(buddy.id)}
                          removing={removeBuddyMutation.isPending}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {showPhoneForm ? (
                  <div className="space-y-3 p-4 border rounded-xl bg-muted/20 animate-in fade-in slide-in-from-bottom-2 duration-200">
                    <div className="space-y-1.5">
                      <Label htmlFor="buddy-name" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Buddy's name
                      </Label>
                      <Input
                        id="buddy-name"
                        placeholder="e.g. Mum"
                        value={phoneName}
                        onChange={(e) => setPhoneName(e.target.value)}
                        autoFocus
                        className="rounded-xl"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="buddy-phone" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Phone number
                      </Label>
                      <Input
                        id="buddy-phone"
                        type="tel"
                        placeholder="+44 7700 900000 or +234 801 234 5678"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        className="rounded-xl"
                      />
                      <p className="text-xs text-muted-foreground">
                        UK (+44) and Nigeria (+234) numbers supported.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        className="rounded-full"
                        onClick={() => addPhoneBuddyMutation.mutate()}
                        disabled={!phoneName.trim() || !phone.trim() || addPhoneBuddyMutation.isPending}
                        data-testid="button-send-invite"
                        style={{ touchAction: "manipulation" }}
                      >
                        {addPhoneBuddyMutation.isPending ? "Sending…" : "Send invitation"}
                      </Button>
                      <Button
                        variant="ghost"
                        className="rounded-full"
                        onClick={() => { setShowPhoneForm(false); setPhoneName(""); setPhone(""); }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  phoneBuddies.length < 5 && (
                    <Button
                      variant="outline"
                      className="rounded-full w-full"
                      onClick={() => setShowPhoneForm(true)}
                      data-testid="button-add-buddy"
                      style={{ touchAction: "manipulation" }}
                    >
                      <PhoneIcon className="h-4 w-4 mr-2" />
                      Add by phone number
                    </Button>
                  )
                )}

                {phoneBuddies.length === 0 && !showPhoneForm && (
                  <p className="text-xs text-muted-foreground text-center py-2">
                    Add anyone by number — they confirm by text, no app needed.
                  </p>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Check-in timer — only when at least one buddy is confirmed */}
      {hasConfirmedBuddy && <CheckInTimer />}

      {/* Distress message */}
      <Card data-testid="card-distress-message">
        <CardHeader>
          <CardTitle className="text-base">Distress Message</CardTitle>
          <CardDescription>
            Sent with every SOS alert. Default: "I need help! Please check on me."
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Textarea
              id="distress-message"
              placeholder="I need help! Please check on me."
              value={distressMessage}
              onChange={(e) => setDistressMessage(e.target.value)}
              maxLength={500}
              className="min-h-[80px] rounded-xl resize-none"
            />
            <p className="text-xs text-muted-foreground text-right">{distressMessage.length}/500</p>
          </div>
          <Button
            className="rounded-full"
            onClick={() => saveMessageMutation.mutate(distressMessage)}
            disabled={saveMessageMutation.isPending}
            style={{ touchAction: "manipulation" }}
          >
            {saveMessageMutation.isPending ? "Saving…" : "Save message"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}