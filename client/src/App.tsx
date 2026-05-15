import { useEffect } from "react";
import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import AuthenticatedLayout from "@/components/AuthenticatedLayout";
import NotFound from "@/pages/not-found";
import LandingPage from "@/pages/LandingPage";
import DiscoverPage from "@/pages/DiscoverPage";
import EventDetailPage from "@/pages/EventDetailPage";
import ProfilePage from "@/pages/ProfilePage";
import UserProfilePage from "@/pages/UserProfilePage";
import FeedPage from "@/pages/FeedPage";
import MyEventsPage from "@/pages/MyEventsPage";
import ManageEventsPage from "@/pages/ManageEventsPage";
import TicketWalletPage from "@/pages/TicketWalletPage";
import EventCheckInPage from "@/pages/EventCheckInPage";
import MyRsvpsPage from "@/pages/MyRsvpsPage";
import LoginPage from "@/pages/LoginPage";
import SignupPage from "@/pages/SignupPage";
import SearchPage from "@/pages/SearchPage";
import MessagesPage from "@/pages/MessagesPage";
import BuddySettingsPage from "@/pages/BuddySettingsPage";
import DistressAlertsPage from "@/pages/DistressAlertsPage";
import AccountSettingsPage from "@/pages/AccountSettingsPage";
import ManageVenuesPage from "@/pages/ManageVenuesPage";
import VenueDetailPage from "@/pages/VenueDetailPage";
import VenueEventsPage from "@/pages/VenueEventsPage";
import VenueEventDetailPage from "@/pages/VenueEventDetailPage";
import AdminLogin from "@/pages/admin/AdminLogin";
import AdminDashboard from "@/pages/admin/AdminDashboard";
import AdminUsers from "@/pages/admin/AdminUsers";
import AdminEvents from "@/pages/admin/AdminEvents";
import AdminStories from "@/pages/admin/AdminStories";
import AdminReports from "@/pages/admin/AdminReports";
import AdminFinance from "@/pages/admin/AdminFinance";
import AdminStaff from "@/pages/admin/AdminStaff";
import AdminActivity from "@/pages/admin/AdminActivity";
import AdminSetup from "@/pages/admin/AdminSetup";
import ForgotPasswordPage from "@/pages/ForgotPasswordPage";
import ResetPasswordPage from "@/pages/ResetPasswordPage";
import JoinGroupPage from "@/pages/JoinGroupPage";

function Router() {
  return (
    <Switch>
      <Route path="/" component={LandingPage} />
      <Route path="/login" component={LoginPage} />
      <Route path="/signup" component={SignupPage} />
      <Route path="/forgot-password" component={ForgotPasswordPage} />
      <Route path="/reset-password" component={ResetPasswordPage} />
      <Route path="/discover" component={DiscoverPage} />
      <Route path="/event/:id" component={EventDetailPage} />
      <Route path="/profile/:username" component={ProfilePage} />
      
      <Route path="/feed">
        <AuthenticatedLayout>
          <FeedPage />
        </AuthenticatedLayout>
      </Route>
      
      <Route path="/my-events">
        <AuthenticatedLayout>
          <MyEventsPage />
        </AuthenticatedLayout>
      </Route>
      
      <Route path="/manage-events">
        <AuthenticatedLayout>
          <ManageEventsPage />
        </AuthenticatedLayout>
      </Route>
      
      <Route path="/ticket-wallet">
        <AuthenticatedLayout>
          <TicketWalletPage />
        </AuthenticatedLayout>
      </Route>
      
      <Route path="/wallet">
        <AuthenticatedLayout>
          <TicketWalletPage />
        </AuthenticatedLayout>
      </Route>
      
      <Route path="/events/:id/check-in">
        <AuthenticatedLayout>
          <EventCheckInPage />
        </AuthenticatedLayout>
      </Route>
      
      <Route path="/my-rsvps">
        <AuthenticatedLayout>
          <MyRsvpsPage />
        </AuthenticatedLayout>
      </Route>
      
      <Route path="/search">
        <AuthenticatedLayout>
          <SearchPage />
        </AuthenticatedLayout>
      </Route>
      
      <Route path="/messages">
        <AuthenticatedLayout>
          <MessagesPage />
        </AuthenticatedLayout>
      </Route>
      
      <Route path="/messages/:conversationId">
        <AuthenticatedLayout>
          <MessagesPage />
        </AuthenticatedLayout>
      </Route>
      
      <Route path="/user/:userId">
        <AuthenticatedLayout>
          <UserProfilePage />
        </AuthenticatedLayout>
      </Route>
      
      <Route path="/buddy/settings">
        <AuthenticatedLayout>
          <BuddySettingsPage />
        </AuthenticatedLayout>
      </Route>
      
      <Route path="/buddy/alerts">
        <AuthenticatedLayout>
          <DistressAlertsPage />
        </AuthenticatedLayout>
      </Route>
      
      <Route path="/account/settings">
        <AuthenticatedLayout>
          <AccountSettingsPage />
        </AuthenticatedLayout>
      </Route>
      
      <Route path="/manage-venues">
        <AuthenticatedLayout>
          <ManageVenuesPage />
        </AuthenticatedLayout>
      </Route>
      
      <Route path="/venues/:venueId/venue-events">
        <AuthenticatedLayout>
          <VenueEventsPage />
        </AuthenticatedLayout>
      </Route>

      <Route path="/venue-events/:id" component={VenueEventDetailPage} />

      <Route path="/venue/:id" component={VenueDetailPage} />
      
      <Route path="/join/:code" component={JoinGroupPage} />
      
      {/* Admin Panel Routes - Completely Separate from User App */}
      <Route path="/admin" component={AdminLogin} />
      <Route path="/admin/setup" component={AdminSetup} />
      <Route path="/admin/dashboard" component={AdminDashboard} />
      <Route path="/admin/users" component={AdminUsers} />
      <Route path="/admin/events" component={AdminEvents} />
      <Route path="/admin/stories" component={AdminStories} />
      <Route path="/admin/reports" component={AdminReports} />
      <Route path="/admin/finance" component={AdminFinance} />
      <Route path="/admin/staff" component={AdminStaff} />
      <Route path="/admin/activity" component={AdminActivity} />
      
      <Route component={NotFound} />
    </Switch>
  );
}

function SWUpdatePrompt() {
  const { toast } = useToast();

  useEffect(() => {
    const handler = (event: Event) => {
      const registration = (event as CustomEvent).detail as ServiceWorkerRegistration;
      toast({
        title: "Update Available",
        description: "A new version of Vib3Pulse is available.",
        action: (
          <ToastAction
            altText="Refresh"
            onClick={() => {
              registration.waiting?.postMessage({ type: "SKIP_WAITING" });
              window.location.reload();
            }}
            data-testid="button-sw-update"
          >
            Refresh
          </ToastAction>
        ),
      });
    };
    window.addEventListener("sw-update-available", handler);
    return () => window.removeEventListener("sw-update-available", handler);
  }, [toast]);

  return null;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <SWUpdatePrompt />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
