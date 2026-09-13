import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

// Leaflet's default marker images reference relative paths that don't survive
// a bundler — import them as real Vite assets and point the default icon at
// the fingerprinted URLs once, at module load.
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

interface AlertLocationMapProps {
  latitude: number;
  longitude: number;
  accuracyMeters?: number | null;
  className?: string;
}

export function AlertLocationMap({ latitude, longitude, accuracyMeters, className }: AlertLocationMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const circleRef = useRef<L.Circle | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = L.map(containerRef.current, {
      center: [latitude, longitude],
      zoom: 16,
      attributionControl: true,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    markerRef.current = L.marker([latitude, longitude]).addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      circleRef.current = null;
    };
    // Only set up once per mount — position updates are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!mapRef.current || !markerRef.current) return;
    mapRef.current.setView([latitude, longitude]);
    markerRef.current.setLatLng([latitude, longitude]);

    if (circleRef.current) {
      circleRef.current.remove();
      circleRef.current = null;
    }
    if (accuracyMeters && accuracyMeters > 0) {
      circleRef.current = L.circle([latitude, longitude], {
        radius: accuracyMeters,
        color: "#7C46D6",
        fillColor: "#7C46D6",
        fillOpacity: 0.12,
        weight: 1,
      }).addTo(mapRef.current);
    }
  }, [latitude, longitude, accuracyMeters]);

  return <div ref={containerRef} className={className ?? "h-56 w-full rounded-xl overflow-hidden"} data-testid="map-alert-location" />;
}
