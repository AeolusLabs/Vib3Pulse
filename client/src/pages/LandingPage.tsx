import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  Dumbbell,
  MapPin,
  ArrowRight,
  ChevronRight,
  ExternalLink,
  Clock
} from "lucide-react";
import { format } from "date-fns";
import type { Event } from "@shared/schema";

export default function LandingPage() {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);

  const { data: featuredEvents = [], isLoading: isFeaturedLoading } = useQuery<Event[]>({
    queryKey: ['/api/events/featured'],
  });

  const { data: categoryEvents = [], isLoading: isCategoryLoading } = useQuery<Event[]>({
    queryKey: ['/api/events/by-category', selectedCategory],
    enabled: !!selectedCategory,
  });

  const eventCategories = [
    { 
      icon: Music, 
      label: "Music", 
      value: "music",
      gradient: "from-purple-600 to-pink-600",
      bgGradient: "from-purple-900/40 to-pink-900/40"
    },
    { 
      icon: Utensils, 
      label: "Food & Drink", 
      value: "food",
      gradient: "from-orange-500 to-red-500",
      bgGradient: "from-orange-900/40 to-red-900/40"
    },
    { 
      icon: Code, 
      label: "Tech", 
      value: "tech",
      gradient: "from-blue-500 to-cyan-500",
      bgGradient: "from-blue-900/40 to-cyan-900/40"
    },
    { 
      icon: Palette, 
      label: "Arts", 
      value: "art",
      gradient: "from-pink-500 to-rose-500",
      bgGradient: "from-pink-900/40 to-rose-900/40"
    },
    { 
      icon: Trophy, 
      label: "Sports", 
      value: "sports",
      gradient: "from-green-500 to-emerald-500",
      bgGradient: "from-green-900/40 to-emerald-900/40"
    },
    { 
      icon: Dumbbell, 
      label: "Wellness", 
      value: "wellness",
      gradient: "from-teal-500 to-cyan-500",
      bgGradient: "from-teal-900/40 to-cyan-900/40"
    }
  ];

  const features = [
    {
      icon: Calendar,
      title: "Discover Events",
      description: "Find amazing events tailored to your interests"
    },
    {
      icon: Users,
      title: "Build Community",
      description: "Connect with like-minded event lovers"
    },
    {
      icon: Ticket,
      title: "Easy Ticketing",
      description: "Secure purchasing with instant confirmation"
    },
    {
      icon: MessageCircle,
      title: "Direct Messaging",
      description: "Coordinate plans with friends"
    },
    {
      icon: TrendingUp,
      title: "Smart Feed",
      description: "Personalized recommendations just for you"
    },
    {
      icon: Heart,
      title: "RSVP & Share",
      description: "Show interest and share with your network"
    }
  ];

  const handleCategoryClick = (categoryValue: string) => {
    setSelectedCategory(categoryValue);
  };

  const handleEventClick = (event: Event) => {
    setSelectedEvent(event);
  };

  const formatEventDate = (date: Date | string) => {
    const d = typeof date === 'string' ? new Date(date) : date;
    return format(d, "EEE, MMM d");
  };

  const formatEventTime = (date: Date | string) => {
    const d = typeof date === 'string' ? new Date(date) : date;
    return format(d, "h:mm a");
  };

  return (
    <div className="dark min-h-screen bg-[#0a0a0a] text-white">
      <header className="sticky top-0 z-50 border-b border-white/10 bg-[#0a0a0a]/95 backdrop-blur supports-[backdrop-filter]:bg-[#0a0a0a]/80">
        <div className="container flex h-16 items-center justify-between max-w-7xl mx-auto px-4">
          <div className="flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-purple-400" />
            <h1 className="font-playfair text-2xl font-bold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
              VibePulse
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/login">
              <Button variant="ghost" className="text-white/80 hover:text-white hover:bg-white/10" data-testid="button-header-login">
                Log In
              </Button>
            </Link>
            <Link href="/signup">
              <Button className="bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white border-0" data-testid="button-header-signup">
                Sign Up
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <section className="relative min-h-[80vh] flex items-center justify-center overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-purple-900/30 via-[#0a0a0a] to-pink-900/20" />
        <div className="absolute inset-0">
          <div className="absolute top-20 left-10 w-72 h-72 bg-purple-500/20 rounded-full blur-3xl animate-pulse" />
          <div className="absolute bottom-20 right-10 w-96 h-96 bg-pink-500/15 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-purple-600/5 rounded-full blur-3xl" />
        </div>
        
        <div className="container max-w-7xl mx-auto px-4 relative z-10">
          <div className="max-w-4xl mx-auto text-center">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 border border-white/10 mb-8">
              <Sparkles className="w-4 h-4 text-purple-400" />
              <span className="text-sm text-white/70">Discover your next experience</span>
            </div>
            
            <h2 className="font-playfair text-5xl md:text-7xl lg:text-8xl font-bold mb-6 leading-tight">
              Find Events That
              <span className="block bg-gradient-to-r from-purple-400 via-pink-400 to-purple-400 bg-clip-text text-transparent">
                Match Your Vibe
              </span>
            </h2>
            
            <p className="text-xl md:text-2xl text-white/60 mb-10 max-w-2xl mx-auto leading-relaxed">
              Join thousands discovering concerts, workshops, meetups, and more. 
              Connect with friends and never miss out.
            </p>
            
            <div className="flex flex-col sm:flex-row gap-4 justify-center mb-16">
              <Link href="/signup">
                <Button size="lg" className="text-lg px-8 h-14 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white border-0 shadow-lg shadow-purple-500/25" data-testid="button-hero-signup">
                  Get Started Free
                  <ArrowRight className="ml-2 w-5 h-5" />
                </Button>
              </Link>
              <Link href="/login">
                <Button size="lg" variant="outline" className="text-lg px-8 h-14 bg-white/5 border-white/20 text-white hover:bg-white/10 hover:border-white/30" data-testid="button-hero-login">
                  Log In
                </Button>
              </Link>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 max-w-5xl mx-auto">
              {eventCategories.map((category) => (
                <button
                  key={category.label}
                  onClick={() => handleCategoryClick(category.value)}
                  className={`group relative overflow-hidden rounded-xl p-4 transition-all duration-300 hover:scale-105 hover:shadow-xl cursor-pointer bg-gradient-to-br ${category.bgGradient} border border-white/10 hover:border-white/20`}
                  data-testid={`button-category-${category.value}`}
                >
                  <div className={`absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-br ${category.gradient}`} style={{ opacity: 0.15 }} />
                  <div className="relative flex flex-col items-center gap-2">
                    <div className={`p-3 rounded-lg bg-gradient-to-br ${category.gradient}`}>
                      <category.icon className="w-6 h-6 text-white" />
                    </div>
                    <span className="text-sm font-medium text-white/90">{category.label}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {featuredEvents.length > 0 && (
        <section className="py-20 relative">
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-purple-900/5 to-transparent" />
          <div className="container max-w-7xl mx-auto px-4 relative">
            <div className="flex items-center justify-between mb-10">
              <div>
                <h3 className="font-playfair text-3xl md:text-4xl font-bold text-white mb-2">
                  Upcoming Events
                </h3>
                <p className="text-white/50">Don't miss out on these experiences</p>
              </div>
              <Link href="/signup">
                <Button variant="ghost" className="text-purple-400 hover:text-purple-300 hover:bg-purple-500/10">
                  View All
                  <ChevronRight className="ml-1 w-4 h-4" />
                </Button>
              </Link>
            </div>

            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
              {isFeaturedLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="rounded-xl bg-white/5 animate-pulse h-72" />
                ))
              ) : (
                featuredEvents.slice(0, 4).map((event) => (
                  <button
                    key={event.id}
                    onClick={() => handleEventClick(event)}
                    className="group relative overflow-hidden rounded-xl bg-white/5 border border-white/10 hover:border-white/20 transition-all duration-300 hover:scale-[1.02] hover:shadow-xl text-left"
                    data-testid={`button-event-${event.id}`}
                  >
                    <div className="aspect-[4/3] relative overflow-hidden">
                      {event.imageUrl ? (
                        <img 
                          src={event.imageUrl} 
                          alt={event.title}
                          className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                        />
                      ) : (
                        <div className="w-full h-full bg-gradient-to-br from-purple-600/30 to-pink-600/30 flex items-center justify-center">
                          <Calendar className="w-12 h-12 text-white/30" />
                        </div>
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                      <div className="absolute top-3 left-3">
                        <Badge className="bg-white/20 backdrop-blur-sm text-white border-0 text-xs">
                          {event.category}
                        </Badge>
                      </div>
                      {event.externalTicketUrl && (
                        <div className="absolute top-3 right-3">
                          <Badge className="bg-blue-500/80 backdrop-blur-sm text-white border-0 text-xs">
                            <ExternalLink className="w-3 h-3 mr-1" />
                            External
                          </Badge>
                        </div>
                      )}
                    </div>
                    <div className="p-4">
                      <h4 className="font-semibold text-white mb-2 line-clamp-1 group-hover:text-purple-300 transition-colors">
                        {event.title}
                      </h4>
                      <div className="flex items-center gap-2 text-white/50 text-sm mb-1">
                        <Clock className="w-3.5 h-3.5" />
                        <span>{formatEventDate(event.eventDate)} at {formatEventTime(event.eventDate)}</span>
                      </div>
                      {event.location && (
                        <div className="flex items-center gap-2 text-white/40 text-sm">
                          <MapPin className="w-3.5 h-3.5" />
                          <span className="line-clamp-1">{event.location}</span>
                        </div>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </section>
      )}

      <section className="py-20 relative">
        <div className="container max-w-7xl mx-auto px-4">
          <div className="text-center mb-16">
            <h3 className="font-playfair text-3xl md:text-4xl font-bold text-white mb-4">
              Everything You Need
            </h3>
            <p className="text-lg text-white/50 max-w-2xl mx-auto">
              Discover, connect, and experience the best events in your area
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {features.map((feature) => (
              <div 
                key={feature.title} 
                className="group p-6 rounded-xl bg-white/5 border border-white/10 hover:border-white/20 transition-all duration-300"
              >
                <div className="flex items-start gap-4">
                  <div className="p-3 rounded-lg bg-gradient-to-br from-purple-500/20 to-pink-500/20 group-hover:from-purple-500/30 group-hover:to-pink-500/30 transition-colors">
                    <feature.icon className="w-6 h-6 text-purple-400" />
                  </div>
                  <div>
                    <h4 className="text-lg font-semibold text-white mb-1">{feature.title}</h4>
                    <p className="text-white/50 text-sm">{feature.description}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-purple-900/20 via-transparent to-pink-900/20" />
        <div className="container max-w-4xl mx-auto px-4 text-center relative">
          <h3 className="font-playfair text-4xl md:text-5xl font-bold text-white mb-6">
            Ready to Find Your Vibe?
          </h3>
          <p className="text-xl text-white/50 mb-10">
            Join thousands discovering amazing experiences every day
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/signup">
              <Button size="lg" className="text-lg px-10 h-14 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white border-0 shadow-lg shadow-purple-500/25" data-testid="button-cta-signup">
                Create Your Account
                <ArrowRight className="ml-2 w-5 h-5" />
              </Button>
            </Link>
            <Link href="/login">
              <Button size="lg" variant="outline" className="text-lg px-10 h-14 bg-white/5 border-white/20 text-white hover:bg-white/10 hover:border-white/30" data-testid="button-cta-login">
                Log In
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/10 py-10 bg-black/30">
        <div className="container max-w-7xl mx-auto px-4 text-center">
          <div className="flex items-center justify-center gap-2 mb-3">
            <Sparkles className="w-5 h-5 text-purple-400" />
            <span className="font-playfair text-xl font-bold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">VibePulse</span>
          </div>
          <p className="text-white/40 text-sm">Discover events that match your vibe</p>
        </div>
      </footer>

      <Dialog open={!!selectedCategory} onOpenChange={() => setSelectedCategory(null)}>
        <DialogContent className="dark bg-[#0a0a0a] border-white/10 text-white max-w-4xl max-h-[85vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3 text-2xl">
              {eventCategories.find(c => c.value === selectedCategory)?.icon && (
                <div className={`p-2 rounded-lg bg-gradient-to-br ${eventCategories.find(c => c.value === selectedCategory)?.gradient}`}>
                  {(() => {
                    const CategoryIcon = eventCategories.find(c => c.value === selectedCategory)?.icon;
                    return CategoryIcon ? <CategoryIcon className="w-5 h-5 text-white" /> : null;
                  })()}
                </div>
              )}
              {eventCategories.find(c => c.value === selectedCategory)?.label} Events
            </DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh] pr-4">
            {isCategoryLoading ? (
              <div className="grid gap-4">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-24 rounded-xl bg-white/5 animate-pulse" />
                ))}
              </div>
            ) : categoryEvents.length === 0 ? (
              <div className="text-center py-12">
                <Calendar className="w-16 h-16 text-white/20 mx-auto mb-4" />
                <p className="text-white/50 text-lg">No events in this category yet</p>
                <p className="text-white/30 text-sm mt-2">Check back later for new events</p>
              </div>
            ) : (
              <div className="grid gap-3">
                {categoryEvents.map((event) => (
                  <button
                    key={event.id}
                    onClick={() => {
                      setSelectedCategory(null);
                      setSelectedEvent(event);
                    }}
                    className="flex gap-4 p-4 rounded-xl bg-white/5 border border-white/10 hover:border-white/20 hover:bg-white/10 transition-all text-left group"
                    data-testid={`button-category-event-${event.id}`}
                  >
                    <div className="w-24 h-24 rounded-lg overflow-hidden flex-shrink-0">
                      {event.imageUrl ? (
                        <img src={event.imageUrl} alt={event.title} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full bg-gradient-to-br from-purple-600/30 to-pink-600/30 flex items-center justify-center">
                          <Calendar className="w-8 h-8 text-white/30" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <h4 className="font-semibold text-white group-hover:text-purple-300 transition-colors line-clamp-1">
                          {event.title}
                        </h4>
                        {event.externalTicketUrl && (
                          <Badge className="bg-blue-500/80 text-white border-0 text-xs flex-shrink-0">
                            <ExternalLink className="w-3 h-3 mr-1" />
                            External
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-white/50 text-sm mb-1">
                        <Clock className="w-3.5 h-3.5 flex-shrink-0" />
                        <span>{formatEventDate(event.eventDate)} at {formatEventTime(event.eventDate)}</span>
                      </div>
                      {event.location && (
                        <div className="flex items-center gap-2 text-white/40 text-sm">
                          <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
                          <span className="line-clamp-1">{event.location}</span>
                        </div>
                      )}
                      {event.ticketPrice !== undefined && event.ticketPrice > 0 && !event.externalTicketUrl && (
                        <div className="flex items-center gap-2 text-purple-400 text-sm mt-1">
                          <Ticket className="w-3.5 h-3.5 flex-shrink-0" />
                          <span>From ${(event.ticketPrice / 100).toFixed(2)}</span>
                        </div>
                      )}
                    </div>
                    <ChevronRight className="w-5 h-5 text-white/30 group-hover:text-white/60 transition-colors flex-shrink-0 self-center" />
                  </button>
                ))}
              </div>
            )}
          </ScrollArea>
          {categoryEvents.length > 0 && (
            <div className="pt-4 border-t border-white/10">
              <Link href="/signup">
                <Button className="w-full bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white border-0">
                  Sign up to get tickets
                  <ArrowRight className="ml-2 w-4 h-4" />
                </Button>
              </Link>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedEvent} onOpenChange={() => setSelectedEvent(null)}>
        <DialogContent className="dark bg-[#0a0a0a] border-white/10 text-white max-w-2xl max-h-[90vh] overflow-y-auto">
          {selectedEvent && (
            <>
              <div className="relative -mx-6 -mt-6 mb-4">
                <div className="aspect-video relative overflow-hidden rounded-t-lg">
                  {selectedEvent.imageUrl ? (
                    <img 
                      src={selectedEvent.imageUrl} 
                      alt={selectedEvent.title}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full bg-gradient-to-br from-purple-600/30 to-pink-600/30 flex items-center justify-center">
                      <Calendar className="w-20 h-20 text-white/30" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0a] via-transparent to-transparent" />
                  <div className="absolute top-4 left-4 flex gap-2">
                    <Badge className="bg-white/20 backdrop-blur-sm text-white border-0">
                      {selectedEvent.category}
                    </Badge>
                    {selectedEvent.externalTicketUrl && (
                      <Badge className="bg-blue-500/80 backdrop-blur-sm text-white border-0">
                        <ExternalLink className="w-3 h-3 mr-1" />
                        External
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
              
              <DialogHeader>
                <DialogTitle className="text-2xl font-bold text-white">
                  {selectedEvent.title}
                </DialogTitle>
              </DialogHeader>

              <div className="space-y-4 mt-4">
                <div className="flex items-center gap-3 text-white/70">
                  <Clock className="w-5 h-5 text-purple-400" />
                  <span>{format(new Date(selectedEvent.eventDate), "EEEE, MMMM d, yyyy 'at' h:mm a")}</span>
                </div>

                {selectedEvent.location && (
                  <div className="flex items-center gap-3 text-white/70">
                    <MapPin className="w-5 h-5 text-purple-400" />
                    <span>{selectedEvent.location}{selectedEvent.city && `, ${selectedEvent.city}`}</span>
                  </div>
                )}

                {selectedEvent.ticketPrice !== undefined && !selectedEvent.externalTicketUrl && (
                  <div className="flex items-center gap-3 text-white/70">
                    <Ticket className="w-5 h-5 text-purple-400" />
                    <span>
                      {selectedEvent.ticketPrice === 0 ? 'Free' : `From $${(selectedEvent.ticketPrice / 100).toFixed(2)}`}
                    </span>
                  </div>
                )}

                {selectedEvent.description && (
                  <div className="pt-4 border-t border-white/10">
                    <p className="text-white/60 leading-relaxed">{selectedEvent.description}</p>
                  </div>
                )}

                <div className="pt-4 flex flex-col gap-3">
                  {selectedEvent.externalTicketUrl ? (
                    <a 
                      href={selectedEvent.externalTicketUrl} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="block"
                    >
                      <Button className="w-full bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white border-0 h-12">
                        <ExternalLink className="mr-2 w-4 h-4" />
                        Get Tickets
                      </Button>
                    </a>
                  ) : (
                    <Link href="/signup">
                      <Button className="w-full bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white border-0 h-12">
                        Sign up to get tickets
                        <ArrowRight className="ml-2 w-4 h-4" />
                      </Button>
                    </Link>
                  )}
                  <p className="text-center text-white/40 text-sm">
                    Create an account to purchase tickets and RSVP
                  </p>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
