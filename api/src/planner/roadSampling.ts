import type { LatLng } from "../types";
import { haversineMiles } from "./geo";

type LonLat = [number, number];

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function normalizeLonLat(coords: LonLat[]): LatLng[] {
  // Valhalla geojson line strings are [lon,lat].
  return coords.map((c) => ({ lon: c[0], lat: c[1] }));
}

export function samplePointsAlongPolyline(
  line: { type: "LineString"; coordinates: LonLat[] },
  stepMiles: number,
  maxSamples: number
): LatLng[] {
  const coords = line.coordinates;
  if (!coords || coords.length < 2) return [];

  const points = normalizeLonLat(coords);

  // Build cumulative distances.
  const cumulative: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const d = haversineMiles(points[i - 1], points[i]);
    cumulative.push(cumulative[cumulative.length - 1] + d);
  }

  const total = cumulative[cumulative.length - 1];
  if (!Number.isFinite(total) || total <= 0) return [];

  // Desired sample distances.
  const desired: number[] = [0];
  for (let dist = stepMiles; dist < total; dist += stepMiles) {
    desired.push(dist);
  }
  if (desired[desired.length - 1] !== total) desired.push(total);

  if (desired.length > maxSamples) {
    // Reduce count by skipping every k-th desired point.
    const k = Math.ceil(desired.length / maxSamples);
    const reduced = [];
    for (let i = 0; i < desired.length; i++) {
      if (i % k === 0) reduced.push(desired[i]);
    }
    if (reduced[reduced.length - 1] !== total) reduced.push(total);
    return sampleAtDistances(points, cumulative, reduced);
  }

  return sampleAtDistances(points, cumulative, desired);
}

function sampleAtDistances(points: Array<{ lat: number; lon: number }>, cumulative: number[], dists: number[]): LatLng[] {
  const out: LatLng[] = [];
  let segIdx = 0;

  for (const target of dists) {
    while (segIdx < cumulative.length - 2 && cumulative[segIdx + 1] < target) {
      segIdx++;
    }
    const d0 = cumulative[segIdx];
    const d1 = cumulative[segIdx + 1];
    const p0 = points[segIdx];
    const p1 = points[segIdx + 1];

    if (d1 <= d0) {
      out.push({ lat: p0.lat, lon: p0.lon });
      continue;
    }

    const t = (target - d0) / (d1 - d0);
    out.push({ lat: lerp(p0.lat, p1.lat, t), lon: lerp(p0.lon, p1.lon, t) });
  }

  // Dedupe consecutive points that are extremely close (prevents NREL spam).
  const deduped: LatLng[] = [];
  for (const p of out) {
    const prev = deduped[deduped.length - 1];
    if (!prev) {
      deduped.push(p);
      continue;
    }
    const d = haversineMiles(prev, p);
    if (d < 0.05) continue; // < ~0.05 miles
    deduped.push(p);
  }
  return deduped;
}

