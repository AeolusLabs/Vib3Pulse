import { BuddySettings } from "@/components/safety/BuddySettings";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";

export default function BuddySettingsPage() {
  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />
      <main className="max-w-2xl mx-auto px-4 py-8">
        <h1 className="text-3xl font-serif font-bold mb-6">Safety Settings</h1>
        <BuddySettings />
      </main>
      <BottomNavigation />
    </div>
  );
}
