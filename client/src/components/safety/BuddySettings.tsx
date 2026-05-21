import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
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
} from "@/components/ui/icons";

interface Buddy {
  id: string;
  userId: string;
  name: string;
  phoneNumber: string;
  confirmationStatus: "pending" | "confirmed" | "declined" | "expired";
  isPrimary: boolean;
  createdAt: string;
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
    hint: "They can text YES or NO",
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

function BuddyRow({ buddy, onRemove, removing }: {
  buddy: Buddy;
  onRemove: () => void;
  removing: boolean;
}) {
  const cfg = STATUS_CONFIG[buddy.confirmationStatus];
  return (
    <div className="flex items-center gap-3 p-3 rounded-xl border bg-card transition-colors hover:bg-muted/30">
      {/* Status dot */}
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${cfg.dot}`} />

      {/* Info */}
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
        <p className="text-xs text-muted-foreground mt-0.5 truncate">{buddy.phoneNumber}</p>
        {cfg.hint && (
          <p className="text-xs text-muted-foreground mt-0.5 italic">{cfg.hint}</p>
        )}
      </div>

      {/* Remove */}
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

export function BuddySettings() {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [distressMessage, setDistressMessage] = useState("");

  const { data: buddiesData, isLoading: buddiesLoading } = useQuery<{ buddies: Buddy[] }>({
    queryKey: ["/api/safety/buddies"],
  });

  const { data: distressMsgData } = useQuery<{ message: string | null }>({
    queryKey: ["/api/safety/distress-message"],
  });

  useEffect(() => {
    if (distressMsgData !== undefined) {
      setDistressMessage(distressMsgData.message ?? "");
    }
  }, [distressMsgData]);

  const addBuddyMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/safety/buddy-assignment", {
        name: name.trim(),
        phone_number: phone.trim(),
      }),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/buddies"] });
      setName("");
      setPhone("");
      setShowForm(false);
      toast({ title: "Invitation sent", description: "They'll get a text to confirm." });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const removeBuddyMutation = useMutation({
    mutationFn: (buddyId: string) => apiRequest("DELETE", `/api/safety/buddies/${buddyId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/buddies"] });
      toast({ title: "Buddy removed" });
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

  const buddies = buddiesData?.buddies ?? [];
  const confirmedBuddies = buddies.filter((b) => b.confirmationStatus === "confirmed");
  const hasConfirmedBuddy = confirmedBuddies.length > 0;

  return (
    <div className="space-y-4">
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
            Buddies receive your SOS alerts by SMS — no app needed. Up to 5 confirmed buddies.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {buddiesLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full rounded-xl" />
              <Skeleton className="h-14 w-full rounded-xl" />
            </div>
          ) : (
            <>
              {/* Buddy list */}
              {buddies.length > 0 && (
                <div className="space-y-2">
                  {buddies.map((buddy, i) => (
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

              {/* Empty state */}
              {buddies.length === 0 && !showForm && (
                <div className="text-center py-6 text-muted-foreground">
                  <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                    <PhoneIcon className="h-5 w-5 opacity-50" />
                  </div>
                  <p className="text-sm font-medium">No buddies yet</p>
                  <p className="text-xs mt-1">Add someone — they confirm by text, no app needed.</p>
                </div>
              )}

              {/* Add buddy form */}
              {showForm ? (
                <div className="space-y-3 p-4 border rounded-xl bg-muted/20 animate-in fade-in slide-in-from-bottom-2 duration-200">
                  <div className="space-y-1.5">
                    <Label htmlFor="buddy-name" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Buddy's name
                    </Label>
                    <Input
                      id="buddy-name"
                      placeholder="e.g. Mum"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
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
                      onClick={() => addBuddyMutation.mutate()}
                      disabled={!name.trim() || !phone.trim() || addBuddyMutation.isPending}
                      data-testid="button-send-invite"
                      style={{ touchAction: "manipulation" }}
                    >
                      {addBuddyMutation.isPending ? "Sending…" : "Send invitation"}
                    </Button>
                    <Button
                      variant="ghost"
                      className="rounded-full"
                      onClick={() => { setShowForm(false); setName(""); setPhone(""); }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                buddies.length < 5 && (
                  <Button
                    variant="outline"
                    className="rounded-full w-full"
                    onClick={() => setShowForm(true)}
                    data-testid="button-add-buddy"
                    style={{ touchAction: "manipulation" }}
                  >
                    <UserPlusIcon className="h-4 w-4 mr-2" />
                    Add a buddy
                  </Button>
                )
              )}
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