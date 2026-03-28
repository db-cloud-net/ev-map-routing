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

/** Per-segment second horizons (ROUTING_UX_SPEC §5 prefetch), merged for multi-hop previews. */
export function mergeSecondHorizons(
  ok: RoutePreviewApiResponse[],
  segmentPairs: Array<[string, string]>
): RoutePreviewHorizon | null {
  const maneuvers: NonNullable<ItineraryLeg["maneuvers"]> = [];
  let cumulativeTimeSeconds = 0;
  let maxMinutesSum = 0;
  let any = false;

  for (let i = 0; i < ok.length; i++) {
    const nh = ok[i].preview?.nextHorizon;
    if (!nh?.maneuvers?.length) continue;
    any = true;
    maxMinutesSum += nh.maxMinutes;
    const [from, to] = segmentPairs[i];
    maneuvers.push({
      text: `Segment ${i + 1} (next horizon): ${from} → ${to}`,
      instructionType: "segment_heading"
    });
    for (const m of nh.maneuvers) {
      maneuvers.push({ ...m });
      cumulativeTimeSeconds += typeof m.timeSeconds === "number" ? m.timeSeconds : 0;
    }
  }

  if (!any) return null;
  return {
    maxMinutes: maxMinutesSum,
    maneuvers,
    cumulativeTimeSeconds
  };
}

/**
 * Merge successful per-hop `POST /route-preview` responses (same order as `pairs`).
 * `totalSegments` — when set and `ok.length < totalSegments`, adds `partialPreviewMeta` for UI.
 */
export function mergeRoutePreviewResponses(
  ok: RoutePreviewApiResponse[],
  pairs: Array<[string, string]>,
  totalSegments?: number
): RoutePreviewApiResponse | null {
  if (ok.length === 0 || ok.length !== pairs.length) return null;

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
  const nextHorizonMerged = mergeSecondHorizons(ok, pairs);

  const partialPreviewMeta =
    totalSegments != null && ok.length < totalSegments
      ? { loadedSegments: ok.length, totalSegments }
      : undefined;

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
      horizon,
      ...(nextHorizonMerged ? { nextHorizon: nextHorizonMerged } : {}),
      ...(partialPreviewMeta ? { partialPreviewMeta } : {})
    }
  };

  return merged;
}

/**
 * One or more parallel `POST /route-preview` calls (v1 is single-leg only); merges polylines for map + TBT.
 * As each **contiguous prefix** of hops completes (hop 0, then 0–1, …), invokes `onPartial` so the map can show the
 * first segment without waiting for every waypoint hop (multi-waypoint trips).
 * Returns `null` if any segment fails or response is invalid (caller may already have partials via `onPartial`).
 */
export async function fetchMergedRoutePreview(
  apiBase: string,
  segmentEndpoints: string[],
  signal?: AbortSignal | null,
  onPartial?: (merged: RoutePreviewApiResponse) => void
): Promise<RoutePreviewApiResponse | null> {
  if (segmentEndpoints.length < 2) return null;
  const base = apiBase.replace(/\/$/, "");
  const url = `${base}/route-preview`;

  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < segmentEndpoints.length - 1; i++) {
    pairs.push([segmentEndpoints[i], segmentEndpoints[i + 1]]);
  }

  const n = pairs.length;
  const results: Array<RoutePreviewApiResponse | null> = new Array(n).fill(null);
  let emittedPrefix = 0;

  const tryEmitPrefix = () => {
    let k = 0;
    while (k < n && results[k] != null) k++;
    if (k === 0 || k === emittedPrefix) return;
    const prefixOk = results.slice(0, k) as RoutePreviewApiResponse[];
    const merged = mergeRoutePreviewResponses(prefixOk, pairs.slice(0, k), n);
    if (merged) {
      emittedPrefix = k;
      onPartial?.(merged);
    }
  };

  await Promise.all(
    pairs.map(async ([segStart, segEnd], i) => {
      try {
        /** First hop: no shared abort — show first segment ASAP; later hops still respect `signal` (timeout). */
        const hopSignal = i > 0 ? signal : undefined;
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ start: segStart, end: segEnd }),
          ...(hopSignal ? { signal: hopSignal } : {})
        });
        const j = (await r.json().catch(() => null)) as RoutePreviewApiResponse | null;
        if (!r.ok || !j || j.status !== "ok" || !j.preview?.polyline?.coordinates?.length) {
          results[i] = null;
        } else if (j.preview.polyline.coordinates.length < 2) {
          results[i] = null;
        } else {
          results[i] = j;
        }
      } catch {
        results[i] = null;
      }
      tryEmitPrefix();
    })
  );

  if (results.some((x) => x === null)) return null;
  const ok = results as RoutePreviewApiResponse[];
  return mergeRoutePreviewResponses(ok, pairs, n);
}
