import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { motion } from "framer-motion";

import { format } from "date-fns";
import type { Event } from "@shared/schema";
import { CalendarIcon, TicketIcon, MapPinIcon, ArrowRightIcon, ChevronRightIcon, ExternalLinkIcon, ClockIcon, MusicIcon, PaletteIcon, ShieldIcon, UsersIcon } from "@/components/ui/icons";
import { Utensils, Code, Trophy, Dumbbell } from "lucide-react";

const inView = {
  hidden: { opacity: 0, y: 28 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.65, ease: [0.22, 1, 0.36, 1] },
  },
};

const heroEyebrow = {
  hidden: { opacity: 0, y: 14 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] } },
};

const heroHeadline = {
  hidden: { opacity: 0, y: 52 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.85, ease: [0.22, 1, 0.36, 1] } },
};

const stagger = {
  visible: { transition: { staggerChildren: 0.09 } },
};

export default function LandingPage() {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);

  const { data: featuredEvents = [], isLoading: isFeaturedLoading } = useQuery<Event[]>({
    queryKey: ["/api/events/featured"],
  });

  const { data: categoryEvents = [], isLoading: isCategoryLoading } = useQuery<Event[]>({
    queryKey: ["/api/events/by-category", selectedCategory],
    enabled: !!selectedCategory,
  });

  const eventCategories = [
    { icon: MusicIcon,   label: "Music",       value: "music"   },
    { icon: Utensils,    label: "Food & Drink", value: "food"    },
    { icon: Code,        label: "Tech",         value: "tech"    },
    { icon: PaletteIcon, label: "Arts",         value: "art"     },
    { icon: Trophy,      label: "Sports",       value: "sports"  },
    { icon: Dumbbell,    label: "Wellness",     value: "wellness" },
  ];

  const pillars = [
    {
      number: "01",
      icon: CalendarIcon,
      title: "Discover Events",
      desc: "Find concerts, club nights, exhibitions, and more. Curated for your city and your taste.",
    },
    {
      number: "02",
      icon: TicketIcon,
      title: "Buy Tickets",
      desc: "Secure in-app ticketing with instant QR codes. Everything lives in your digital wallet.",
    },
    {
      number: "03",
      icon: UsersIcon,
      title: "Plan Together",
      desc: "Group chats, shared polls, and stories from the night. Your crew, all in one place.",
    },
    {
      number: "04",
      icon: ShieldIcon,
      title: "Stay Safe",
      desc: "Safety Buddy, check-in timers, and one-tap SOS alerts. Go out with confidence.",
    },
  ];

  const formatEventDate = (date: Date | string) => {
    const d = typeof date === "string" ? new Date(date) : date;
    return format(d, "EEE, MMM d");
  };

  const formatEventTime = (date: Date | string) => {
    const d = typeof date === "string" ? new Date(date) : date;
    return format(d, "h:mm a");
  };

  const formatPrice = (event: Event) => {
    if (event.ticketPrice === undefined || event.ticketPrice === null) return null;
    if (event.ticketPrice === 0) return "Free";
    const currency = (event as any).currency;
    const symbol = currency === "NGN" ? "₦" : "£";
    return `From ${symbol}${(event.ticketPrice / 100).toFixed(0)}`;
  };

  return (
    <div className="min-h-screen bg-[#090909] text-white font-sans">

      {/* ─── Navigation ──────────────────────────────────────────────── */}
      <header className="fixed top-0 left-0 right-0 z-50 border-b border-white/[0.06] bg-[#090909]/90 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="no-underline">
            <span className="font-serif text-[1.4rem] font-bold text-white tracking-tight select-none">
              Vib3Pulse
            </span>
          </Link>
          <nav className="flex items-center gap-1">
            <Link href="/login">
              <Button
                variant="ghost"
                className="text-white/60 hover:text-white hover:bg-white/[0.06] rounded-full px-5 h-9 text-sm transition-colors duration-200"
                data-testid="button-header-login"
              >
                Sign In
              </Button>
            </Link>
            <Link href="/signup">
              <Button
                className="bg-violet-600 hover:bg-violet-500 active:scale-[0.97] text-white rounded-full px-5 h-9 text-sm border-0 shadow-lg shadow-violet-600/20 transition-all duration-200"
                data-testid="button-header-signup"
              >
                Join Free
              </Button>
            </Link>
          </nav>
        </div>
      </header>

      {/* ─── Hero ────────────────────────────────────────────────────── */}
      <section className="relative min-h-screen flex flex-col justify-center pt-16 overflow-hidden">
        {/* Subtle noise texture */}
        <div
          className="absolute inset-0 opacity-[0.018] pointer-events-none"
          style={{
            backgroundImage:
              'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 200 200\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.85\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\'/%3E%3C/svg%3E")',
            backgroundSize: "180px",
          }}
        />
        {/* Violet glows — more visible, atmospheric */}
        <div className="absolute top-1/4 -left-1/4 w-[800px] h-[800px] bg-violet-600/[0.14] rounded-full blur-[140px] pointer-events-none" />
        <div className="absolute bottom-0 right-0 w-[500px] h-[500px] bg-violet-900/[0.16] rounded-full blur-[120px] pointer-events-none" />

        <div className="max-w-7xl mx-auto px-6 py-28 lg:py-32">
          <motion.div
            initial="hidden"
            animate="visible"
            variants={stagger}
            className="max-w-5xl"
          >
            {/* Eyebrow */}
            <motion.p
              variants={heroEyebrow}
              className="text-white/50 text-[0.7rem] tracking-[0.3em] uppercase mb-12 font-sans"
            >
              Every City Has a Pulse. Find Yours.
            </motion.p>

            {/* Giant editorial headline */}
            <motion.h1
              variants={heroHeadline}
              className="font-serif font-bold uppercase leading-[0.88] tracking-[-0.02em] text-white mb-10"
              style={{ fontSize: "clamp(3.8rem, 13vw, 11.5rem)" }}
            >
              Find
              <br />
              Your
              <br />
              <span className="text-violet-400">Vib3.</span>
            </motion.h1>

            {/* Subline */}
            <motion.p
              variants={inView}
              className="text-base md:text-lg text-white/60 max-w-sm leading-relaxed mb-12 font-sans"
            >
              Events. Tickets. Community. Safety.
              <br />
              All in one place.
            </motion.p>

            {/* CTAs */}
            <motion.div
              variants={inView}
              className="flex flex-wrap items-center gap-3 mb-20"
            >
              <Link href="/signup">
                <Button
                  size="lg"
                  className="h-12 px-8 bg-violet-600 hover:bg-violet-500 active:scale-[0.97] text-white rounded-full border-0 font-sans font-medium text-base shadow-xl shadow-violet-600/25 transition-all duration-200"
                  data-testid="button-hero-signup"
                >
                  Get Started
                  <ArrowRightIcon className="ml-2 w-4 h-4" />
                </Button>
              </Link>
              <Link href="/login">
                <Button
                  size="lg"
                  variant="ghost"
                  className="h-12 px-7 text-white/60 hover:text-white hover:bg-white/[0.06] active:scale-[0.97] rounded-full font-sans text-base transition-all duration-200"
                  data-testid="button-hero-login"
                >
                  Sign In
                </Button>
              </Link>
            </motion.div>

            {/* Category pills */}
            <motion.div variants={inView} className="flex flex-wrap gap-2">
              {eventCategories.map((cat) => (
                <motion.button
                  key={cat.value}
                  onClick={() => setSelectedCategory(cat.value)}
                  whileHover={{ y: -3 }}
                  whileTap={{ scale: 0.93 }}
                  transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                  className={`flex items-center gap-2 px-4 py-2 rounded-full border text-sm font-sans transition-colors duration-200 cursor-pointer ${
                    selectedCategory === cat.value
                      ? "bg-violet-600/20 border-violet-500/40 text-violet-300"
                      : "border-white/[0.1] bg-white/[0.04] hover:bg-white/[0.08] hover:border-white/20 text-white/60 hover:text-white"
                  }`}
                  data-testid={`button-category-${cat.value}`}
                >
                  <cat.icon className="w-3.5 h-3.5" />
                  {cat.label}
                </motion.button>
              ))}
            </motion.div>
          </motion.div>
        </div>

        {/* Scroll indicator */}
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5">
          <div className="w-1 h-1 rounded-full bg-white/20 animate-bounce" />
          <div className="w-px h-12 bg-gradient-to-b from-white/15 to-transparent" />
        </div>
      </section>

      {/* ─── Social Proof Belt ───────────────────────────────────────── */}
      <div className="border-y border-white/[0.06]">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex flex-col sm:flex-row items-center justify-center divide-y sm:divide-y-0 sm:divide-x divide-white/[0.08]">
            {[
              { value: "6", label: "Event Categories" },
              { value: "2", label: "Cities Live" },
              { value: "Free", label: "Always Free to Join" },
            ].map((stat) => (
              <div key={stat.label} className="flex flex-col items-center py-7 px-10 sm:px-14 gap-1">
                <span className="font-serif text-2xl font-bold text-white/80">{stat.value}</span>
                <span className="text-white/40 text-xs font-sans tracking-wide">{stat.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ─── Featured Events ─────────────────────────────────────────── */}
      {(isFeaturedLoading || featuredEvents.length > 0) && (
        <section className="py-28">
          <div className="max-w-7xl mx-auto px-6">
            <div className="flex items-end justify-between mb-14">
              <div>
                <p className="text-white/45 text-[0.65rem] tracking-[0.28em] uppercase font-sans mb-3">
                  Upcoming
                </p>
                <h2 className="font-serif text-4xl md:text-5xl font-bold text-white tracking-tight">
                  Events
                </h2>
              </div>
              <Link href="/signup">
                <button
                  className="flex items-center gap-1 text-sm text-white/40 hover:text-white/70 transition-colors font-sans cursor-pointer"
                  data-testid="button-view-all"
                >
                  View all
                  <ChevronRightIcon className="w-4 h-4" />
                </button>
              </Link>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {isFeaturedLoading
                ? Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="rounded-2xl bg-white/[0.04] animate-pulse h-64" />
                  ))
                : featuredEvents.slice(0, 4).map((event, idx) => (
                    <motion.button
                      key={event.id}
                      onClick={() => setSelectedEvent(event)}
                      className={`group relative overflow-hidden rounded-2xl bg-[#111111] border border-white/[0.1] hover:border-violet-500/30 transition-all duration-300 text-left cursor-pointer ${
                        idx === 0 ? "sm:col-span-2" : ""
                      }`}
                      whileHover={{ y: -3, transition: { duration: 0.2 } }}
                      initial={{ opacity: 0, y: 20 }}
                      whileInView={{ opacity: 1, y: 0 }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.5, delay: idx * 0.07, ease: [0.22, 1, 0.36, 1] }}
                      data-testid={`button-event-${event.id}`}
                    >
                      <div
                        className={`relative overflow-hidden ${
                          idx === 0 ? "aspect-[2/1] sm:aspect-[16/7]" : "aspect-[4/3]"
                        }`}
                      >
                        {event.imageUrl ? (
                          <img
                            src={event.imageUrl}
                            alt={event.title}
                            className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.06]"
                            loading="lazy"
                          />
                        ) : (
                          <div className="w-full h-full bg-gradient-to-br from-violet-900/25 to-[#0f0f0f] flex items-center justify-center">
                            <CalendarIcon className="w-10 h-10 text-white/10" />
                          </div>
                        )}
                        {/* Gradient overlay */}
                        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent" />

                        {/* Category badge */}
                        <div className="absolute top-3 left-3">
                          <span className="text-[0.6rem] font-sans font-medium tracking-[0.18em] uppercase text-white/60 px-2.5 py-1 rounded-full bg-black/40 backdrop-blur-sm border border-white/[0.08]">
                            {event.category}
                          </span>
                        </div>

                        {event.externalTicketUrl && (
                          <div className="absolute top-3 right-3">
                            <span className="text-[0.6rem] font-sans font-medium tracking-[0.18em] uppercase text-violet-300 px-2.5 py-1 rounded-full bg-violet-600/25 backdrop-blur-sm border border-violet-500/20">
                              External
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Card content */}
                      <div className={`absolute bottom-0 left-0 right-0 p-4 ${idx === 0 ? "p-5" : ""}`}>
                        <h3
                          className={`font-sans font-semibold text-white line-clamp-1 mb-1.5 group-hover:text-violet-300 transition-colors duration-200 ${
                            idx === 0 ? "text-base sm:text-lg" : "text-sm"
                          }`}
                        >
                          {event.title}
                        </h3>
                        <div className="flex items-center justify-between gap-3 text-white/40 text-xs font-sans">
                          <div className="flex items-center gap-3 min-w-0">
                            <span className="flex items-center gap-1.5 flex-shrink-0">
                              <ClockIcon className="w-3 h-3" />
                              {formatEventDate(event.eventDate)}
                            </span>
                            {event.location && (
                              <span className="flex items-center gap-1.5 min-w-0">
                                <MapPinIcon className="w-3 h-3 flex-shrink-0" />
                                <span className="truncate">{event.location}</span>
                              </span>
                            )}
                          </div>
                          {!event.externalTicketUrl && formatPrice(event) && (
                            <span className="text-violet-400/80 flex-shrink-0 flex items-center gap-1">
                              <TicketIcon className="w-3 h-3" />
                              {formatPrice(event)}
                            </span>
                          )}
                        </div>
                      </div>
                    </motion.button>
                  ))}
            </div>
          </div>
        </section>
      )}

      {/* ─── Rule ────────────────────────────────────────────────────── */}
      <div className="max-w-7xl mx-auto px-6">
        <div className="h-px bg-white/[0.06]" />
      </div>

      {/* ─── Pillars ─────────────────────────────────────────────────── */}
      <section className="py-28">
        <div className="max-w-7xl mx-auto px-6">
          <p className="text-white/45 text-[0.65rem] tracking-[0.28em] uppercase font-sans mb-14">
            Why Vib3Pulse
          </p>

          {/* Card grid — gap-px on a white/[0.06] background creates hairline dividers */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px bg-white/[0.06]">
            {pillars.map((pillar, idx) => (
              <motion.div
                key={pillar.number}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.55, delay: idx * 0.09, ease: [0.22, 1, 0.36, 1] }}
                className="relative bg-[#090909] p-8 flex flex-col gap-5"
              >
                {/* Icon chip */}
                <div className="w-9 h-9 rounded-xl bg-violet-600/[0.12] flex items-center justify-center flex-shrink-0">
                  <pillar.icon className="w-4 h-4 text-violet-400" />
                </div>

                <div>
                  <h3 className="font-sans font-semibold text-white text-base mb-2.5 tracking-tight">
                    {pillar.title}
                  </h3>
                  <p className="font-sans text-white/55 text-sm leading-relaxed">
                    {pillar.desc}
                  </p>
                </div>

                {/* Number — editorial detail, bottom-right */}
                <span className="absolute bottom-6 right-6 text-white/[0.18] font-sans text-[0.6rem] tracking-[0.22em]">
                  {pillar.number}
                </span>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Rule ────────────────────────────────────────────────────── */}
      <div className="max-w-7xl mx-auto px-6">
        <div className="h-px bg-white/[0.06]" />
      </div>

      {/* ─── Safety callout ──────────────────────────────────────────── */}
      <section className="py-28">
        <div className="max-w-7xl mx-auto px-6">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
            className="rounded-3xl bg-[#0e0e0e] border border-white/[0.08] p-10 md:p-16 relative overflow-hidden"
          >
            {/* Subtle glow */}
            <div className="absolute top-0 right-0 w-72 h-72 bg-violet-600/[0.1] rounded-full blur-3xl pointer-events-none" />

            <div className="relative max-w-2xl">
              <div className="flex items-center gap-2.5 mb-10">
                <ShieldIcon className="w-4 h-4 text-violet-400" />
                <span className="text-white/45 text-[0.65rem] font-sans tracking-[0.28em] uppercase">
                  Safety First
                </span>
              </div>
              <h2 className="font-serif text-3xl md:text-5xl lg:text-6xl font-bold text-white mb-7 leading-[1.05] tracking-tight">
                Go Out.
                <br />
                <span className="text-white/50">Come Home Safe.</span>
              </h2>
              <p className="font-sans text-white/60 text-base md:text-lg leading-relaxed mb-10 max-w-lg">
                Our Safety Buddy system lets you assign a trusted contact, set
                check-in timers before you head out, and send instant SOS alerts
                with your location. All in one tap.
              </p>
              <Link href="/signup">
                <Button
                  size="lg"
                  variant="outline"
                  className="h-11 px-7 rounded-full border-white/[0.18] text-white/70 bg-transparent hover:bg-white/[0.05] hover:text-white hover:border-white/30 active:scale-[0.97] font-sans text-sm transition-all duration-200"
                >
                  Learn More
                  <ArrowRightIcon className="ml-2 w-4 h-4" />
                </Button>
              </Link>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ─── CTA ─────────────────────────────────────────────────────── */}
      <section className="py-36">
        <div className="max-w-7xl mx-auto px-6 text-center">
          <motion.div
            initial={{ opacity: 0, y: 32 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          >
            <p className="text-white/45 text-[0.65rem] tracking-[0.28em] uppercase font-sans mb-10">
              Ready?
            </p>
            <h2
              className="font-serif font-bold text-white uppercase tracking-tight leading-[0.9] mb-14"
              style={{ fontSize: "clamp(2.8rem, 9vw, 8.5rem)" }}
            >
              Your Vib3
              <br />
              <span className="text-white/35">Starts Here.</span>
            </h2>
            <motion.div
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
              className="inline-block"
            >
              <Link href="/signup">
                <Button
                  size="lg"
                  className="h-14 px-12 bg-violet-600 hover:bg-violet-500 text-white rounded-full border-0 font-sans font-medium text-lg shadow-2xl shadow-violet-600/30 transition-colors duration-200"
                  data-testid="button-cta-signup"
                >
                  Create Account (it's free)
                  <ArrowRightIcon className="ml-2 w-5 h-5" />
                </Button>
              </Link>
            </motion.div>
            <p className="mt-5 text-white/30 text-sm font-sans">
              Already a member?{" "}
              <Link href="/login">
                <span className="text-violet-400/70 hover:text-violet-300 transition-colors cursor-pointer" data-testid="button-cta-login">
                  Sign in
                </span>
              </Link>
            </p>
            <p className="mt-3 text-white/25 text-sm font-sans">
              Organising events?{" "}
              <Link href="/signup">
                <span className="text-white/40 hover:text-white/70 transition-colors cursor-pointer">
                  List yours →
                </span>
              </Link>
            </p>
          </motion.div>
        </div>
      </section>

      {/* ─── Footer ──────────────────────────────────────────────────── */}
      <footer className="border-t border-white/[0.06] py-10">
        <div className="max-w-7xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-6">
          {/* Left: logo + city callout */}
          <div className="flex flex-col items-center sm:items-start gap-1">
            <span className="font-serif text-xl font-bold text-white/55 tracking-tight">
              Vib3Pulse
            </span>
            <span className="font-sans text-white/30 text-[0.65rem] tracking-[0.12em]">
              Lagos · London · More cities coming
            </span>
          </div>

          {/* Centre: nav links */}
          <nav className="flex items-center gap-5">
            {["Privacy", "Terms", "Contact"].map((link) => (
              <span
                key={link}
                className="font-sans text-white/25 hover:text-white/50 transition-colors text-xs cursor-pointer"
              >
                {link}
              </span>
            ))}
          </nav>

          {/* Right: copyright */}
          <p className="font-sans text-white/35 text-xs">
            © 2026 Vib3Pulse. All rights reserved.
          </p>
        </div>
      </footer>

      {/* ─── Category Dialog ─────────────────────────────────────────── */}
      <Dialog open={!!selectedCategory} onOpenChange={() => setSelectedCategory(null)}>
        <DialogContent className="bg-[#111111] border-white/[0.08] text-white max-w-2xl max-h-[85vh]">
          <DialogHeader>
            <DialogTitle className="font-sans text-lg font-semibold flex items-center gap-3">
              {(() => {
                const cat = eventCategories.find((c) => c.value === selectedCategory);
                if (!cat) return null;
                const Icon = cat.icon;
                return (
                  <>
                    <Icon className="w-5 h-5 text-violet-400" />
                    {cat.label} Events
                  </>
                );
              })()}
            </DialogTitle>
          </DialogHeader>

          <ScrollArea className="max-h-[58vh] pr-2">
            {isCategoryLoading ? (
              <div className="grid gap-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-20 rounded-xl bg-white/[0.04] animate-pulse" />
                ))}
              </div>
            ) : categoryEvents.length === 0 ? (
              <div className="text-center py-14">
                <CalendarIcon className="w-12 h-12 text-white/10 mx-auto mb-4" />
                <p className="text-white/35 font-sans text-sm">No events in this category yet</p>
                <p className="text-white/20 font-sans text-xs mt-1">Check back soon</p>
              </div>
            ) : (
              <div className="grid gap-2">
                {categoryEvents.map((event) => (
                  <button
                    key={event.id}
                    onClick={() => {
                      setSelectedCategory(null);
                      setSelectedEvent(event);
                    }}
                    className="flex gap-4 p-4 rounded-xl bg-white/[0.03] border border-white/[0.06] hover:border-violet-500/25 hover:bg-white/[0.06] transition-all text-left group cursor-pointer"
                    data-testid={`button-category-event-${event.id}`}
                  >
                    <div className="w-20 h-20 rounded-lg overflow-hidden flex-shrink-0">
                      {event.imageUrl ? (
                        <img
                          src={event.imageUrl}
                          alt={event.title}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full bg-violet-900/20 flex items-center justify-center">
                          <CalendarIcon className="w-6 h-6 text-white/15" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0 py-1">
                      <div className="flex items-start justify-between gap-2 mb-1.5">
                        <h4 className="font-sans font-medium text-white group-hover:text-violet-300 transition-colors line-clamp-1 text-sm">
                          {event.title}
                        </h4>
                        {event.externalTicketUrl && (
                          <span className="text-[0.6rem] text-violet-400 border border-violet-500/25 rounded-full px-2 py-0.5 flex-shrink-0 flex items-center gap-1">
                            <ExternalLinkIcon className="w-2.5 h-2.5" />
                            Ext
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 text-white/40 text-xs font-sans mb-1">
                        <ClockIcon className="w-3 h-3 flex-shrink-0" />
                        {formatEventDate(event.eventDate)} · {formatEventTime(event.eventDate)}
                      </div>
                      {event.location && (
                        <div className="flex items-center gap-1.5 text-white/30 text-xs font-sans">
                          <MapPinIcon className="w-3 h-3 flex-shrink-0" />
                          <span className="truncate">{event.location}</span>
                        </div>
                      )}
                      {!event.externalTicketUrl && formatPrice(event) && (
                        <div className="flex items-center gap-1.5 text-violet-400/70 text-xs font-sans mt-1">
                          <TicketIcon className="w-3 h-3 flex-shrink-0" />
                          {formatPrice(event)}
                        </div>
                      )}
                    </div>
                    <ChevronRightIcon className="w-4 h-4 text-white/15 group-hover:text-white/40 transition-colors flex-shrink-0 self-center" />
                  </button>
                ))}
              </div>
            )}
          </ScrollArea>

          {categoryEvents.length > 0 && (
            <div className="pt-3 border-t border-white/[0.06]">
              <Link href="/signup">
                <Button className="w-full bg-violet-600 hover:bg-violet-500 text-white border-0 rounded-xl font-sans text-sm h-11">
                  Sign up to get tickets
                  <ArrowRightIcon className="ml-2 w-4 h-4" />
                </Button>
              </Link>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ─── Event Detail Dialog ─────────────────────────────────────── */}
      <Dialog open={!!selectedEvent} onOpenChange={() => setSelectedEvent(null)}>
        <DialogContent className="bg-[#111111] border-white/[0.08] text-white max-w-xl max-h-[90vh] overflow-y-auto">
          {selectedEvent && (
            <>
              <div className="relative -mx-6 -mt-6 mb-6">
                <div className="aspect-video relative overflow-hidden rounded-t-2xl">
                  {selectedEvent.imageUrl ? (
                    <img
                      src={selectedEvent.imageUrl}
                      alt={selectedEvent.title}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full bg-gradient-to-br from-violet-900/25 to-[#0f0f0f] flex items-center justify-center">
                      <CalendarIcon className="w-16 h-16 text-white/10" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-[#111111] via-transparent to-transparent" />
                  <div className="absolute top-4 left-4 flex gap-2">
                    <span className="text-[0.6rem] font-sans font-medium tracking-[0.18em] uppercase text-white/60 px-2.5 py-1 rounded-full bg-black/50 backdrop-blur-sm border border-white/[0.08]">
                      {selectedEvent.category}
                    </span>
                    {selectedEvent.externalTicketUrl && (
                      <span className="text-[0.6rem] font-sans font-medium tracking-[0.18em] uppercase text-violet-300 px-2.5 py-1 rounded-full bg-violet-600/25 backdrop-blur-sm border border-violet-500/20">
                        External
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <DialogHeader>
                <DialogTitle className="font-sans text-xl font-semibold text-white leading-tight">
                  {selectedEvent.title}
                </DialogTitle>
              </DialogHeader>

              <div className="mt-4 space-y-3 font-sans text-sm">
                <div className="flex items-center gap-3 text-white/55">
                  <ClockIcon className="w-4 h-4 text-violet-400 flex-shrink-0" />
                  <span>
                    {format(new Date(selectedEvent.eventDate), "EEEE, MMMM d, yyyy 'at' h:mm a")}
                  </span>
                </div>
                {selectedEvent.location && (
                  <div className="flex items-center gap-3 text-white/55">
                    <MapPinIcon className="w-4 h-4 text-violet-400 flex-shrink-0" />
                    <span>
                      {selectedEvent.location}
                      {selectedEvent.city && `, ${selectedEvent.city}`}
                    </span>
                  </div>
                )}
                {selectedEvent.ticketPrice !== undefined && !selectedEvent.externalTicketUrl && (
                  <div className="flex items-center gap-3 text-white/55">
                    <TicketIcon className="w-4 h-4 text-violet-400 flex-shrink-0" />
                    <span>{formatPrice(selectedEvent) ?? "Free"}</span>
                  </div>
                )}

                {selectedEvent.description && (
                  <div className="pt-4 border-t border-white/[0.06]">
                    <p className="text-white/50 leading-relaxed">{selectedEvent.description}</p>
                  </div>
                )}

                <div className="pt-4 flex flex-col gap-2.5">
                  {selectedEvent.externalTicketUrl ? (
                    <a
                      href={selectedEvent.externalTicketUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block"
                    >
                      <Button className="w-full bg-violet-600 hover:bg-violet-500 text-white border-0 rounded-xl h-11">
                        <ExternalLinkIcon className="mr-2 w-4 h-4" />
                        Get Tickets
                      </Button>
                    </a>
                  ) : (
                    <Link href="/signup">
                      <Button className="w-full bg-violet-600 hover:bg-violet-500 text-white border-0 rounded-xl h-11">
                        Sign up to get tickets
                        <ArrowRightIcon className="ml-2 w-4 h-4" />
                      </Button>
                    </Link>
                  )}
                  <p className="text-center text-white/25 text-xs font-sans">
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
