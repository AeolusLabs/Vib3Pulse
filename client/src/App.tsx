import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import DiscoverPage from "@/pages/DiscoverPage";
import EventDetailPage from "@/pages/EventDetailPage";
import ProfilePage from "@/pages/ProfilePage";
import FeedPage from "@/pages/FeedPage";
import MyEventsPage from "@/pages/MyEventsPage";
import ChatPage from "@/pages/ChatPage";
import ManageEventsPage from "@/pages/ManageEventsPage";

function Router() {
  return (
    <Switch>
      <Route path="/" component={DiscoverPage} />
      <Route path="/feed" component={FeedPage} />
      <Route path="/my-events" component={MyEventsPage} />
      <Route path="/manage-events" component={ManageEventsPage} />
      <Route path="/chat" component={ChatPage} />
      <Route path="/event/:id" component={EventDetailPage} />
      <Route path="/profile/:username" component={ProfilePage} />
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
