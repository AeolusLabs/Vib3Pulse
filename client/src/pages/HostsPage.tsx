import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";

export default function HostsPage() {
  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation userType="social" />

      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-3xl font-serif font-bold mb-6">Hosts</h1>
        <div className="text-center py-16">
          <p className="text-muted-foreground text-lg">Coming soon...</p>
        </div>
      </main>

      <BottomNavigation onCreateClick={() => console.log('Create clicked')} />
    </div>
  );
}
