import type { ItineraryLeg, RoutePreviewApiResponse, RoutePreviewHorizon } from "../../../shared/types";

function nearlySamePoint(a: number[], b: number[], eps = 1e-5): boolean {
  return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
}

/** Concatenate GeoJSON LineString coordinate arrays; de-dupe shared endpoints between segments. */
export function concatenateLineStringCoordinates(segments: number[][][]): [number, number][] {
  const out: [number, number][] = [];
  for (const seg of segments) {
    let startIdx = 0;
    if (out.length >= 1 && seg.length >= 1) {
      const last = out[out.length - 1];
      const first = seg[0];
      if (nearlySamePoint(last, first)) startIdx = 1;
    }
    for (let i = startIdx; i < seg.length; i++) {
      const p = seg[i];
      if (p.length >= 2) out.push([p[0], p[1]]);
    }
  }
  return out;
}

/**
 * Ordered place labels (same strings sent to `/plan`): start, optional waypoints, end.
 * Minimum length 2 (start + end only).
 */
export function routePreviewSegmentChain(start: string, waypoints: string[], end: string): string[] {
  const s = start.trim();
  const e = end.trim();
  const wps = waypoints.map((w) => w.trim()).filter(Boolean);
  return [s, ...wps, e].filter((x) => x.length > 0);
}

/** Concatenate per-segment horizon clips so TBT lists every hop (not only the first segment). */
export function mergeRoutePreviewHorizons(
  ok: RoutePreviewApiResponse[],
  segmentPairs: Array<[string, string]>
): RoutePreviewHorizon {
  if (ok.length === 0) {
    return { maxMinutes: 0, maneuvers: [], cumulativeTimeSeconds: 0 };
  }
  if (ok.length === 1) {
    return ok[0].preview!.horizon;
  }

  const maneuvers: NonNullable<ItineraryLeg["maneuvers"]> = [];
  let cumulativeTimeSeconds = 0;
  let maxMinutesSum = 0;

  for (let i = 0; i < ok.length; i++) {
    const h = ok[i].preview!.horizon;
    maxMinutesSum += h.maxMinutes;
    const [from, to] = segmentPairs[i];
    maneuvers.push({
      text: `Segment ${i + 1}: ${from} → ${to}`,
      instructionType: "segment_heading"
    });
    for (const m of h.maneuvers) {
      maneuvers.push({ ...m });
      cumulativeTimeSeconds += typeof m.timeSeconds === "number" ? m.timeSeconds : 0;
    }
  }

  return {
    maxMinutes: maxMinutesSum,
    maneuvers,
    cumulativeTimeSeconds
  };
}

/**
 * One or more parallel `POST /route-preview` calls (v1 is single-leg only); merges polylines for map + TBT.
 * Returns `null` if any segment fails or response is invalid.
 */
export async function fetchMergedRoutePreview(
  apiBase: string,
  segmentEndpoints: string[],
  signal?: AbortSignal | null
): Promise<RoutePreviewApiResponse | null> {
  if (segmentEndpoints.length < 2) return null;
  const base = apiBase.replace(/\/$/, "");
  const url = `${base}/route-preview`;

  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < segmentEndpoints.length - 1; i++) {
    pairs.push([segmentEndpoints[i], segmentEndpoints[i + 1]]);
  }

  const results = await Promise.all(
    pairs.map(async ([segStart, segEnd]) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: segStart, end: segEnd }),
        ...(signal ? { signal } : {})
      });
      const j = (await r.json().catch(() => null)) as RoutePreviewApiResponse | null;
      if (!r.ok || !j || j.status !== "ok" || !j.preview?.polyline?.coordinates?.length) return null;
      if (j.preview.polyline.coordinates.length < 2) return null;
      return j;
    })
  );

  if (results.some((x) => x === null)) return null;
  const ok = results as RoutePreviewApiResponse[];

  const coordSegments = ok.map((r) => r.preview!.polyline.coordinates as number[][]);
  const mergedCoords = concatenateLineStringCoordinates(coordSegments);
  if (mergedCoords.length < 2) return null;

  let tripTimeMinutes = 0;
  let tripDistanceMiles = 0;
  for (const r of ok) {
    tripTimeMinutes += r.preview!.tripTimeMinutes;
    tripDistanceMiles += r.preview!.tripDistanceMiles;
  }

  const horizon = mergeRoutePreviewHorizons(ok, pairs);

  const merged: RoutePreviewApiResponse = {
    requestId: ok.map((r) => r.requestId).join("+"),
    responseVersion: "v2-1-route-preview",
    status: "ok",
    preview: {
      polyline: {
        type: "LineString",
        coordinates: mergedCoords
      },
      tripTimeMinutes,
      tripDistanceMiles,
      horizon
    }
  };

  return merged;
}
