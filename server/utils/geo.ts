// Haversine formula for calculating distance between two coordinates (in miles)
export function calculateDistanceMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3959; // Earth's radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Forward geocode an address to coordinates using OpenStreetMap Nominatim
export async function geocodeAddress(address: string): Promise<{ latitude: number; longitude: number; city: string | null } | null> {
  try {
    // Add UK bias for better results
    const searchAddress = address.includes("UK") || address.includes("United Kingdom")
      ? address
      : `${address}, UK`;

    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchAddress)}&format=json&addressdetails=1&limit=1`,
      {
        headers: {
          "User-Agent": "VibePulse/1.0 (social-events-platform)",
        },
      }
    );

    if (!response.ok) {
      console.error("Geocoding request failed:", response.status);
      return null;
    }

    const results = await response.json();
    if (!results || results.length === 0) {
      console.log("No geocoding results for:", address);
      return null;
    }

    const result = results[0];
    const lat = parseFloat(result.lat);
    const lon = parseFloat(result.lon);

    if (isNaN(lat) || isNaN(lon)) {
      return null;
    }

    // Extract city from address details
    const addr = result.address || {};
    const city = addr.city || addr.town || addr.village || addr.county || null;

    console.log(`Geocoded "${address}" to lat=${lat}, lon=${lon}, city=${city}`);
    return { latitude: lat, longitude: lon, city };
  } catch (error) {
    console.error("Geocoding error for address:", address, error);
    return null;
  }
}

// Helper to add distance to events/venues and sort by proximity
export function sortByProximity<T extends { latitude?: number | null; longitude?: number | null }>(
  items: T[],
  userLat: number,
  userLon: number
): (T & { distance: number | null })[] {
  return items
    .map(item => ({
      ...item,
      distance: item.latitude && item.longitude
        ? calculateDistanceMiles(userLat, userLon, item.latitude, item.longitude)
        : null
    }))
    .sort((a, b) => {
      if (a.distance !== null && b.distance !== null) return a.distance - b.distance;
      if (a.distance !== null) return -1;
      if (b.distance !== null) return 1;
      return 0;
    });
}
