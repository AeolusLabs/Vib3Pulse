import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
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
import ManageVenuesPage from "@/pages/ManageVenuesPage";
import VenueDetailPage from "@/pages/VenueDetailPage";
import VenueEntryNightsPage from "@/pages/VenueEntryNightsPage";

function Router() {
  return (
    <Switch>
      <Route path="/" component={LandingPage} />
      <Route path="/login" component={LoginPage} />
      <Route path="/signup" component={SignupPage} />
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
      
      <Route path="/messages/:userId">
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
      
      <Route path="/manage-venues">
        <AuthenticatedLayout>
          <ManageVenuesPage />
        </AuthenticatedLayout>
      </Route>
      
      <Route path="/venues/:venueId/entry-nights">
        <AuthenticatedLayout>
          <VenueEntryNightsPage />
        </AuthenticatedLayout>
      </Route>
      
      <Route path="/venue/:id" component={VenueDetailPage} />
      
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
