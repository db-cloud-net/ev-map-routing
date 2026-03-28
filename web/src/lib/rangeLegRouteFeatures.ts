import type { ItineraryStop, PlanTripResponse, RangeLegSummary } from "../../../shared/types";

/**
 * **Debug-only:** `buildRangeLegRouteFeatureCollection` splits the merged route by presentation `rangeLegs`
 * for map validation — gated by `NEXT_PUBLIC_MAP_DEBUG_RANGE_LEGS` in `map/page.tsx`.
 *
 * Legacy: map used one layer per index (`route-line-0`…); keep count for clearing old layers.
 */
export const RANGE_LEG_LAYER_COUNT = 8;

function distSq(lon: number, lat: number, s: ItineraryStop["coords"]): number {
  const dx = lon - s.lon;
  const dy = lat - s.lat;
  return dx * dx + dy * dy;
}

/**
 * For each itinerary stop, find the closest point on `routeCoords` at or after the previous stop's
 * index — keeps indices monotonic along a typical A→B corridor polyline.
 */
export function computeMonotonicStopSnapIndicesOnRoute(
  routeCoords: Array<[number, number]>,
  stops: ItineraryStop[]
): number[] | null {
  if (routeCoords.length < 2 || stops.length < 2) return null;
  const out: number[] = [];
  let j0 = 0;
  for (let i = 0; i < stops.length; i++) {
    let bestJ = j0;
    let bestD = Infinity;
    for (let j = j0; j < routeCoords.length; j++) {
      const [lon, lat] = routeCoords[j];
      const d = distSq(lon, lat, stops[i].coords);
      if (d < bestD) {
        bestD = d;
        bestJ = j;
      }
    }
    out.push(bestJ);
    j0 = bestJ;
  }
  return out;
}

/** When the route is the per-stop chord polyline (same length as stops), snap is identity. */
function chordSnapIndices(stopsLen: number, routeLen: number): number[] | null {
  if (stopsLen !== routeLen || stopsLen < 2) return null;
  return Array.from({ length: stopsLen }, (_, i) => i);
}

export type RangeLegLineFeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    /** 0-based index along `rangeLegs` (for debugging / future use). */
    properties: { legIndex: number };
    geometry: { type: "LineString"; coordinates: [number, number][] };
  }>;
};

/**
 * Split `routeCoords` into LineStrings by **`plan.rangeLegs`** (charge-boundary chunks).
 * Returns `null` if splitting is unsafe — caller should draw a single blue line.
 * Used only when **`NEXT_PUBLIC_MAP_DEBUG_RANGE_LEGS`** is enabled (debug tooling).
 */
export function buildRangeLegRouteFeatureCollection(
  plan: PlanTripResponse,
  routeCoords: Array<[number, number]>,
  rangeLegs: RangeLegSummary[]
): RangeLegLineFeatureCollection | null {
  if (plan.status !== "ok" || rangeLegs.length === 0 || routeCoords.length < 2) return null;

  const stops = plan.stops;
  let snap =
    chordSnapIndices(stops.length, routeCoords.length) ??
    computeMonotonicStopSnapIndicesOnRoute(routeCoords, stops);
  if (!snap || snap.length !== stops.length) return null;

  /** Ensure snap indices never go backward along the polyline (rare self-crossing / noisy GPS). */
  for (let i = 1; i < snap.length; i++) {
    if (snap[i]! < snap[i - 1]!) {
      snap[i] = snap[i - 1]!;
    }
  }

  const idToIndex = new Map<string, number>();
  for (let i = 0; i < stops.length; i++) {
    idToIndex.set(stops[i].id, i);
  }

  const features: RangeLegLineFeatureCollection["features"] = [];

  for (let legIdx = 0; legIdx < rangeLegs.length; legIdx++) {
    const rl = rangeLegs[legIdx];
    const si = idToIndex.get(rl.fromStopId);
    const ei = idToIndex.get(rl.toStopId);
    if (si === undefined || ei === undefined || ei < si) continue;
    let a = snap[si]!;
    let b = snap[ei]!;
    if (b < a) continue;
    /** Adjacent stops can snap to the same vertex; ensure at least one edge of polyline. */
    if (b === a) {
      b = Math.min(a + 1, routeCoords.length - 1);
    }
    if (a >= routeCoords.length || b >= routeCoords.length || a > b) continue;

    const segment = routeCoords.slice(a, b + 1).map((c) => [c[0], c[1]] as [number, number]);
    if (segment.length < 2) continue;

    features.push({
      type: "Feature",
      properties: { legIndex: legIdx },
      geometry: {
        type: "LineString",
        coordinates: segment
      }
    });
  }

  if (features.length === 0) return null;
  return { type: "FeatureCollection", features };
}
