import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import SocialEventForm, { EMPTY_SOCIAL_EVENT, valuesToPayload, type SocialEventValues } from "@/components/social/SocialEventForm";
import PhoneVerifyDialog from "@/components/social/PhoneVerifyDialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export default function SocialEventCreatePage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [pendingValues, setPendingValues] = useState<SocialEventValues | null>(null);
  const [phoneOpen, setPhoneOpen] = useState(false);

  const create = useMutation({
    mutationFn: async (v: SocialEventValues) => {
      setPendingValues(v);
      const res = await apiRequest("POST", "/api/social-events", valuesToPayload(v, { includeType: true }));
      return (await res.json()) as { id: string };
    },
    onSuccess: (ev) => {
      queryClient.invalidateQueries({ queryKey: ["/api/social-events"] });
      navigate(`/social-events/${ev.id}`);
    },
    onError: (err: Error) => {
      // The API says exactly what's missing; a missing phone number is something we can fix right here.
      if (/verify your phone/i.test(err.message)) { setPhoneOpen(true); return; }
      toast({ title: "Couldn't create the event", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />
      <main className="mx-auto max-w-[640px] px-4 py-8 sm:px-6">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight" data-testid="heading-new-social-event">Plan an event</h1>
        <p className="mb-8 text-sm text-muted-foreground">Keep it private with a link, or list it publicly so people can find it.</p>
        <SocialEventForm initial={EMPTY_SOCIAL_EVENT} submitLabel="Create event" isSubmitting={create.isPending} onSubmit={(v) => create.mutate(v)} />
        <PhoneVerifyDialog open={phoneOpen} onClose={() => setPhoneOpen(false)} onVerified={() => { setPhoneOpen(false); toast({ title: "Phone verified" }); if (pendingValues) create.mutate(pendingValues); }} />
      </main>
      <BottomNavigation />
    </div>
  );
}
