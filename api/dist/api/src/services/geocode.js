"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeocodeError = void 0;
exports.geocodeTextToLatLng = geocodeTextToLatLng;
class GeocodeError extends Error {
    constructor(message) {
        super(message);
        this.name = "GeocodeError";
    }
}
exports.GeocodeError = GeocodeError;
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
async function geocodeTextToLatLng(query) {
    const baseUrl = process.env.NOMINATIM_BASE_URL ?? "https://nominatim.openstreetmap.org/search";
    const attempts = 2;
    const userAgent = process.env.NOMINATIM_USER_AGENT ?? "ev-map-routing-mvp/0.1";
    for (let i = 0; i < attempts; i++) {
        const url = new URL(baseUrl);
        url.searchParams.set("q", query);
        url.searchParams.set("format", "json");
        url.searchParams.set("limit", "1");
        const resp = await fetch(url.toString(), {
            headers: { "User-Agent": userAgent }
        });
        if (!resp.ok) {
            if (i === attempts - 1)
                throw new GeocodeError(`Geocoding failed (${resp.status})`);
            await sleep(250 * (i + 1));
            continue;
        }
        const json = (await resp.json());
        const first = json?.[0];
        if (!first?.lat || !first?.lon)
            throw new GeocodeError(`No geocode match for "${query}"`);
        return { lat: Number(first.lat), lon: Number(first.lon) };
    }
    throw new GeocodeError(`No geocode match for "${query}"`);
}
