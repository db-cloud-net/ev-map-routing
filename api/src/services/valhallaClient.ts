import type { LatLng, ItineraryLeg } from "../types";
import { getValhallaBaseUrl } from "../config/valhallaBaseUrl";
import { timeProviderCall } from "./providerCallMetrics";

export class ValhallaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValhallaError";
  }
}

/** Initial `/route` polyline for corridor sampling (`planTrip`). */
/**
 * Decode Google-encoded polyline (Valhalla uses **precision 6** for JSON `shape` strings).
 * Returns GeoJSON order: [lng, lat][].
 */
function decodeEncodedPolyline(encoded: string, precision: number): [number, number][] {
  const factor = Math.pow(10, precision);
  let index = 0;
  let lat = 0;
  let lng = 0;
  const coordinates: [number, number][] = [];

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const deltaLat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const deltaLng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lng += deltaLng;

    coordinates.push([lng / factor, lat / factor]);
  }

  return coordinates;
}

function shapeFieldToLineString(shape: unknown): ItineraryLeg["geometry"] | undefined {
  if (shape == null) return undefined;

  if (typeof shape === "string" && shape.length > 0) {
    try {
      const coords = decodeEncodedPolyline(shape, 6);
      if (coords.length >= 2) {
        return { type: "LineString", coordinates: coords };
      }
    } catch {
      try {
        const coords = decodeEncodedPolyline(shape, 5);
        if (coords.length >= 2) {
          return { type: "LineString", coordinates: coords };
        }
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  if (typeof shape === "object" && shape !== null && "type" in shape) {
    const s = shape as { type?: string; coordinates?: unknown };
    if (s.type === "LineString" && Array.isArray(s.coordinates)) {
      return { type: "LineString", coordinates: s.coordinates as [number, number][] };
    }
  }

  if (Array.isArray(shape) && shape.length > 1) {
    const coords = shape as any[];
    if (coords.every((p) => Array.isArray(p) && p.length >= 2)) {
      return {
        type: "LineString",
        coordinates: coords.map((p) => [p[0], p[1]])
      };
    }
  }

  return undefined;
}

function polylineAbortSignal(): AbortSignal | undefined {
  const ms = Number(process.env.PLAN_VALHALLA_POLYLINE_TIMEOUT_MS ?? "60000");
  return Number.isFinite(ms) && ms > 0 ? AbortSignal.timeout(Math.floor(ms)) : undefined;
}

/** Per-leg `/route` calls inside the segment solver (`leastTimeSegment`). */
function legRouteAbortSignal(): AbortSignal | undefined {
  const ms = Number(process.env.PLAN_VALHALLA_LEG_TIMEOUT_MS ?? "30000");
  return Number.isFinite(ms) && ms > 0 ? AbortSignal.timeout(Math.floor(ms)) : undefined;
}

/**
 * Same shape extraction as `parseValhallaRouteLegJson` — must decode encoded polylines.
 * Long `/route` responses often use a polyline **string** instead of GeoJSON; `getRoutePolyline` is used for
 * NREL corridor sampling — without decoding, we fell back to straight-line samples (chargers off-corridor).
 */
function extractLineStringFromValhalla(json: any): ItineraryLeg["geometry"] | undefined {
  const leg = json?.trip?.legs?.[0];
  const shape = leg?.shape ?? json?.trip?.shape;
  return shapeFieldToLineString(shape);
}

export async function getRoutePolyline(from: LatLng, to: LatLng): Promise<ItineraryLeg["geometry"]> {
  return timeProviderCall("valhalla", async () => {
    const baseUrl = getValhallaBaseUrl();
    const url = `${baseUrl}/route`;
    const signal = polylineAbortSignal();

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          locations: [
            { lat: from.lat, lon: from.lon },
            { lat: to.lat, lon: to.lon }
          ],
          costing: "auto",
          directions: false,
          units: "miles",
          shape_format: "geojson"
        })
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const name = e instanceof Error ? e.name : "";
      if (name === "AbortError" || msg.toLowerCase().includes("abort")) {
        const ms = process.env.PLAN_VALHALLA_POLYLINE_TIMEOUT_MS ?? "60000";
        throw new ValhallaError(
          `Valhalla route timed out (PLAN_VALHALLA_POLYLINE_TIMEOUT_MS=${ms}ms)`
        );
      }
      throw new ValhallaError(`Valhalla fetch failed at ${url}: ${msg}`);
    }

    if (!resp.ok) {
      throw new ValhallaError(`Valhalla route failed (${resp.status})`);
    }

    const json = await resp.json();
    const geometry = extractLineStringFromValhalla(json);
    if (!geometry) throw new ValhallaError("Valhalla response missing route geometry");
    return geometry;
  });
}

function getTimeSecondsFromResponse(json: any): number | null {
  const t =
    json?.trip?.summary?.time ??
    json?.trip?.summary?.time_seconds ??
    json?.trip?.time;
  return typeof t === "number" ? t : typeof t === "string" ? Number(t) : null;
}

function getDistanceMilesFromResponse(json: any): number | null {
  const d =
    json?.trip?.summary?.length ??
    json?.trip?.summary?.distance ??
    json?.trip?.distance;
  return typeof d === "number" ? d : typeof d === "string" ? Number(d) : null;
}

export async function getTravelTimeMinutes(from: LatLng, to: LatLng): Promise<number> {
  return timeProviderCall("valhalla", async () => {
    const baseUrl = getValhallaBaseUrl();
    const url = `${baseUrl}/route`;
    const signal = legRouteAbortSignal();

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          locations: [
            { lat: from.lat, lon: from.lon },
            { lat: to.lat, lon: to.lon }
          ],
          costing: "auto",
          directions: false,
          units: "miles",
          // Request geojson if supported; planner can fall back to time-only.
          shape_format: "geojson"
        })
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const name = e instanceof Error ? e.name : "";
      if (name === "AbortError" || msg.toLowerCase().includes("abort")) {
        const ms = process.env.PLAN_VALHALLA_LEG_TIMEOUT_MS ?? "30000";
        throw new ValhallaError(
          `Valhalla route timed out (PLAN_VALHALLA_LEG_TIMEOUT_MS=${ms}ms)`
        );
      }
      throw new ValhallaError(`Valhalla fetch failed at ${url}: ${msg}`);
    }

    if (!resp.ok) {
      throw new ValhallaError(`Valhalla route failed (${resp.status})`);
    }

    const json = await resp.json();
    const seconds = getTimeSecondsFromResponse(json);
    if (seconds == null || !Number.isFinite(seconds)) {
      throw new ValhallaError("Valhalla response missing travel time");
    }

    return seconds / 60;
  });
}

export async function getTravelDistanceMiles(from: LatLng, to: LatLng): Promise<number> {
  return timeProviderCall("valhalla", async () => {
    const baseUrl = getValhallaBaseUrl();
    const url = `${baseUrl}/route`;
    const signal = legRouteAbortSignal();

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          locations: [
            { lat: from.lat, lon: from.lon },
            { lat: to.lat, lon: to.lon }
          ],
          costing: "auto",
          directions: false,
          units: "miles",
          shape_format: "geojson"
        })
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const name = e instanceof Error ? e.name : "";
      if (name === "AbortError" || msg.toLowerCase().includes("abort")) {
        const ms = process.env.PLAN_VALHALLA_LEG_TIMEOUT_MS ?? "30000";
        throw new ValhallaError(
          `Valhalla route timed out (PLAN_VALHALLA_LEG_TIMEOUT_MS=${ms}ms)`
        );
      }
      throw new ValhallaError(`Valhalla fetch failed at ${url}: ${msg}`);
    }

    if (!resp.ok) {
      throw new ValhallaError(`Valhalla route failed (${resp.status})`);
    }

    const json = await resp.json();
    const miles = getDistanceMilesFromResponse(json);
    if (miles == null || !Number.isFinite(miles)) {
      throw new ValhallaError("Valhalla response missing travel distance");
    }
    return miles;
  });
}

function parseValhallaRouteLegJson(json: any): {
  geometry?: ItineraryLeg["geometry"];
  maneuvers?: ItineraryLeg["maneuvers"];
  tripTimeSeconds: number | null;
  tripDistanceMiles: number | null;
} {
  const tripTimeSeconds = getTimeSecondsFromResponse(json);
  const tripDistanceMiles = getDistanceMilesFromResponse(json);
  const leg = json?.trip?.legs?.[0];
  if (!leg) {
    return { tripTimeSeconds, tripDistanceMiles };
  }

  const shape = leg?.shape ?? json?.trip?.shape;
  const geometry = shapeFieldToLineString(shape);

  const rawManeuvers = leg?.maneuvers ?? leg?.maneuver ?? [];
  const parsedManeuvers: NonNullable<ItineraryLeg["maneuvers"]> = [];
  if (Array.isArray(rawManeuvers)) {
    for (const m of rawManeuvers) {
      const text =
        m?.instruction ?? m?.text ?? m?.name ?? m?.modifier ?? m?.sign ?? null;
      if (typeof text === "string" && text.trim()) {
        parsedManeuvers.push({
          text: text.trim(),
          instructionType: m?.instruction_type ?? m?.type,
          distanceMeters: typeof m?.length === "number" ? m.length : undefined,
          timeSeconds: typeof m?.time === "number" ? m.time : undefined
        });
      }
    }
  }

  return {
    geometry,
    maneuvers: parsedManeuvers.length ? parsedManeuvers : undefined,
    tripTimeSeconds,
    tripDistanceMiles
  };
}

export async function getRouteLegGeometryAndManeuvers(
  from: LatLng,
  to: LatLng
): Promise<{ geometry?: ItineraryLeg["geometry"]; maneuvers?: ItineraryLeg["maneuvers"] }> {
  return timeProviderCall("valhalla", async () => {
    const baseUrl = getValhallaBaseUrl();
    const url = `${baseUrl}/route`;

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locations: [
            { lat: from.lat, lon: from.lon },
            { lat: to.lat, lon: to.lon }
          ],
          costing: "auto",
          directions: true,
          directions_type: "maneuver",
          units: "miles",
          shape_format: "geojson"
        })
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ValhallaError(`Valhalla fetch failed at ${url}: ${msg}`);
    }

    if (!resp.ok) {
      throw new ValhallaError(`Valhalla directions failed (${resp.status})`);
    }

    const json = await resp.json();
    const parsed = parseValhallaRouteLegJson(json);
    return { geometry: parsed.geometry, maneuvers: parsed.maneuvers };
  });
}

/**
 * Single Valhalla `/route` with directions + trip summary — for Slice 4 route preview (fast path, no EV solver).
 * Uses the same polyline timeout budget as corridor polylines.
 */
export async function getRouteWithDirectionsAndSummary(
  from: LatLng,
  to: LatLng
): Promise<{
  geometry?: ItineraryLeg["geometry"];
  maneuvers?: ItineraryLeg["maneuvers"];
  tripTimeSeconds: number | null;
  tripDistanceMiles: number | null;
}> {
  return timeProviderCall("valhalla", async () => {
    const baseUrl = getValhallaBaseUrl();
    const url = `${baseUrl}/route`;
    const signal = polylineAbortSignal();

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          locations: [
            { lat: from.lat, lon: from.lon },
            { lat: to.lat, lon: to.lon }
          ],
          costing: "auto",
          directions: true,
          directions_type: "maneuver",
          units: "miles",
          shape_format: "geojson"
        })
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const name = e instanceof Error ? e.name : "";
      if (name === "AbortError" || msg.toLowerCase().includes("abort")) {
        const ms = process.env.PLAN_VALHALLA_POLYLINE_TIMEOUT_MS ?? "60000";
        throw new ValhallaError(
          `Valhalla route timed out (PLAN_VALHALLA_POLYLINE_TIMEOUT_MS=${ms}ms)`
        );
      }
      throw new ValhallaError(`Valhalla fetch failed at ${url}: ${msg}`);
    }

    if (!resp.ok) {
      throw new ValhallaError(`Valhalla directions failed (${resp.status})`);
    }

    const json = await resp.json();
    return parseValhallaRouteLegJson(json);
  });
}

