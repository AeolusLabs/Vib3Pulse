import { useState, useEffect, useCallback } from "react";

export interface GeolocationState {
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  error: string | null;
  loading: boolean;
  permissionStatus: "granted" | "denied" | "prompt" | "unknown";
}

interface StoredLocation {
  latitude: number;
  longitude: number;
  city: string | null;
  timestamp: number;
}

const LOCATION_STORAGE_KEY = "vibepulse_user_location";
const LOCATION_CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

export function useGeolocation() {
  const [state, setState] = useState<GeolocationState>({
    latitude: null,
    longitude: null,
    city: null,
    error: null,
    loading: false,
    permissionStatus: "unknown",
  });

  // Load cached location on mount
  useEffect(() => {
    const cached = localStorage.getItem(LOCATION_STORAGE_KEY);
    if (cached) {
      try {
        const stored: StoredLocation = JSON.parse(cached);
        const isExpired = Date.now() - stored.timestamp > LOCATION_CACHE_DURATION;
        if (!isExpired) {
          setState(prev => ({
            ...prev,
            latitude: stored.latitude,
            longitude: stored.longitude,
            city: stored.city,
          }));
        }
      } catch (e) {
        localStorage.removeItem(LOCATION_STORAGE_KEY);
      }
    }

    // Check permission status
    if ("permissions" in navigator) {
      navigator.permissions.query({ name: "geolocation" }).then((result) => {
        setState(prev => ({ ...prev, permissionStatus: result.state as any }));
        result.onchange = () => {
          setState(prev => ({ ...prev, permissionStatus: result.state as any }));
        };
      }).catch(() => {
        // Some browsers don't support permissions API
      });
    }
  }, []);

  // Reverse geocode to get city name
  const reverseGeocode = useCallback(async (lat: number, lng: number): Promise<string | null> => {
    try {
      // Use Nominatim (OpenStreetMap) for reverse geocoding - free, no API key needed
      const response = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`,
        {
          headers: {
            "User-Agent": "VibePulse/1.0",
          },
        }
      );
      if (!response.ok) return null;
      
      const data = await response.json();
      const address = data.address;
      
      // Try to get city, town, village, or county
      const city = address?.city || address?.town || address?.village || address?.county || address?.state;
      return city || null;
    } catch (error) {
      console.error("Reverse geocoding error:", error);
      return null;
    }
  }, []);

  const requestLocation = useCallback(async () => {
    if (!("geolocation" in navigator)) {
      setState(prev => ({
        ...prev,
        error: "Geolocation is not supported by your browser",
        loading: false,
      }));
      return;
    }

    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 60000,
        });
      });

      const { latitude, longitude } = position.coords;
      
      // Get city name via reverse geocoding
      const city = await reverseGeocode(latitude, longitude);

      // Store in localStorage
      const storedLocation: StoredLocation = {
        latitude,
        longitude,
        city,
        timestamp: Date.now(),
      };
      localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify(storedLocation));

      setState({
        latitude,
        longitude,
        city,
        error: null,
        loading: false,
        permissionStatus: "granted",
      });
    } catch (error: any) {
      let errorMessage = "Failed to get location";
      
      if (error.code === 1) {
        errorMessage = "Location permission denied";
        setState(prev => ({ ...prev, permissionStatus: "denied" }));
      } else if (error.code === 2) {
        errorMessage = "Location unavailable";
      } else if (error.code === 3) {
        errorMessage = "Location request timed out";
      }

      setState(prev => ({
        ...prev,
        error: errorMessage,
        loading: false,
      }));
    }
  }, [reverseGeocode]);

  const clearLocation = useCallback(() => {
    localStorage.removeItem(LOCATION_STORAGE_KEY);
    setState({
      latitude: null,
      longitude: null,
      city: null,
      error: null,
      loading: false,
      permissionStatus: "unknown",
    });
  }, []);

  // Calculate distance between two points (Haversine formula)
  const calculateDistance = useCallback((lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 3959; // Earth's radius in miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }, []);

  const getDistanceFromUser = useCallback((lat: number, lon: number): number | null => {
    if (state.latitude === null || state.longitude === null) return null;
    return calculateDistance(state.latitude, state.longitude, lat, lon);
  }, [state.latitude, state.longitude, calculateDistance]);

  const formatDistance = useCallback((miles: number): string => {
    if (miles < 0.5) {
      return "Nearby";
    } else if (miles < 1) {
      return "Less than 1 mile";
    } else if (miles < 10) {
      return `${miles.toFixed(1)} miles`;
    } else {
      return `${Math.round(miles)} miles`;
    }
  }, []);

  return {
    ...state,
    requestLocation,
    clearLocation,
    getDistanceFromUser,
    formatDistance,
    hasLocation: state.latitude !== null && state.longitude !== null,
  };
}
