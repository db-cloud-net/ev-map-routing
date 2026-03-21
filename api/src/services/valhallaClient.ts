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
function polylineAbortSignal(): AbortSignal | undefined {
  const ms = Number(process.env.PLAN_VALHALLA_POLYLINE_TIMEOUT_MS ?? "60000");
  return Number.isFinite(ms) && ms > 0 ? AbortSignal.timeout(Math.floor(ms)) : undefined;
}

/** Per-leg `/route` calls inside the segment solver (`leastTimeSegment`). */
function legRouteAbortSignal(): AbortSignal | undefined {
  const ms = Number(process.env.PLAN_VALHALLA_LEG_TIMEOUT_MS ?? "30000");
  return Number.isFinite(ms) && ms > 0 ? AbortSignal.timeout(Math.floor(ms)) : undefined;
}

function extractLineStringFromValhalla(json: any): ItineraryLeg["geometry"] | undefined {
  const leg = json?.trip?.legs?.[0];
  const shape = leg?.shape;

  if (shape?.type === "LineString" && Array.isArray(shape.coordinates)) {
    return { type: "LineString", coordinates: shape.coordinates };
  }

  // Some configurations return coordinates directly as an array.
  if (Array.isArray(leg?.shape) && (leg.shape as any[]).length > 1) {
    const coords = leg.shape as any[];
    if (coords.every((p) => Array.isArray(p) && p.length >= 2)) {
      return {
        type: "LineString",
        coordinates: coords.map((p) => [p[0], p[1]])
      };
    }
  }

  return undefined;
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
    const leg = json?.trip?.legs?.[0];
    if (!leg) return {};

    // geometry
    const shape = leg?.shape;
    let geometry: ItineraryLeg["geometry"] | undefined;
    if (shape?.type === "LineString" && Array.isArray(shape.coordinates)) {
      geometry = { type: "LineString", coordinates: shape.coordinates };
    } else if (Array.isArray(leg?.shape) && leg.shape.length > 1) {
      // Some Valhalla configurations return coordinates directly.
      const coords = leg.shape as any[];
      if (coords.every((p) => Array.isArray(p) && p.length >= 2)) {
        geometry = {
          type: "LineString",
          coordinates: coords.map((p) => [p[0], p[1]])
        };
      }
    }

    // maneuvers
    const maneuvers = leg?.maneuvers ?? leg?.maneuver ?? [];
    const parsedManeuvers: NonNullable<ItineraryLeg["maneuvers"]> = [];
    if (Array.isArray(maneuvers)) {
      for (const m of maneuvers) {
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

    return { geometry, maneuvers: parsedManeuvers.length ? parsedManeuvers : undefined };
  });
}

