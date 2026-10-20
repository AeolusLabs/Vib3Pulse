// /rooms/payouts: the app's navigation around the PayoutAccountView body (components/rooms/earnings). Signed in only (AuthenticatedLayout
// in App.tsx); the server answers for the signed-in user only, whatever the page asks.
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import PayoutAccountView from "@/components/rooms/earnings/PayoutAccountView";

export default function RoomPayoutsPage() {
  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />
      <main className="mx-auto max-w-lg px-4 py-8">
        <PayoutAccountView />
      </main>
      <BottomNavigation />
    </div>
  );
}
