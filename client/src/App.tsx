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
import FeedPage from "@/pages/FeedPage";
import MyEventsPage from "@/pages/MyEventsPage";
import ChatPage from "@/pages/ChatPage";
import ConversationPage from "@/pages/ConversationPage";
import ManageEventsPage from "@/pages/ManageEventsPage";
import TicketWalletPage from "@/pages/TicketWalletPage";
import LoginPage from "@/pages/LoginPage";
import SignupPage from "@/pages/SignupPage";

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
      
      <Route path="/chat">
        <AuthenticatedLayout>
          <ChatPage />
        </AuthenticatedLayout>
      </Route>
      
      <Route path="/chat/:userId">
        {(params) => (
          <AuthenticatedLayout>
            <ConversationPage {...params} />
          </AuthenticatedLayout>
        )}
      </Route>
      
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
