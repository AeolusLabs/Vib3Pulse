import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { CheckInTimer } from "./CheckInTimer";
import { Shield, X, Clock, CheckCircle, XCircle, Phone, UserPlus } from "lucide-react";

interface Buddy {
  id: string;
  userId: string;
  name: string;
  phoneNumber: string;
  confirmationStatus: "pending" | "confirmed" | "declined" | "expired";
  isPrimary: boolean;
  createdAt: string;
}

function StatusBadge({ status }: { status: Buddy["confirmationStatus"] }) {
  if (status === "confirmed") {
    return <Badge variant="default"><CheckCircle className="h-3 w-3 mr-1" />Confirmed</Badge>;
  }
  if (status === "pending") {
    return <Badge variant="secondary"><Clock className="h-3 w-3 mr-1" />Awaiting reply</Badge>;
  }
  if (status === "declined") {
    return <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />Declined</Badge>;
  }
  return <Badge variant="outline"><XCircle className="h-3 w-3 mr-1" />Expired</Badge>;
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
    select: (d) => d,
  });

  // Sync distress message to local state when loaded
  if (distressMsgData?.message && !distressMessage) {
    setDistressMessage(distressMsgData.message);
  }

  const addBuddyMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/safety/buddy-assignment", { name: name.trim(), phone_number: phone.trim() }),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/buddies"] });
      setName("");
      setPhone("");
      setShowForm(false);
      toast({ title: "Invitation sent", description: data.message });
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
    mutationFn: (msg: string) => apiRequest("POST", "/api/safety/distress-message", { message: msg }),
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
      <Card data-testid="card-buddy-settings">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Safety Buddies
          </CardTitle>
          <CardDescription>
            Buddies receive your SOS alerts by SMS — they don't need the app installed. Up to 5 confirmed buddies.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {buddiesLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : (
            <>
              {buddies.length > 0 && (
                <div className="space-y-2">
                  {buddies.map((buddy) => (
                    <div
                      key={buddy.id}
                      className="flex items-center justify-between p-3 border rounded-md"
                    >
                      <div className="flex items-center gap-3">
                        <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center">
                          <Phone className="h-4 w-4 text-primary" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-medium text-sm">{buddy.name}</p>
                            {buddy.isPrimary && (
                              <Badge variant="outline" className="text-xs">Primary</Badge>
                            )}
                            <StatusBadge status={buddy.confirmationStatus} />
                          </div>
                          <p className="text-xs text-muted-foreground">{buddy.phoneNumber}</p>
                          {buddy.confirmationStatus === "pending" && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              Waiting for reply — they can text YES or NO
                            </p>
                          )}
                          {buddy.confirmationStatus === "declined" && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              They declined — remove and try again
                            </p>
                          )}
                          {buddy.confirmationStatus === "expired" && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              Invitation expired — remove and resend
                            </p>
                          )}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeBuddyMutation.mutate(buddy.id)}
                        disabled={removeBuddyMutation.isPending}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {showForm ? (
                <div className="space-y-3 p-4 border rounded-md bg-muted/30">
                  <div className="space-y-1.5">
                    <Label htmlFor="buddy-name">Buddy's name</Label>
                    <Input
                      id="buddy-name"
                      placeholder="e.g. Mum"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="buddy-phone">Phone number</Label>
                    <Input
                      id="buddy-phone"
                      type="tel"
                      placeholder="+447700900000 or 07700900000"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      UK (+44) or Nigeria (+234) numbers. They'll get an SMS — no app needed.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={() => addBuddyMutation.mutate()}
                      disabled={!name.trim() || !phone.trim() || addBuddyMutation.isPending}
                      data-testid="button-send-invite"
                    >
                      {addBuddyMutation.isPending ? "Sending…" : "Send invitation"}
                    </Button>
                    <Button
                      variant="outline"
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
                    onClick={() => setShowForm(true)}
                    data-testid="button-add-buddy"
                  >
                    <UserPlus className="h-4 w-4 mr-2" />
                    Add a buddy
                  </Button>
                )
              )}

              {buddies.length === 0 && !showForm && (
                <p className="text-sm text-muted-foreground">
                  No buddies yet. Add someone — they'll get a text asking to confirm.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {hasConfirmedBuddy && <CheckInTimer />}

      <Card data-testid="card-distress-message">
        <CardHeader>
          <CardTitle className="text-base">Distress Message</CardTitle>
          <CardDescription>
            Sent to your buddy with every SOS alert. Default: "I need help! Please check on me."
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="distress-message">Your message</Label>
            <Textarea
              id="distress-message"
              placeholder="I need help! Please check on me."
              value={distressMessage}
              onChange={(e) => setDistressMessage(e.target.value)}
              maxLength={500}
              className="min-h-[80px]"
            />
            <p className="text-xs text-muted-foreground text-right">{distressMessage.length}/500</p>
          </div>
          <Button
            onClick={() => saveMessageMutation.mutate(distressMessage)}
            disabled={!distressMessage.trim() || saveMessageMutation.isPending}
          >
            Save Message
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
