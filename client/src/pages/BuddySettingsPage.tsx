import { Button } from "@/components/ui/button";
import { BuddySettings } from "@/components/safety/BuddySettings";
import { ChevronLeft } from "lucide-react";

export default function BuddySettingsPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto p-4 space-y-6">
        <header className="flex items-center gap-3 py-2">
          <Button variant="ghost" size="icon" onClick={() => window.history.back()} aria-label="Go back">
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-xl font-semibold">Safety Settings</h1>
        </header>
        <BuddySettings />
      </div>
    </div>
  );
}
