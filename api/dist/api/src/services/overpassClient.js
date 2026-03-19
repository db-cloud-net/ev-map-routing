"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OverpassError = void 0;
exports.findHolidayInnExpressNearby = findHolidayInnExpressNearby;
class OverpassError extends Error {
    constructor(message) {
        super(message);
        this.name = "OverpassError";
    }
}
exports.OverpassError = OverpassError;
function haversineMiles(a, b) {
    const R = 3958.8;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const lat1 = (a.lat * Math.PI) / 180;
    const lat2 = (b.lat * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}
async function findHolidayInnExpressNearby(point, radiusMeters) {
    const overpassUrl = process.env.OVERPASS_BASE_URL ?? "https://overpass-api.de/api/interpreter";
    // Overpass: match Holiday Inn Express by name or brand (OSM tagging varies).
    const pattern = "Holiday Inn Express";
    const q = `
[out:json][timeout:30];
(
  node["name"~"${pattern}",i]["tourism"="hotel"](around:${radiusMeters},${point.lat},${point.lon});
  way["name"~"${pattern}",i]["tourism"="hotel"](around:${radiusMeters},${point.lat},${point.lon});
  relation["name"~"${pattern}",i]["tourism"="hotel"](around:${radiusMeters},${point.lat},${point.lon});
  node["brand"~"${pattern}",i]["tourism"="hotel"](around:${radiusMeters},${point.lat},${point.lon});
  way["brand"~"${pattern}",i]["tourism"="hotel"](around:${radiusMeters},${point.lat},${point.lon});
  relation["brand"~"${pattern}",i]["tourism"="hotel"](around:${radiusMeters},${point.lat},${point.lon});
);
out center tags;`;
    const resp = await fetch(overpassUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: q
    });
    if (!resp.ok) {
        throw new OverpassError(`Overpass request failed (${resp.status})`);
    }
    const json = (await resp.json());
    const elements = Array.isArray(json?.elements) ? json.elements : [];
    const hotels = [];
    for (const el of elements) {
        const lat = el?.lat != null
            ? Number(el.lat)
            : el?.center?.lat != null
                ? Number(el.center.lat)
                : null;
        const lon = el?.lon != null
            ? Number(el.lon)
            : el?.center?.lon != null
                ? Number(el.center.lon)
                : null;
        if (lat == null || lon == null)
            continue;
        const name = String(el?.tags?.name ?? el?.tags?.brand ?? "Holiday Inn Express");
        const id = String(el?.id ?? `${lat},${lon}`);
        const coords = { lat, lon };
        const miles = haversineMiles(point, coords);
        // Defensive filter: keep only within radius to enforce MVP rule C.
        if (miles * 1609.34 <= radiusMeters) {
            hotels.push({ id, name, coords });
        }
    }
    // Dedupe by coords/name.
    const seen = new Set();
    const out = [];
    for (const h of hotels) {
        const key = `${h.coords.lat.toFixed(4)}:${h.coords.lon.toFixed(4)}:${h.name}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(h);
    }
    return out;
}
