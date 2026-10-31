import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { getCurrencySymbol } from "@/lib/currency";
import { Bars, ChatScreen, Qr, TicketScreen } from "./landing/Screens";
import "./landing/landing.css";

/** Shape of GET /api/public/landing (server/routes/public-landing-routes.ts). */
interface PublicEvent {
  id: string; title: string; category: string; eventDate: string; venue: string; city: string | null;
  minPrice: number; currency: string; imageUrl: string | null; externalTicketUrl: string | null;
  ageRestriction: string; description: string;
}

const KINDS = [
  { value: "music", label: "Music" },
  { value: "food", label: "Food & Drink" },
  { value: "tech", label: "Tech" },
  { value: "art", label: "Arts" },
  { value: "sports", label: "Sports" },
  { value: "wellness", label: "Wellness" },
] as const;
type Kind = (typeof KINDS)[number]["value"];
type Role = "out" | "host" | "venue";

// Shown only when there is no real event for the chosen night. Always labelled "sample" on the page.
const SAMPLE: Record<Kind, Array<[string, string, string]>> = {
  music: [["Friday Pre-Drinks", "Fri · 8:00 PM", "From ₦5,000"], ["Afrobeats Night", "Sat · 10:00 PM", "From ₦8,000"], ["Live Sessions", "Sun · 6:00 PM", "Free"]],
  food: [["Rooftop Supper Club", "Sat · 7:30 PM", "From ₦12,000"], ["Street Food Market", "Sun · 12:00 PM", "Free"], ["Tasting Table", "Thu · 7:00 PM", "From ₦9,000"]],
  tech: [["Builders Meetup", "Thu · 6:00 PM", "Free"], ["Demo Night", "Fri · 5:30 PM", "Free"], ["Product Breakfast", "Sat · 9:00 AM", "From ₦3,000"]],
  art: [["Gallery Late", "Sat · 5:00 PM", "From ₦3,000"], ["Open Studios", "Sun · 1:00 PM", "Free"], ["Poetry and Wine", "Fri · 7:00 PM", "From ₦4,000"]],
  sports: [["Five-a-side Night", "Wed · 7:00 PM", "From ₦2,000"], ["Match Day Watch", "Sat · 3:00 PM", "Free"], ["Padel Social", "Sun · 4:00 PM", "From ₦6,000"]],
  wellness: [["Sunrise Run Club", "Sun · 6:30 AM", "Free"], ["Rooftop Yoga", "Sat · 8:00 AM", "From ₦3,500"], ["Sound Bath", "Fri · 6:00 PM", "From ₦5,000"]],
};

const ROLE_TEXT: Record<Role, { title: string; body: string; cta: string }> = {
  out: { title: "Going out", body: "Find something on tonight, get your ticket, message the crew and share your route home with a buddy.", cta: "Join free" },
  host: { title: "Hosting", body: "Put your event in front of people already looking for a night out, and run tickets and RSVPs in one place.", cta: "List your event" },
  venue: { title: "Own a venue", body: "Give your club or bar a page people can find, fill your nights with events, and meet the promoters who want your room.", cta: "Claim your venue page" },
};

interface Item { key: string; kindLabel: string; title: string; when: string; venue: string; price: string; real: PublicEvent | null }

const priceLabel = (e: PublicEvent) =>
  e.minPrice === 0 ? "Free" : `From ${getCurrencySymbol(e.currency)}${Math.round(e.minPrice / 100).toLocaleString()}`;

/** The sign-up link carries the visitor's choice. Built only from fixed lists, never from the URL or typed text. */
function destination(role: Role, kind: Kind) {
  return `/signup?${new URLSearchParams({ from: "landing", role, kind }).toString()}`;
}

const reduced = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const PIN_CAPTIONS: Record<string, string> = {
  find: "Discover: events, venues and people in one search box.",
  getin: "Your ticket: show the code at the door, staff scan it.",
  crew: "Group chat: a poll for the venue, and the crew votes.",
  avatar: "The avatar maker: a cartoon you, used across the app.",
  map: "The map: tonight's events, venues and friends who share with you.",
  safe: "Safety Settings: choose the people who get your SOS.",
  rooms: "A Room: hang out as your avatar. Sample room, made-up people.",
  spray: "Spray: money rains down over whoever is on stage.",
};

export default function LandingPage() {
  const [, setLocation] = useLocation();
  const [kind, setKind] = useState<Kind>("music");
  const [role, setRole] = useState<Role>("out");
  const [swap, setSwap] = useState(false);
  const [pin, setPin] = useState("find");
  const [barOn, setBarOn] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [torn, setTorn] = useState(false);
  const heroRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLElement>(null);

  const { data } = useQuery<{ events: PublicEvent[] }>({ queryKey: ["/api/public/landing"], staleTime: 60_000 });
  const events = data?.events ?? [];

  // Real events for this night; samples (labelled) only when there are none.
  const items: Item[] = useMemo(() => {
    const label = KINDS.find((k) => k.value === kind)!.label;
    // Categories are free-form on the server ("food & drink"), so match on the start.
    const real = events.filter((e) => e.category.startsWith(kind));
    if (real.length > 0) {
      return real.slice(0, 3).map((e) => ({
        key: e.id, kindLabel: label, title: e.title,
        when: format(new Date(e.eventDate), "EEE · h:mm a"),
        venue: `${e.venue}${e.city ? `, ${e.city}` : ""}`, price: priceLabel(e), real: e,
      }));
    }
    return SAMPLE[kind].map(([title, when, price]) => ({ key: title, kindLabel: `${label} · sample`, title, when, venue: "Sample venue", price, real: null }));
  }, [events, kind]);
  const hasReal = items[0]?.real != null;
  const head = items[0];
  const dest = destination(role, kind);
  const kindLabel = KINDS.find((k) => k.value === kind)!.label;

  const choose = useCallback((fn: () => void) => {
    if (reduced()) { fn(); return; }
    setSwap(true);
    window.setTimeout(() => { fn(); setSwap(false); }, 150);
  }, []);

  // reveal-on-scroll, pinned phone follows the section in view, sticky join bar
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(".lp .reveal"));
    if (!("IntersectionObserver" in window) || reduced()) { els.forEach((el) => el.classList.add("in")); }
    const ios: IntersectionObserver[] = [];
    if ("IntersectionObserver" in window && !reduced()) {
      const en = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); en.unobserve(e.target); } }), { threshold: 0.06 });
      els.forEach((el) => en.observe(el)); ios.push(en);
    }
    if ("IntersectionObserver" in window) {
      const pk = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) setPin((e.target as HTMLElement).dataset.stub || "find"); }), { rootMargin: "-45% 0px -45% 0px" });
      document.querySelectorAll(".lp .st[data-stub]").forEach((s) => pk.observe(s)); ios.push(pk);
      let heroIn = true, closeIn = false;
      const upd = () => setBarOn(!heroIn && !closeIn);
      const h = new IntersectionObserver((es) => { heroIn = es[0].isIntersecting; upd(); }, { threshold: 0.35 });
      const c = new IntersectionObserver((es) => { closeIn = es[0].isIntersecting; upd(); }, { threshold: 0.2 });
      if (heroRef.current) h.observe(heroRef.current);
      if (closeRef.current) c.observe(closeRef.current);
      ios.push(h, c);
    } else setBarOn(true);
    return () => ios.forEach((o) => o.disconnect());
  }, []);

  const goTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "start" });
  const pickRole = (r: Role) => setRole(r);
  const tear = () => {
    setTorn(true);
    window.setTimeout(() => setLocation(dest), reduced() ? 0 : 420);
  };

  // Plain functions (not components) so the pinned layers keep their DOM nodes between renders.
  const layer = (id: string, children: ReactNode) => (
    <div key={id} className={`ly${pin === id ? " on" : ""}`} data-for={id}>{children}</div>
  );
  const img = (id: string, src: string) => (
    <img key={id} className={`ly${pin === id ? " on" : ""}`} data-for={id} src={src} alt="" width={780} height={1568} loading="lazy" />
  );

  return (
    <div className="lp" data-testid="landing-page">
      {/* ─── Hero: one full-screen ticket ─────────────────────────────── */}
      <section className="hero" id="top" ref={heroRef}>
        <div className="tk">
          <div className="tk-main">
            <div className="nav">
              <Link href="/" className="brand">Vib3Pulse</Link>
              <nav aria-label="Primary">
                <button type="button" className="t host" onClick={() => { pickRole("host"); goTo("go"); }} data-testid="button-header-host">List your event</button>
                <Link href="/login" className="t" data-testid="button-header-login">Sign in</Link>
                <Link href={dest} className="j" data-testid="button-header-signup">Join free</Link>
              </nav>
            </div>
            <div>
              <h1>Find your Vib3.</h1>
              <p className="lead">One app to find what's on, get in, plan with your crew and get home safe.</p>
            </div>
            <div className="pick">
              <div className="pick-top">
                <div className="chips" role="group" aria-label="Pick your kind of night">
                  {KINDS.map((k) => (
                    <button key={k.value} type="button" aria-pressed={kind === k.value} data-testid={`button-category-${k.value}`}
                      onClick={() => kind !== k.value && choose(() => setKind(k.value))}>{k.label}</button>
                  ))}
                </div>
              </div>
              <div className={`print${swap ? " out" : ""}`} aria-live="polite">
                <div className="info">
                  <span className="kind">{head.kindLabel}</span>
                  <span className="title">{head.title}</span>
                  <span className="where">{head.when} · {head.venue}</span>
                </div>
                <div className="go">
                  <span className="price">{head.price}</span>
                  <Link href={dest} className="btn" data-testid="button-hero-signup">Get this ticket <span aria-hidden="true">→</span></Link>
                </div>
              </div>
              <p className="fine">{hasReal ? "Real upcoming events. Join free to get your ticket." : "Sample ticket. Pick a night and it prints. Real events appear when you join, free."}</p>
            </div>
          </div>
          <aside className="stub1" aria-label="Your pass">
            <div className="meta"><span>Admit one</span><span>Seat: anywhere</span></div>
            <TicketScreen label="A Vib3Pulse ticket in the Tickets tab, with a QR code to show at the door." />
            <Bars n={36} seed={7} />
          </aside>
        </div>
      </section>

      <div className="assure" aria-label="Good to know">
        <span>Free to join</span><span>Tickets in your phone</span><span>13+ with age limits on events</span><span>Safety Buddies built in</span>
        <a className="hot" href="#rooms-sec" onClick={(e) => { e.preventDefault(); goTo("rooms-sec"); }}>Interactive live-streamed Rooms with real-time fan tipping (Spray)<em>Early access</em></a>
      </div>

      {/* ─── Find your Vib3: browse by category, or step into a Room ─── */}
      <section className="week" id="find" aria-labelledby="wk">
        <div className="week-head">
          <h2 id="wk">Find your Vib3</h2>
          <p>Browse events by category, or step into a live-streamed Room.</p>
        </div>
        <div className="cats" role="group" aria-label="Browse by category">
          {KINDS.map((k) => {
            const live = events.some((e) => e.category.startsWith(k.value));
            return (
              <button key={k.value} type="button" className={`cat${kind === k.value ? " on" : ""}`} aria-pressed={kind === k.value}
                onClick={() => { if (kind !== k.value) choose(() => setKind(k.value)); goTo("top"); }} data-testid={`button-browse-${k.value}`}>
                <span className="k">{live ? "Events on now" : "Browse"}</span><span className="t">{k.label}</span>
              </button>
            );
          })}
          <a className="cat room" href="#rooms-sec" onClick={(e) => { e.preventDefault(); goTo("rooms-sec"); }} data-testid="link-browse-rooms">
            <span className="k">Live · early access</span><span className="t">Rooms</span>
          </a>
        </div>
      </section>

      {/* ─── Pinned app screens + stubs ──────────────────────────────── */}
      <div className="stage">
        <aside className="pin" aria-hidden="true">
          <figure>
            <div className="phone">
              {img("find", "/landing/discover.webp")}
              {layer("getin", <TicketScreen />)}
              {layer("crew", <ChatScreen />)}
              {img("avatar", "/landing/avatar.webp")}
              {img("map", "/landing/map.webp")}
              {img("safe", "/landing/safety.webp")}
              {img("rooms", "/landing/room.webp")}
              {img("spray", "/landing/spray.webp")}
            </div>
            <figcaption>{PIN_CAPTIONS[pin]}</figcaption>
          </figure>
        </aside>

        <div className="stubs">
          <section className="st reveal" id="how" data-stub="find">
            <h2>Find what's on</h2>
            <p className="lead">Music, food, tech, art, sport, wellness. One search for events, venues and people.</p>
            <ul className="facts"><li>Trending events, and picks made for you</li><li>Tap I'm interested, or grab a ticket</li></ul>
            <figure className="shot"><img src="/landing/discover.webp" alt="The Discover screen with a search box, filters and trending events." width={780} height={1568} loading="lazy" /><figcaption>Discover</figcaption></figure>
          </section>

          <section className="st p2 reveal" data-stub="getin">
            <h2>Get in without the faff</h2>
            <p className="lead">Your ticket waits in one place, the Tickets tab. Show the code. Staff scan it.</p>
            <div className={`gate${scanned ? " done" : ""}`}><Qr seed={5} /><small>Sample pass, not a real ticket</small><div className="ok" aria-hidden="true">You're in.</div></div>
            <button className="btn" type="button" onClick={() => setScanned((s) => !s)} style={{ "--bb": "var(--ink)", "--bf": "var(--paper)" } as CSSProperties}>{scanned ? "Scan again" : "Scan me at the door"}</button>
            <p className="sm">No printouts, no hunting through old emails.</p>
            <figure className="shot"><TicketScreen label="A ticket in the Tickets tab with a QR code and short code." /><figcaption>Your ticket, in the Tickets tab</figcaption></figure>
          </section>

          <section className="st reveal" data-stub="crew">
            <h2>Bring your crew</h2>
            <p className="lead">Plan it in group chats, with polls so the venue is decided before midnight.</p>
            <ul className="facts"><li>Follow friends and post what you're up to</li><li>Stories that vanish after 24 hours</li><li>Communities for your city, scene or interests</li></ul>
            <figure className="shot"><ChatScreen label="A group chat with a poll for tonight's venue, with the crew's votes coming in." /><figcaption>A group chat, with a poll for the venue</figcaption></figure>
          </section>

          <section className="st p2 reveal" data-stub="avatar">
            <h2>Make it yours</h2>
            <p className="lead">Build a little cartoon you. It's your face in chats, on the map and in Rooms.</p>
            <ul className="facts"><li>Pick your hair, outfit and colours</li><li>Change your look whenever you like</li></ul>
            <figure className="shot"><img src="/landing/avatar.webp" alt="The avatar editor showing a cartoon woman in a violet hoodie." width={780} height={1568} loading="lazy" /><figcaption>The avatar maker</figcaption></figure>
          </section>

          <section className="st reveal" data-stub="map">
            <h2>See who's out</h2>
            <p className="lead">Tonight's events and venues, and friends who choose to share where they are.</p>
            <p className="body">Sharing starts switched off. Positions are rounded, so nobody sees exactly where you stand. Ghost mode hides you whenever you like.</p>
            <figure className="shot"><img src="/landing/map.webp" alt="The map with filters for Friends, Tonight and Venues, and a Ghost button." width={780} height={1568} loading="lazy" /><figcaption>The map, with sharing off</figcaption></figure>
          </section>

          <section className="st ac reveal" data-stub="safe">
            <h2>Get home safe</h2>
            <p className="lead">Pick up to five Safety Buddies in the app and up to five by phone number.</p>
            <p className="body">Send an SOS and they get your location. A friend without Vib3Pulse can still look out for you by text.</p>
            <p className="sm">Vib3Pulse is not an emergency service. In an emergency call 999 in the UK, 112 in Nigeria or the EU, or 911 in the US.</p>
            <figure className="shot"><img src="/landing/safety.webp" alt="The Safety Settings screen showing in-app and phone Safety Buddies." width={780} height={1568} loading="lazy" /><figcaption>Safety Settings</figcaption></figure>
          </section>

          <section className="st nt reveal" id="rooms-sec" data-stub="rooms">
            <h2>Hang out from the couch</h2>
            <p className="lead">Rooms are live hangouts. Drop in as your avatar, chat, talk and react.</p>
            <p className="body">Host or watch live-streamed sessions, and let the audience tip performers in real time with Spray. Pre-drinks with the friends who couldn't make it work too. In early access.</p>
            <figure className="shot"><img src="/landing/room.webp" alt="A room called Friday Pre-Drinks showing avatars of the people inside, and the chat." width={780} height={1568} loading="lazy" /><figcaption>A sample room, made-up people</figcaption></figure>
          </section>

          <section className="st ac reveal" id="spray" data-stub="spray">
            <h2>Spray the room</h2>
            <p className="lead">Spraying is the party tradition of throwing money at someone having a moment. In a Room, it's a tap.</p>
            <p className="body">Pick a note, a bundle, a bag or a full rain, and it showers down the screen over whoever is on stage.</p>
            <ul className="facts">
              <li>The host decides if spraying is on, and can switch it off mid-show</li>
              <li>Only ID-verified adults can spray or be sprayed</li>
              <li>Only in 18+ and 21+ rooms, never in a room open to under-18s</li>
              <li>Prefer a low profile? Spray without your name showing</li>
              <li>Admins can switch it off for any room</li>
            </ul>
            <figure className="shot"><img src="/landing/spray.webp" alt="Money notes with a V3 logo raining down over a stage, with buttons to throw a note, a bundle, a bag or make it rain." width={780} height={1568} loading="lazy" /><figcaption>Spraying in a Room</figcaption></figure>
          </section>

          <section className="st p2 reveal" id="who">
            <h2>Which night is yours?</h2>
            <div className="roles" role="group" aria-label="Choose your kind of night">
              {(Object.keys(ROLE_TEXT) as Role[]).map((r) => (
                <button key={r} type="button" aria-pressed={role === r} onClick={() => pickRole(r)}>{ROLE_TEXT[r].title}</button>
              ))}
            </div>
            <div className="panel" aria-live="polite"><h3>{ROLE_TEXT[role].title}</h3><p>{ROLE_TEXT[role].body}</p></div>
            <Link href={dest} className="btn">{ROLE_TEXT[role].cta}</Link>
          </section>
        </div>
      </div>

      {/* ─── Good questions ──────────────────────────────────────────── */}
      <section className="faq reveal" aria-labelledby="fq">
        <h2 id="fq">Good questions</h2>
        <div className="faq-list">
          <details><summary>Is it free?</summary><p>Joining is free. Tickets cost whatever the host sets, and some events are free.</p></details>
          <details><summary>How old do I need to be?</summary><p>13 or older. Under-18s and adults are kept apart by default, and events and rooms can carry age limits. Your age can be checked by a real person, and the photos used are deleted once the decision is made.</p></details>
          <details><summary>Who can see where I am?</summary><p>Nobody, until you choose. Location sharing starts switched off, positions are rounded, and Ghost mode hides you whenever you like.</p></details>
          <details><summary>Is Vib3Pulse an emergency service?</summary><p>No. If you are in danger call 999 in the UK, 112 in Nigeria or the EU, or 911 in the US. Safety Buddies are for the people you trust to look out for you.</p></details>
          <details><summary>What are Rooms?</summary><p>Live hangouts where you show up as your avatar. They are in early access, and the audience can spray the host and people on stage.</p></details>
          <details><summary>How does spraying work in a Room?</summary><p>Spraying is the party tradition of throwing money at someone having a moment. In an 18+ or 21+ Room, tap Spray, pick a note, a bundle, a bag or a full rain, and it showers down the screen over whoever is on stage. Only ID-verified adults can spray or be sprayed, the host decides whether it is on, and you can spray without your name showing. You pay on our payment provider's secure page, not inside the room.</p></details>
          <details><summary>I run events or a venue. Can I list them?</summary><p>Yes. Create an event, set the price and number of tickets, watch sales and RSVPs, and scan people in at the door. Venues get a page with photos, nights and ticket sales.</p></details>
        </div>
      </section>

      {/* ─── Close: the tear-off ─────────────────────────────────────── */}
      <section className="close" id="go" aria-labelledby="cl" ref={closeRef}>
        <h2 id="cl">Your Vib3 starts here.</h2>
        <div className={`tear${torn ? " torn" : ""}`}>
          <div className="main">
            <b>{role === "out" ? `Admit one: ${kindLabel}` : "Organiser pass"}</b>
            <span>Free to join. Takes you straight to sign up.</span>
          </div>
          <button className="st1" type="button" onClick={tear} aria-label="Tear off your ticket and sign up" data-testid="button-cta-signup"><span>Tear here<br />to join →</span></button>
        </div>
        <div className="alt">
          <Link href="/login" data-testid="button-cta-login">Already a member? Sign in</Link>
          <Link href={destination("host", kind)}>Organising events? List yours</Link>
        </div>
      </section>

      <footer className="foot">
        <span>Vib3Pulse</span>
        <span><Link href="/privacy">Privacy</Link> · <a href="/terms-of-service.txt">Terms</a></span>
        <small>© 2026 Vib3Pulse. Built by AeolusLabs LTD.</small>
      </footer>

      <div className={`bar${barOn ? " show" : ""}`} role="region" aria-label="Join Vib3Pulse">
        <span>{role === "out" ? `${kindLabel} events` : ROLE_TEXT[role].cta}</span>
        <Link href={dest} className="btn">{ROLE_TEXT[role].cta}</Link>
      </div>
    </div>
  );
}
