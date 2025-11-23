import { BuddySettings } from "@/components/buddy/BuddySettings";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { ArrowLeft, Shield } from "lucide-react";

export default function BuddySettingsPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto p-4 space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/discover">
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Shield className="h-6 w-6 text-primary" />
              Safety Buddy Settings
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Configure your emergency contact and distress message
            </p>
          </div>
        </div>

        <BuddySettings />
      </div>
    </div>
  );
}
