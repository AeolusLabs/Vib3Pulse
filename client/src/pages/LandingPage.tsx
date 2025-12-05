import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { 
  Calendar, 
  Users, 
  Ticket, 
  MessageCircle, 
  TrendingUp, 
  Heart,
  Sparkles,
  Music,
  Utensils,
  Code,
  Palette,
  Trophy,
  Dumbbell
} from "lucide-react";

export default function LandingPage() {
  const features = [
    {
      icon: Calendar,
      title: "Discover Events",
      description: "Find amazing events tailored to your interests and location"
    },
    {
      icon: Users,
      title: "Connect with Others",
      description: "Follow friends, see what they're attending, and build your community"
    },
    {
      icon: Ticket,
      title: "Easy Ticketing",
      description: "Purchase tickets securely and manage your RSVPs all in one place"
    },
    {
      icon: MessageCircle,
      title: "Direct Messaging",
      description: "Chat with friends and coordinate plans before events"
    },
    {
      icon: TrendingUp,
      title: "Personalized Feed",
      description: "Get event recommendations based on your interests and activity"
    },
    {
      icon: Heart,
      title: "RSVP & Share",
      description: "Show interest in events and share them with your network"
    }
  ];

  const eventCategories = [
    { icon: Music, label: "Music", color: "text-purple-500" },
    { icon: Utensils, label: "Food & Drink", color: "text-orange-500" },
    { icon: Code, label: "Tech", color: "text-blue-500" },
    { icon: Palette, label: "Arts", color: "text-pink-500" },
    { icon: Trophy, label: "Sports", color: "text-green-500" },
    { icon: Dumbbell, label: "Wellness", color: "text-teal-500" }
  ];

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between max-w-7xl mx-auto px-4">
          <div className="flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-primary" />
            <h1 className="font-playfair text-2xl font-bold text-primary">
              VibePulse
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/login">
              <Button variant="ghost" data-testid="button-header-login">
                Log In
              </Button>
            </Link>
            <Link href="/signup">
              <Button data-testid="button-header-signup">
                Sign Up
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <section className="relative py-20 md:py-32 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-background to-accent/10" />
        <div className="container max-w-7xl mx-auto px-4 relative">
          <div className="max-w-3xl mx-auto text-center">
            <h2 className="font-playfair text-4xl md:text-6xl font-bold mb-6 text-foreground">
              Discover Events That Match Your{" "}
              <span className="text-primary">Vibe</span>
            </h2>
            <p className="text-xl text-muted-foreground mb-8 leading-relaxed">
              Join a vibrant community of event lovers. Find concerts, workshops, 
              meetups, and more. Connect with friends, buy tickets, and never miss 
              out on the experiences that matter to you.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link href="/signup">
                <Button size="lg" className="text-lg px-8" data-testid="button-hero-signup">
                  Get Started Free
                </Button>
              </Link>
              <Link href="/login">
                <Button size="lg" variant="outline" className="text-lg px-8" data-testid="button-hero-login">
                  Log In
                </Button>
              </Link>
            </div>
          </div>

          <div className="mt-16 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 max-w-4xl mx-auto">
            {eventCategories.map((category) => (
              <Card key={category.label} className="hover-elevate">
                <CardContent className="flex flex-col items-center justify-center p-6 gap-2">
                  <category.icon className={`w-8 h-8 ${category.color}`} />
                  <span className="text-sm font-medium text-center">{category.label}</span>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 bg-muted/30">
        <div className="container max-w-7xl mx-auto px-4">
          <div className="text-center mb-12">
            <h3 className="font-playfair text-3xl md:text-4xl font-bold mb-4">
              Everything You Need in One Place
            </h3>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Whether you're discovering new experiences or hosting your own events, 
              VibePulse has all the tools you need.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((feature) => (
              <Card key={feature.title} className="hover-elevate">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <feature.icon className="w-6 h-6 text-primary" />
                    </div>
                    <CardTitle className="text-xl">{feature.title}</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <CardDescription className="text-base">
                    {feature.description}
                  </CardDescription>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20">
        <div className="container max-w-7xl mx-auto px-4">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <h3 className="font-playfair text-3xl md:text-4xl font-bold mb-4">
                For Event Attendees
              </h3>
              <p className="text-lg text-muted-foreground mb-6">
                Follow your interests, discover events curated just for you, and 
                connect with like-minded people. Purchase tickets securely, manage 
                your RSVPs, and keep track of all your upcoming experiences.
              </p>
              <ul className="space-y-3">
                <li className="flex items-start gap-2">
                  <div className="p-1 rounded-full bg-primary/10 mt-0.5">
                    <div className="w-2 h-2 rounded-full bg-primary" />
                  </div>
                  <span>Personalized event recommendations based on your interests</span>
                </li>
                <li className="flex items-start gap-2">
                  <div className="p-1 rounded-full bg-primary/10 mt-0.5">
                    <div className="w-2 h-2 rounded-full bg-primary" />
                  </div>
                  <span>Secure ticket purchasing with instant confirmation</span>
                </li>
                <li className="flex items-start gap-2">
                  <div className="p-1 rounded-full bg-primary/10 mt-0.5">
                    <div className="w-2 h-2 rounded-full bg-primary" />
                  </div>
                  <span>Follow friends and see what events they're attending</span>
                </li>
                <li className="flex items-start gap-2">
                  <div className="p-1 rounded-full bg-primary/10 mt-0.5">
                    <div className="w-2 h-2 rounded-full bg-primary" />
                  </div>
                  <span>Direct messaging to coordinate plans</span>
                </li>
              </ul>
            </div>
            <div className="order-first md:order-last">
              <Card className="bg-gradient-to-br from-primary/5 to-accent/5 border-primary/20">
                <CardContent className="p-8">
                  <div className="aspect-square rounded-lg bg-gradient-to-br from-primary/20 to-accent/20 flex items-center justify-center">
                    <Users className="w-24 h-24 text-primary" />
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </section>

      <section className="py-20 bg-muted/30">
        <div className="container max-w-7xl mx-auto px-4">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <Card className="bg-gradient-to-br from-primary/5 to-accent/5 border-primary/20">
                <CardContent className="p-8">
                  <div className="aspect-square rounded-lg bg-gradient-to-br from-primary/20 to-accent/20 flex items-center justify-center">
                    <Calendar className="w-24 h-24 text-primary" />
                  </div>
                </CardContent>
              </Card>
            </div>
            <div>
              <h3 className="font-playfair text-3xl md:text-4xl font-bold mb-4">
                For Event Organizers
              </h3>
              <p className="text-lg text-muted-foreground mb-6">
                Create and manage events with powerful tools. Sell tickets, track 
                attendance, and grow your audience. Everything you need to make your 
                events successful.
              </p>
              <ul className="space-y-3">
                <li className="flex items-start gap-2">
                  <div className="p-1 rounded-full bg-primary/10 mt-0.5">
                    <div className="w-2 h-2 rounded-full bg-primary" />
                  </div>
                  <span>Easy event creation with customizable details and tickets</span>
                </li>
                <li className="flex items-start gap-2">
                  <div className="p-1 rounded-full bg-primary/10 mt-0.5">
                    <div className="w-2 h-2 rounded-full bg-primary" />
                  </div>
                  <span>Seamless payment processing for ticket sales</span>
                </li>
                <li className="flex items-start gap-2">
                  <div className="p-1 rounded-full bg-primary/10 mt-0.5">
                    <div className="w-2 h-2 rounded-full bg-primary" />
                  </div>
                  <span>Real-time analytics and attendance tracking</span>
                </li>
                <li className="flex items-start gap-2">
                  <div className="p-1 rounded-full bg-primary/10 mt-0.5">
                    <div className="w-2 h-2 rounded-full bg-primary" />
                  </div>
                  <span>Reach your target audience with category-based discovery</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="py-20 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-background to-accent/10" />
        <div className="container max-w-4xl mx-auto px-4 text-center relative">
          <h3 className="font-playfair text-3xl md:text-4xl font-bold mb-4">
            Ready to Find Your Vibe?
          </h3>
          <p className="text-lg text-muted-foreground mb-8">
            Join thousands of users discovering and creating amazing experiences
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/signup">
              <Button size="lg" className="text-lg px-8" data-testid="button-cta-signup">
                Create Your Account
              </Button>
            </Link>
            <Link href="/login">
              <Button size="lg" variant="outline" className="text-lg px-8" data-testid="button-cta-login">
                Log In
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t py-8 bg-muted/30">
        <div className="container max-w-7xl mx-auto px-4 text-center text-sm text-muted-foreground">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Sparkles className="w-4 h-4 text-primary" />
            <span className="font-playfair font-semibold text-primary">VibePulse</span>
          </div>
          <p>Discover events that match your vibe</p>
        </div>
      </footer>
    </div>
  );
}
