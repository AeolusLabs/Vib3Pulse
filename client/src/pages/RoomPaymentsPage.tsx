// /rooms/payments: the app's navigation around the PaymentsView body (components/rooms/earnings). Signed in only (AuthenticatedLayout
// in App.tsx); the server answers for the signed-in user only, whatever the page asks.
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import PaymentsView from "@/components/rooms/earnings/PaymentsView";

export default function RoomPaymentsPage() {
  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />
      <main className="mx-auto max-w-lg px-4 py-8">
        <PaymentsView />
      </main>
      <BottomNavigation />
    </div>
  );
}
