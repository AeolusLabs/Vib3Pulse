import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatMoney } from "@/lib/currency";
import { Button } from "@/components/ui/button";
import Navigation from "@/components/Navigation";
import { avatarPinSvg } from "@shared/avatar-render/render";
import { buildingSvg } from "@shared/avatar-render/building";
import { resolveBuilding, type BuildingConfig } from "@shared/building";
import type { AvatarConfig } from "@shared/avatar";
import BottomNavigation from "@/components/BottomNavigation";
import { Building2Icon, CalendarIcon, EyeIcon, EyeOffIcon, Navigation2Icon, SearchIcon, XIcon } from "@/components/ui/icons";

interface MapFriend { id: string; username: string; displayName: string | null; avatarUrl: string | null; avatar?: AvatarConfig | null; latitude: number; longitude: number; updatedAt: string }
interface Going { id: string; displayName: string | null; username: string; avatarUrl: string | null }
interface MapEvent { friendsGoing?: { count: number; sample: Going[] }; id: string; title: string; eventDate: string; eventEndDate: string | null; latitude: number; longitude: number; imageUrl: string | null; location: string; category: string; ticketPrice: number; currency: string; building?: BuildingConfig | null; isPromoted?: boolean }
interface MapVenue { id: string; name: string; category: string; imageUrl: string | null; address: string | null; latitude: number; longitude: number; building?: BuildingConfig | null; isVerified?: boolean; isPromoted?: boolean }
interface Audience { audience: "friends" | "selected"; viewerIds: string[]; friends: { id: string; username: string; displayName: string | null; avatarUrl: string | null }[] }
interface SearchResults { events?: any[]; venues?: any[] }
interface Nearby { friends: MapFriend[]; events: MapEvent[]; venues: MapVenue[] }

type Filter = "all" | "friends" | "tonight" | "venues";
type Selected = { type: "friend"; item: MapFriend } | { type: "event"; item: MapEvent } | { type: "venue"; item: MapVenue } | null;

const FALLBACK_CENTER: [number, number] = [51.5072, -0.1276];
const RADIUS_KM = 5;
const HEARTBEAT_MS = 60_000;
// Tile source. Defaults to OpenStreetMap's own tiles (no key; fine at light volume, no dark style, so dark
// mode darkens them with a CSS filter). Set VITE_MAP_TILES_URL (+ optional _DARK_URL / _ATTRIBUTION) at build
// time to use a keyed provider such as MapTiler or Mapbox. Don't use CARTO's free tiles: without a paid key
// they come back with an "API KEY REQUIRED" watermark.
const env = import.meta.env as Record<string, string | undefined>;
const TILE_URL = env.VITE_MAP_TILES_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_DARK_URL = env.VITE_MAP_TILES_DARK_URL;
const TILE_ATTRIBUTION = env.VITE_MAP_TILES_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const isDark = () => document.documentElement.classList.contains("dark");

function km(a: [number, number], lat: number, lng: number) {
  const r = Math.PI / 180;
  const dLat = (lat - a[0]) * r, dLng = (lng - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(lat * r) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}
const fmtDist = (d: number) => (d < 1 ? `${Math.max(50, Math.round(d * 10) * 100)} m` : `${d.toFixed(1)} km`);
const friendName = (f: MapFriend) => f.displayName || f.username;

const SHADOW = "box-shadow:0 4px 12px rgba(0,0,0,.45)";
function friendIcon(f: MapFriend, selected: boolean) {
  // A friend with an avatar is a pin badge (tail points at the spot); otherwise photo, then initial.
  const pin = avatarPinSvg(f.avatar);
  if (pin) {
    const glow = selected ? "drop-shadow(0 0 7px #9B6FEF) drop-shadow(0 0 2px #fff)" : "drop-shadow(0 3px 3px rgba(0,0,0,.45))";
    return L.divIcon({
      className: "vp-pin",
      iconSize: [0, 0],
      html: `<div title="${esc(friendName(f))}" style="transform:translate(-50%,-100%);width:${selected ? 52 : 44}px;filter:${glow}">${pin}</div>`,
    });
  }
  const ring = selected ? "#fff" : "#9B6FEF";
  const inner = f.avatarUrl
    ? `<img src="${esc(f.avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`
    : esc(friendName(f).charAt(0).toUpperCase());
  return L.divIcon({
    className: "vp-pin",
    iconSize: [0, 0],
    html: `<div style="transform:translate(-50%,-50%);width:40px;height:40px;border-radius:50%;display:grid;place-items:center;background:#5b3aa8;color:#fff;font:600 15px Jost,sans-serif;border:2.5px solid ${ring};${SHADOW};overflow:hidden">${inner}</div>`,
  });
}
function eventIcon(e: MapEvent, selected: boolean) {
  const t = e.title.length > 18 ? `${e.title.slice(0, 17)}…` : e.title;
  // The organizer's building (or the category default) with the title underneath; promoted listings glow amber.
  const svg = buildingSvg(resolveBuilding("event", e.category, e.building), { glow: e.isPromoted ? "promoted" : undefined, decorative: true });
  const glow = selected ? "drop-shadow(0 0 7px #9B6FEF) drop-shadow(0 0 2px #fff)" : "drop-shadow(0 3px 3px rgba(0,0,0,.45))";
  return L.divIcon({
    className: "vp-pin",
    iconSize: [0, 0],
    html: `<div style="transform:translate(-50%,-80%);display:flex;flex-direction:column;align-items:center;gap:1px"><div style="width:${selected ? 76 : 64}px;filter:${glow}">${svg}</div><span style="white-space:nowrap;background:#7C46D6;color:#fff;border-radius:999px;padding:2px 9px;font:600 11px Jost,sans-serif;${selected ? "outline:2px solid #fff;" : ""}">${esc(t)}</span></div>`,
  });
}
function venueIcon(v: MapVenue, selected: boolean) {
  // The owner's building (or the category default); verified venues glow violet, promoted ones amber.
  const svg = buildingSvg(resolveBuilding("venue", v.category, v.building), { glow: v.isPromoted ? "promoted" : v.isVerified ? "verified" : undefined, decorative: true });
  const glow = selected ? "drop-shadow(0 0 7px #9B6FEF) drop-shadow(0 0 2px #fff)" : "drop-shadow(0 3px 3px rgba(0,0,0,.45))";
  return L.divIcon({
    className: "vp-pin",
    iconSize: [0, 0],
    html: `<div title="${esc(v.name)}" style="transform:translate(-50%,-80%);width:${selected ? 68 : 56}px;filter:${glow}">${svg}</div>`,
  });
}
const meIcon = L.divIcon({
  className: "vp-pin",
  iconSize: [0, 0],
  html: `<div style="transform:translate(-50%,-50%);width:16px;height:16px;border-radius:50%;background:#9B6FEF;border:3px solid #090909;box-shadow:0 0 0 7px rgba(124,70,214,.2),0 0 0 1px #9B6FEF"></div>`,
});

function eventWhen(e: MapEvent) {
  const d = new Date(e.eventDate);
  if (d.getTime() <= Date.now()) return "On now";
  return d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}
function goingLabel(e: MapEvent): string | null {
  const g = e.friendsGoing;
  if (!g || g.count === 0) return null;
  const names = g.sample.map((u) => u.displayName || u.username);
  const more = g.count - names.length;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return more > 0 ? `${names.join(", ")} and ${more} more going` : `${list} going`;
}
function eventPrice(e: MapEvent) {
  return e.ticketPrice ? formatMoney(e.ticketPrice, e.currency) : "Free";
}

export default function MapPage() {
  const { toast } = useToast();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const meRef = useRef<L.Marker | null>(null);

  const [center, setCenter] = useState<[number, number] | null>(null);
  const [located, setLocated] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Selected>(null);
  const [panel, setPanel] = useState(false);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => { const id = setTimeout(() => setDebouncedQ(q.trim()), 300); return () => clearTimeout(id); }, [q]);

  // Fill exactly the space below the header (and any banner above it) and above the mobile
  // bottom nav, so the page never scrolls and the sheet never hides behind the nav.
  const mainRef = useRef<HTMLElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const calc = () => {
      const el = mainRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const bottomNav = window.matchMedia("(min-width: 768px)").matches ? 0 : 64;
      setHeight(Math.max(320, Math.round(window.innerHeight - top - bottomNav)));
    };
    calc();
    window.addEventListener("resize", calc);
    const ro = new ResizeObserver(calc);
    ro.observe(document.body);
    return () => { window.removeEventListener("resize", calc); ro.disconnect(); };
  }, []);
  useEffect(() => { mapRef.current?.invalidateSize(); }, [height]);

  const locate = (cb?: (p: [number, number]) => void) => {
    if (!navigator.geolocation) { setLocated(false); setCenter((c) => c ?? FALLBACK_CENTER); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => { const p: [number, number] = [pos.coords.latitude, pos.coords.longitude]; setLocated(true); setCenter(p); cb?.(p); },
      () => { setLocated(false); setCenter((c) => c ?? FALLBACK_CENTER); },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 30_000 },
    );
  };
  useEffect(() => { locate(); }, []);

  // Rounded to ~1 km so panning noise doesn't refetch.
  const qLat = center ? center[0].toFixed(2) : null;
  const qLng = center ? center[1].toFixed(2) : null;
  const nearbyUrl = `/api/map/nearby?lat=${qLat}&lng=${qLng}&radiusKm=${RADIUS_KM}`;
  const { data } = useQuery<Nearby>({ queryKey: [nearbyUrl], enabled: !!center, refetchInterval: 60_000 });
  const { data: me } = useQuery<{ sharing: boolean }>({ queryKey: ["/api/map/me"] });
  const sharing = !!me?.sharing;

  const { data: aud } = useQuery<Audience>({ queryKey: ["/api/map/audience"], enabled: panel });
  const saveAudience = useMutation({
    mutationFn: (body: { audience: "friends" | "selected"; viewerIds: string[] }) => apiRequest("PUT", "/api/map/audience", body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/map/audience"] }),
    onError: () => toast({ title: "Couldn't save who can see you", variant: "destructive" }),
  });

  const searchUrl = `/api/search?q=${encodeURIComponent(debouncedQ)}&types=events,venues`;
  const { data: found } = useQuery<SearchResults>({ queryKey: [searchUrl], enabled: debouncedQ.length >= 2 });

  const push = (p: [number, number]) => apiRequest("PUT", "/api/map/location", { latitude: p[0], longitude: p[1] });
  const startSharing = useMutation({
    mutationFn: () => new Promise<void>((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("Location isn't available on this device."));
      navigator.geolocation.getCurrentPosition(
        (pos) => { const p: [number, number] = [pos.coords.latitude, pos.coords.longitude]; setCenter(p); push(p).then(() => resolve(), reject); },
        () => reject(new Error("Allow location access in your browser to share.")),
        { timeout: 8000 },
      );
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/map/me"] }),
    onError: (e: Error) => toast({ title: "Couldn't start sharing", description: e.message, variant: "destructive" }),
  });
  const stopSharing = useMutation({
    mutationFn: () => apiRequest("DELETE", "/api/map/location"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/map/me"] }),
  });

  // Keep the shared point fresh while the map is open; it expires on its own after 30 min.
  useEffect(() => {
    if (!sharing || !navigator.geolocation) return;
    const id = setInterval(() => {
      navigator.geolocation.getCurrentPosition((pos) => { push([pos.coords.latitude, pos.coords.longitude]).catch(() => {}); }, () => {}, { maximumAge: 30_000 });
    }, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [sharing]);

  // Map lifecycle
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { center: FALLBACK_CENTER, zoom: 14, zoomControl: false, attributionControl: true });
    const url = () => (isDark() && TILE_DARK_URL) || TILE_URL;
    // Without a real dark style, darken the light tiles (see .vp-dark .vp-tiles in index.css).
    const applyTheme = () => {
      containerRef.current?.classList.toggle("vp-dark", isDark() && !TILE_DARK_URL);
      tileRef.current?.setUrl(url());
    };
    tileRef.current = L.tileLayer(url(), { maxZoom: 19, attribution: TILE_ATTRIBUTION, className: "vp-tiles" }).addTo(map);
    applyTheme();
    layerRef.current = L.layerGroup().addTo(map);
    map.on("click", () => setSelected(null));
    mapRef.current = map;
    const obs = new MutationObserver(applyTheme);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => { obs.disconnect(); map.remove(); mapRef.current = null; };
  }, []);

  // First fix: jump there. Later fixes only move the "me" dot.
  const centeredRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !center) return;
    if (!centeredRef.current) { map.setView(center, 14); centeredRef.current = true; }
    if (located) {
      if (!meRef.current) meRef.current = L.marker(center, { icon: meIcon, interactive: false, zIndexOffset: -100 }).addTo(map);
      else meRef.current.setLatLng(center);
    }
  }, [center, located]);

  const tonightCutoff = useMemo(() => Date.now() + 12 * 3_600_000, [data]);
  const shown = useMemo(() => {
    const friends = filter === "all" || filter === "friends" ? data?.friends ?? [] : [];
    const events = filter === "all" ? data?.events ?? []
      : filter === "tonight" ? (data?.events ?? []).filter((e) => new Date(e.eventDate).getTime() <= tonightCutoff) : [];
    const venues = filter === "all" || filter === "venues" ? data?.venues ?? [] : [];
    return { friends, events, venues };
  }, [data, filter, tonightCutoff]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.clearLayers();
    const pick = (s: Selected) => (e: L.LeafletMouseEvent) => { L.DomEvent.stopPropagation(e); setSelected(s); };
    shown.venues.forEach((v) => L.marker([v.latitude, v.longitude], { icon: venueIcon(v, selected?.type === "venue" && selected.item.id === v.id) }).on("click", pick({ type: "venue", item: v })).addTo(layer));
    shown.events.forEach((ev) => L.marker([ev.latitude, ev.longitude], { icon: eventIcon(ev, selected?.type === "event" && selected.item.id === ev.id), zIndexOffset: 200 }).on("click", pick({ type: "event", item: ev })).addTo(layer));
    shown.friends.forEach((f) => L.marker([f.latitude, f.longitude], { icon: friendIcon(f, selected?.type === "friend" && selected.item.id === f.id), zIndexOffset: 400 }).on("click", pick({ type: "friend", item: f })).addTo(layer));
    if (selected?.type === "event" && !shown.events.some((e) => e.id === selected.item.id)) {
      L.marker([selected.item.latitude, selected.item.longitude], { icon: eventIcon(selected.item, true), zIndexOffset: 500 }).addTo(layer);
    } else if (selected?.type === "venue" && !shown.venues.some((v) => v.id === selected.item.id)) {
      L.marker([selected.item.latitude, selected.item.longitude], { icon: venueIcon(selected.item, true), zIndexOffset: 500 }).addTo(layer);
    }
  }, [shown, selected]);

  const nearList = useMemo(() => {
    const c = center ?? FALLBACK_CENTER;
    return [
      ...shown.events.map((e) => ({ sel: { type: "event", item: e } as Selected, lat: e.latitude, lng: e.longitude, d: km(c, e.latitude, e.longitude) })),
      ...shown.venues.map((v) => ({ sel: { type: "venue", item: v } as Selected, lat: v.latitude, lng: v.longitude, d: km(c, v.latitude, v.longitude) })),
      ...shown.friends.map((f) => ({ sel: { type: "friend", item: f } as Selected, lat: f.latitude, lng: f.longitude, d: km(c, f.latitude, f.longitude) })),
    ].sort((a, b) => a.d - b.d).slice(0, 3);
  }, [shown, center]);

  const focus = (s: Selected, lat: number, lng: number) => { setSelected(s); mapRef.current?.flyTo([lat, lng], Math.max(mapRef.current.getZoom(), 15), { duration: 0.6 }); };

  const chips: { id: Filter; label: string }[] = [
    { id: "all", label: "All" }, { id: "friends", label: "Friends" }, { id: "tonight", label: "Tonight" }, { id: "venues", label: "Venues" },
  ];
  const nothingNearby = !!data && !shown.friends.length && !shown.events.length && !shown.venues.length;

  // Search covers everything with coordinates (not just the loaded 5 km) plus friends on the map now.
  const results = useMemo(() => {
    if (debouncedQ.length < 2) return [];
    const needle = debouncedQ.toLowerCase();
    const out: { sel: NonNullable<Selected>; lat: number; lng: number }[] = [];
    (data?.friends ?? []).filter((f) => friendName(f).toLowerCase().includes(needle) || f.username.toLowerCase().includes(needle))
      .forEach((f) => out.push({ sel: { type: "friend", item: f }, lat: f.latitude, lng: f.longitude }));
    (found?.events ?? []).filter((e) => e.latitude != null && e.longitude != null).slice(0, 6).forEach((e) => {
      const item: MapEvent = { id: e.id, title: e.title, eventDate: e.eventDate, eventEndDate: e.eventEndDate ?? null, latitude: e.latitude, longitude: e.longitude, imageUrl: e.imageUrl ?? null, location: e.location, category: e.category, ticketPrice: e.ticketPrice, currency: e.currency };
      out.push({ sel: { type: "event", item }, lat: e.latitude, lng: e.longitude });
    });
    (found?.venues ?? []).filter((v) => v.latitude != null && v.longitude != null).slice(0, 6).forEach((v) => {
      const item: MapVenue = { id: v.id, name: v.name, category: v.category, imageUrl: v.imageUrl ?? null, address: v.address ?? null, latitude: v.latitude, longitude: v.longitude };
      out.push({ sel: { type: "venue", item }, lat: v.latitude, lng: v.longitude });
    });
    return out.slice(0, 8);
  }, [debouncedQ, data, found]);

  return (
    <div className="bg-background">
      <Navigation />
      <main ref={mainRef} style={{ height }} className="relative isolate mb-16 md:mb-0">
        <div ref={containerRef} className="absolute inset-0 z-0" data-testid="map-nearby" />

        <div className="absolute inset-x-0 top-0 z-10 flex flex-col gap-2 p-3 pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border bg-card/95 pl-3 pr-1.5 backdrop-blur">
            <SearchIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search events, venues, friends"
              aria-label="Search the map"
              className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              data-testid="input-map-search"
            />
            {q && <button onClick={() => setQ("")} aria-label="Clear search" className="grid h-7 w-7 place-items-center text-muted-foreground"><XIcon className="h-4 w-4" /></button>}
            <button
              onClick={() => setPanel((p) => !p)}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-primary/10 px-3 text-xs font-medium"
              data-testid="button-map-sharing"
            >
              {sharing ? <EyeIcon className="h-3.5 w-3.5 text-primary" /> : <EyeOffIcon className="h-3.5 w-3.5 text-muted-foreground" />}
              {sharing ? "Sharing" : "Ghost"}
            </button>
          </div>

          {debouncedQ.length >= 2 && q.trim() === debouncedQ && (
            <div className="pointer-events-auto max-h-64 overflow-y-auto rounded-2xl border bg-card p-1.5 shadow-lg" data-testid="map-search-results">
              {results.length === 0 ? (
                <p className="px-3 py-2.5 text-sm text-muted-foreground">Nothing on the map matches "{debouncedQ}".</p>
              ) : results.map(({ sel, lat, lng }) => (
                <button
                  key={`${sel.type}-${sel.item.id}`}
                  onClick={() => { focus(sel, lat, lng); setQ(""); }}
                  className="flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-muted"
                  data-testid={`map-result-${sel.type}-${sel.item.id}`}
                >
                  <Thumb sel={sel} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{titleOf(sel)}</span>
                    <span className="block truncate text-xs text-muted-foreground">{subOf(sel)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            <div className="flex flex-1 gap-1.5 overflow-x-auto pointer-events-auto [scrollbar-width:none]">
              {chips.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setFilter(c.id)}
                  className={`h-8 shrink-0 rounded-full border px-3.5 text-sm font-medium backdrop-blur ${filter === c.id ? "border-primary bg-primary text-primary-foreground" : "bg-card/90 text-foreground"}`}
                  data-testid={`map-filter-${c.id}`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          {panel && (
            <div className="pointer-events-auto max-h-[calc(100dvh-16rem)] self-end w-72 max-w-full space-y-3 overflow-y-auto rounded-2xl border bg-card p-4 shadow-lg" data-testid="panel-map-sharing">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">{sharing ? (aud?.audience === "selected" ? "Selected friends can see you" : "Friends can see you") : "You're hidden"}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {sharing
                      ? "Only mutual follows you allow see your location, rounded to about 100 m. It disappears 30 minutes after you leave the map."
                      : "Nobody sees where you are. Turn sharing on to appear on your friends' maps."}
                  </p>
                </div>
                <button onClick={() => setPanel(false)} aria-label="Close" className="text-muted-foreground"><XIcon className="h-4 w-4" /></button>
              </div>
              <Button
                className="w-full rounded-full"
                variant={sharing ? "outline" : "default"}
                disabled={startSharing.isPending || stopSharing.isPending}
                onClick={() => (sharing ? stopSharing.mutate() : startSharing.mutate())}
                data-testid="button-toggle-sharing"
              >
                {sharing ? "Stop sharing" : "Share with friends"}
              </Button>

              <div className="space-y-2 border-t pt-3" data-testid="map-audience">
                <p className="text-xs font-medium">Who can see you</p>
                <div className="grid grid-cols-2 gap-1 rounded-full border p-0.5 text-xs font-medium">
                  {(["friends", "selected"] as const).map((a) => (
                    <button
                      key={a}
                      disabled={!aud || saveAudience.isPending}
                      onClick={() => aud && aud.audience !== a && saveAudience.mutate({ audience: a, viewerIds: aud.viewerIds })}
                      className={`h-7 rounded-full ${aud?.audience === a ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                      data-testid={`button-audience-${a}`}
                    >
                      {a === "friends" ? "All friends" : "Selected"}
                    </button>
                  ))}
                </div>
                {aud?.audience === "selected" && (
                  aud.friends.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No friends yet. Friends are people who follow each other.</p>
                  ) : (
                    <div className="max-h-40 space-y-0.5 overflow-y-auto">
                      {aud.friends.map((f) => {
                        const on = aud.viewerIds.includes(f.id);
                        return (
                          <label key={f.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-sm hover:bg-muted">
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={saveAudience.isPending}
                              onChange={() => saveAudience.mutate({ audience: "selected", viewerIds: on ? aud.viewerIds.filter((id) => id !== f.id) : [...aud.viewerIds, f.id] })}
                              className="h-4 w-4 accent-[hsl(var(--primary))]"
                              data-testid={`checkbox-viewer-${f.id}`}
                            />
                            <span className="truncate">{f.displayName || f.username}</span>
                          </label>
                        );
                      })}
                      {aud.viewerIds.length === 0 && <p className="px-1.5 pt-1 text-xs text-muted-foreground">Nobody is selected, so nobody can see you.</p>}
                    </div>
                  )
                )}
              </div>
            </div>
          )}

          {!located && (
            <div className="pointer-events-auto self-start rounded-xl border bg-card/95 px-3 py-2 text-xs text-muted-foreground backdrop-blur">
              Location is off, so this is a default view. Allow location to see what's near you.
            </div>
          )}
        </div>

        {!panel && debouncedQ.length < 2 && (
          <button
            onClick={() => locate((p) => mapRef.current?.flyTo(p, 15, { duration: 0.6 }))}
            aria-label="Centre on my location"
            className="absolute left-3 top-[6.5rem] z-10 grid h-10 w-10 place-items-center rounded-full border bg-card/90 backdrop-blur"
            data-testid="button-map-locate"
          >
            <Navigation2Icon className="h-4 w-4" />
          </button>
        )}

        {!panel && (
          <div className="absolute inset-x-0 bottom-0 z-10 rounded-t-3xl border-t bg-card px-4 pb-4 pt-2 shadow-[0_-16px_40px_rgba(0,0,0,.35)] md:left-auto md:right-4 md:bottom-4 md:w-96 md:rounded-3xl md:border">
            <div className="mx-auto mb-2 h-1 w-9 rounded-full bg-foreground/20 md:hidden" />
            {selected ? (
              <SelectedCard selected={selected} onClose={() => setSelected(null)} />
            ) : (
              <div className="space-y-2.5">
                <h2 className="text-[0.65rem] font-medium uppercase tracking-[0.28em] text-muted-foreground">Near you · {RADIUS_KM} km</h2>
                {nothingNearby && <p className="py-2 text-sm text-muted-foreground">Nothing on the map nearby yet. Try Discover for events further out.</p>}
                {!data && center && <p className="py-2 text-sm text-muted-foreground">Looking around…</p>}
                {nearList.map(({ sel, lat, lng, d }) => (
                  <button key={`${sel!.type}-${sel!.item.id}`} onClick={() => focus(sel, lat, lng)} className="flex w-full items-center gap-3 text-left" data-testid={`map-near-${sel!.type}-${sel!.item.id}`}>
                    <Thumb sel={sel!} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{titleOf(sel!)}</span>
                      <span className="block truncate text-xs text-muted-foreground">{subOf(sel!)}</span>
                      {sel!.type === "event" && goingLabel(sel!.item) && <span className="block truncate text-xs text-primary">{goingLabel(sel!.item)}</span>}
                    </span>
                    <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[0.65rem] font-semibold text-primary">{fmtDist(d)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
      <BottomNavigation />
    </div>
  );
}

function titleOf(s: NonNullable<Selected>) {
  return s.type === "friend" ? friendName(s.item) : s.type === "event" ? s.item.title : s.item.name;
}
function subOf(s: NonNullable<Selected>) {
  if (s.type === "friend") return "Friend · out now";
  if (s.type === "event") return `${eventWhen(s.item)} · ${s.item.location}`;
  return s.item.address || s.item.category;
}
function Thumb({ sel }: { sel: NonNullable<Selected> }) {
  const base = "grid h-11 w-11 shrink-0 place-items-center overflow-hidden";
  if (sel.type === "friend") {
    return <span className={`${base} rounded-full border-2 border-primary bg-primary/30 text-sm font-semibold`}>{sel.item.avatarUrl ? <img src={sel.item.avatarUrl} alt="" className="h-full w-full object-cover" /> : friendName(sel.item).charAt(0).toUpperCase()}</span>;
  }
  const img = sel.item.imageUrl;
  return (
    <span className={`${base} rounded-xl ${sel.type === "event" ? "bg-gradient-to-br from-violet-900/40 to-card text-primary" : "border bg-muted"}`}>
      {img ? <img src={img} alt="" className="h-full w-full object-cover" /> : sel.type === "event" ? <CalendarIcon className="h-5 w-5" /> : <Building2Icon className="h-5 w-5" />}
    </span>
  );
}

function SelectedCard({ selected, onClose }: { selected: NonNullable<Selected>; onClose: () => void }) {
  const href = selected.type === "event" ? `/event/${selected.item.id}` : selected.type === "venue" ? `/venue/${selected.item.id}` : `/profile/${selected.item.username}`;
  const cta = selected.type === "event" ? (selected.item.ticketPrice ? `Get tickets · ${eventPrice(selected.item)}` : "View event") : selected.type === "venue" ? "View venue" : "View profile";
  const dir = selected.type !== "friend" ? `https://www.google.com/maps/dir/?api=1&destination=${selected.item.latitude},${selected.item.longitude}` : null;
  return (
    <div className="space-y-3" data-testid="map-selected">
      <div className="flex items-start gap-3">
        <Thumb sel={selected} />
        <div className="min-w-0 flex-1">
          {selected.type === "event" && <span className="mb-1 inline-block rounded-full bg-primary/15 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-primary">{eventWhen(selected.item)}</span>}
          <p className="truncate text-base font-semibold">{titleOf(selected)}</p>
          <p className="truncate text-xs text-muted-foreground">{subOf(selected)}</p>
        </div>
        <button onClick={onClose} aria-label="Close" className="text-muted-foreground"><XIcon className="h-4 w-4" /></button>
      </div>
      {selected.type === "event" && goingLabel(selected.item) && (
        <div className="flex items-center gap-2" data-testid="map-friends-going">
          <div className="flex">
            {selected.item.friendsGoing!.sample.map((u) => (
              <span key={u.id} className="-ml-1.5 grid h-6 w-6 place-items-center overflow-hidden rounded-full border-2 border-card bg-primary/30 text-[0.65rem] font-semibold first:ml-0">
                {u.avatarUrl ? <img src={u.avatarUrl} alt="" className="h-full w-full object-cover" /> : (u.displayName || u.username).charAt(0).toUpperCase()}
              </span>
            ))}
          </div>
          <span className="truncate text-xs text-muted-foreground">{goingLabel(selected.item)}</span>
        </div>
      )}
      <div className="flex gap-2">
        <Link href={href} className="flex-1"><Button className="w-full rounded-full" data-testid="button-map-selected-view">{cta}</Button></Link>
        {dir && <a href={dir} target="_blank" rel="noopener noreferrer"><Button variant="outline" className="rounded-full">Directions</Button></a>}
      </div>
    </div>
  );
}
