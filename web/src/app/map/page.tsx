"use client";

import React, { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type {
  CandidatesApiResponse,
  ItineraryLeg,
  ItineraryStop,
  PlanTripCandidates,
  PlanTripResponse,
  RangeLegSummary,
  RoutePreviewApiResponse
} from "../../../../shared/types";
import {
  concatenateLineStringCoordinates,
  fetchMergedRoutePreview,
  routePreviewSegmentChain
} from "../../lib/mergeRoutePreview";
import {
  buildRangeLegRouteFeatureCollection,
  RANGE_LEG_LAYER_COUNT
} from "../../lib/rangeLegRouteFeatures";

/** Abort merged `/route-preview` fetches so `routePreviewPending` cannot stick forever (no blue line / chord). */
function abortSignalAfterMs(ms: number): AbortSignal | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

const LEGACY_TIMEOUT_MS = 130_000;
/** Baked builds often had 180s; long multi-stop `/plan` needs more headroom. */
const LEGACY_PLAN_CLIENT_MS_180 = 180_000;
/** Default client caps: 5m plan, 5m merged route-preview (multi-hop can be heavy). */
const DEFAULT_PLAN_CLIENT_MS = 300_000;
const DEFAULT_ROUTE_PREVIEW_CLIENT_MS = 300_000;

const COLORS = {
  roadBlue: "#0b7cff",
  dcfcTeal: "#39a6a1",
  l2Teal: "#7fd8d4",
  hotelLightOrange: "#f6ad55",
  hotelDarkOrange: "#c05621",
  /** Sleep stop with charger at / near the hotel. */
  sleepDarkRed: "#c53030",
  /** Sleep stop with no charger nearby — bright blue diamond on the map. */
  sleepHotelBrightBlue: "#1e90ff"
} as const;

/**
 * Itinerary sleep (hotel) stops use a diamond, not the default teardrop pin.
 * MapLibre sets `transform` on the marker root for map positioning — rotation must live on an inner node
 * or it is overwritten and the pin reads as an axis-aligned square.
 */
function sleepStopMarkerElement(hasChargerNearby: boolean): HTMLDivElement {
  const root = document.createElement("div");
  root.style.display = "flex";
  root.style.alignItems = "center";
  root.style.justifyContent = "center";
  root.style.width = "20px";
  root.style.height = "20px";
  root.style.pointerEvents = "auto";
  const inner = document.createElement("div");
  const n = 14;
  inner.style.width = `${n}px`;
  inner.style.height = `${n}px`;
  inner.style.background = hasChargerNearby ? COLORS.sleepDarkRed : COLORS.sleepHotelBrightBlue;
  inner.style.transform = "rotate(45deg)";
  inner.style.border = "2px solid rgba(255, 255, 255, 0.92)";
  inner.style.boxShadow = "0 1px 4px rgba(0, 0, 0, 0.35)";
  inner.style.borderRadius = "2px";
  inner.style.boxSizing = "border-box";
  inner.style.flexShrink = "0";
  root.appendChild(inner);
  return root;
}

function poiCandidateMarkerElement(selected: boolean, color: string): HTMLDivElement {
  const root = document.createElement("div");
  root.style.display = "flex";
  root.style.alignItems = "center";
  root.style.justifyContent = "center";
  root.style.width = "18px";
  root.style.height = "18px";
  root.style.borderRadius = "50%";
  root.style.background = color;
  root.style.border = selected ? "2px solid #111" : "2px solid rgba(255,255,255,0.9)";
  root.style.boxShadow = selected ? "0 0 0 2px rgba(0,0,0,0.15)" : "0 0 0 1px rgba(0,0,0,0.15)";
  root.style.cursor = "pointer";
  return root;
}

function toNumberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function hasFiniteCoords(v: { lat?: unknown; lon?: unknown } | null | undefined): v is {
  lat: number | string;
  lon: number | string;
} {
  if (v == null) return false;
  const lat = toNumberOrNull(v.lat);
  const lon = toNumberOrNull(v.lon);
  return lat != null && lon != null;
}

function isLikelyPoiStop(stop: ItineraryStop): boolean {
  if (typeof stop.id === "string" && stop.id.startsWith("poi_services:")) return true;
  const meta = (stop.meta ?? {}) as Record<string, unknown>;
  const sleepSrc = meta.sleepChargerSource;
  if (typeof sleepSrc === "string" && sleepSrc.startsWith("poi_")) return true;
  return false;
}

function haversineMiles(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 3958.7613;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const y = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return R * y;
}

function isLikelyL2Power(maxPowerKw: number | null): boolean {
  return maxPowerKw != null && maxPowerKw > 0 && maxPowerKw < 50;
}

/**
 * Next inlines `NEXT_PUBLIC_*` at build time. Legacy values (130s, 180s) map to
 * the current default so long `/plan` runs are not cut off unless env is set otherwise.
 */
function resolvePublicClientTimeoutMs(raw: string | undefined, fallbackMs: number): number {
  if (raw === undefined || raw === "") return fallbackMs;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallbackMs;
  if (n === LEGACY_TIMEOUT_MS || n === LEGACY_PLAN_CLIENT_MS_180) return fallbackMs;
  return n;
}

function planClientTimeoutMs(): number {
  return resolvePublicClientTimeoutMs(process.env.NEXT_PUBLIC_PLAN_CLIENT_TIMEOUT_MS, DEFAULT_PLAN_CLIENT_MS);
}

function routePreviewClientTimeoutMs(): number {
  return resolvePublicClientTimeoutMs(
    process.env.NEXT_PUBLIC_ROUTE_PREVIEW_CLIENT_TIMEOUT_MS,
    DEFAULT_ROUTE_PREVIEW_CLIENT_MS
  );
}

/** When true, `POST /plan` uses `planJob: true` and the UI streams `GET /plan/jobs/:id/events` (SSE) by default, or polls `GET /plan/jobs/:id` when `NEXT_PUBLIC_PLAN_USE_SSE=false`. */
function planUseJob(): boolean {
  const raw = (process.env.NEXT_PUBLIC_PLAN_USE_JOB ?? "").trim().toLowerCase();
  // Default-on for progressive planning UX; explicit false disables.
  if (raw === "false") return false;
  return true;
}

/**
 * When true (default), async plan jobs use `GET /plan/jobs/:id/events` (Server-Sent Events) for checkpoints.
 * Set `NEXT_PUBLIC_PLAN_USE_SSE=false` to use polling only (`GET /plan/jobs/:id` every 250ms).
 */
function planJobUseSse(): boolean {
  const raw = (process.env.NEXT_PUBLIC_PLAN_USE_SSE ?? "").trim().toLowerCase();
  if (raw === "false") return false;
  return true;
}

/** Transient SSE disconnects: exponential backoff before a new EventSource (server replays checkpoints). */
const PLAN_JOB_SSE_MAX_RECONNECTS = 8;
function planJobSseReconnectDelayMs(attemptOneBased: number): number {
  return Math.min(30_000, 1_000 * 2 ** (attemptOneBased - 1));
}

function resolvePlanJobEventsUrl(apiBase: string, jobId: string, eventsUrl?: string): string {
  const base = apiBase.replace(/\/$/, "");
  const path =
    typeof eventsUrl === "string" && eventsUrl.startsWith("/") ? eventsUrl : `/plan/jobs/${jobId}/events`;
  return `${base}${path}`;
}

function isProdLikeBuild(): boolean {
  return (process.env.NODE_ENV ?? "").trim().toLowerCase() === "production";
}

function readPublicBool(raw: string | undefined): boolean | null {
  if (raw == null) return null;
  const v = raw.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

function mapShowCandidatesDefault(): boolean {
  const override = readPublicBool(process.env.NEXT_PUBLIC_MAP_SHOW_CANDIDATES_DEFAULT);
  if (override != null) return override;
  return !isProdLikeBuild();
}

function mapShowWaypointsDefault(): boolean {
  const override = readPublicBool(process.env.NEXT_PUBLIC_MAP_SHOW_WAYPOINTS_DEFAULT);
  if (override != null) return override;
  return !isProdLikeBuild();
}

/**
 * When true, the map may split the road polyline by presentation `rangeLegs` and show the **Range legs (debug)**
 * sidebar panel. Standard product keeps a single blue route line and omits that panel — set in `web/.env.local`.
 */
function mapDebugRangeLegs(): boolean {
  return (process.env.NEXT_PUBLIC_MAP_DEBUG_RANGE_LEGS ?? "").trim().toLowerCase() === "true";
}

/** Count LineString coordinates across legs (Valhalla routes are dense; chord-only legs stay tiny). */
function countLegLineStringCoordinates(legs: ItineraryLeg[] | undefined): number {
  let n = 0;
  for (const leg of legs ?? []) {
    if (leg.geometry?.type === "LineString" && Array.isArray(leg.geometry.coordinates)) {
      n += leg.geometry.coordinates.length;
    }
  }
  return n;
}

/**
 * Pillar 3b: when `planJob` partial snapshots include enough merged per-leg geometry, prefer that solid line over
 * merged `/route-preview` (which can disagree with the latest partial stops) and hide the dashed preview.
 */
const PARTIAL_PLAN_ROAD_GEOMETRY_MIN_COORDS = 20;

function partialSnapshotLegGeometryDrivesSolidLine(
  legs: ItineraryLeg[] | undefined,
  loading: boolean,
  planJobPartialRoute: boolean
): boolean {
  if (!planJobPartialRoute || !loading) return false;
  return countLegLineStringCoordinates(legs) >= PARTIAL_PLAN_ROAD_GEOMETRY_MIN_COORDS;
}

function formatElapsedMmSs(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Geographic anchors only (start → waypoints → end), in visit order — matches merged `/route-preview` hops. */
function geographicAnchorsFromStops(stops: ItineraryStop[]): ItineraryStop[] {
  return stops.filter((s) => s.type === "start" || s.type === "waypoint" || s.type === "end");
}

/**
 * When merged route-preview is **partial** (later hops timed out or failed), `partialPreviewMeta` marks
 * `loadedSegments < totalSegments`. The polyline only covers the first hop(s); append straight
 * connectors for remaining geographic anchors so the map shows the full corridor (planner legs
 * usually have no road geometry yet).
 */
function extendPartialPreviewPolyline(
  coordinates: number[][],
  previewPartial: { loadedSegments: number; totalSegments: number },
  anchors: ItineraryStop[]
): [number, number][] {
  const { loadedSegments, totalSegments } = previewPartial;
  if (loadedSegments >= totalSegments || anchors.length < totalSegments + 1) {
    return coordinates as [number, number][];
  }
  const segments: number[][][] = [];
  segments.push(coordinates);
  for (let h = loadedSegments; h < totalSegments; h++) {
    const a = anchors[h];
    const b = anchors[h + 1];
    segments.push([
      [a.coords.lon, a.coords.lat],
      [b.coords.lon, b.coords.lat]
    ]);
  }
  return concatenateLineStringCoordinates(segments);
}

/** Progressive UX: `planJob` checkpoints may include `partialSnapshot` before the final `result`. */
function planTripResponseFromPartialSnapshot(
  accepted: { requestId?: string; jobId?: string; responseVersion?: string },
  snapshot: { stops: ItineraryStop[]; legs: ItineraryLeg[]; rangeLegs?: RangeLegSummary[] }
): PlanTripResponse {
  return {
    requestId: accepted.requestId ?? accepted.jobId ?? "plan-job",
    responseVersion: accepted.responseVersion ?? "v2-1",
    status: "ok",
    message: "Planning…",
    stops: snapshot.stops,
    legs: snapshot.legs,
    rangeLegs: snapshot.rangeLegs,
    debug: { planJobPartialRoute: true }
  };
}

type PlanJobCheckpointRow = {
  t?: number | string;
  legIndex: number;
  attempt: Record<string, unknown>;
};

function countSegmentPrefixRefinementRows(rows: PlanJobCheckpointRow[]): number {
  let n = 0;
  for (const r of rows) {
    const a = r.attempt;
    if (!a || typeof a !== "object") continue;
    if ((a as { kind?: string }).kind !== "partial_route") continue;
    const ref = (a as { refinement?: { kind?: string } }).refinement;
    if (ref?.kind === "segment_prefix") n += 1;
  }
  return n;
}

/** Shared by SSE and poll: map checkpoint rows → progressive partial plan + per-leg solver debug rows. */
function applyPlanJobCheckpointRows(
  checkpoints: PlanJobCheckpointRow[],
  accepted: { jobId?: string; requestId?: string; responseVersion?: string },
  progressiveBestStops: number,
  setPlan: Dispatch<SetStateAction<PlanTripResponse | null>>,
  setJobLiveSolverLegs: Dispatch<SetStateAction<unknown[][] | null>>
): { progressiveBestStops: number } {
  const byLeg = new Map<number, unknown[]>();
  let bestPartialThisPoll: PlanTripResponse | null = null;
  let bestStopsThisPoll = progressiveBestStops;
  for (const c of checkpoints) {
    const att = c.attempt;
    if (
      att &&
      typeof att === "object" &&
      (att as { kind?: string }).kind === "partial_route"
    ) {
      const reason = (att as { reason?: string }).reason;
      if (reason === "quick_first_segment_estimate" && (c.legIndex ?? 0) > 0) {
        continue;
      }
      const ps = (att as { partialSnapshot?: unknown }).partialSnapshot;
      if (ps && typeof ps === "object") {
        const p = ps as {
          stops?: ItineraryStop[];
          legs?: ItineraryLeg[];
          rangeLegs?: RangeLegSummary[];
        };
        if (Array.isArray(p.stops) && Array.isArray(p.legs)) {
          if (p.stops.length > progressiveBestStops && p.stops.length >= bestStopsThisPoll) {
            bestStopsThisPoll = p.stops.length;
            bestPartialThisPoll = planTripResponseFromPartialSnapshot(accepted, {
              stops: p.stops,
              legs: p.legs,
              rangeLegs: Array.isArray(p.rangeLegs) ? p.rangeLegs : undefined
            });
          }
        }
      }
      continue;
    }
    const li = typeof c.legIndex === "number" ? c.legIndex : 0;
    if (!byLeg.has(li)) byLeg.set(li, []);
    byLeg.get(li)!.push(c.attempt);
  }
  let nextProgressive = progressiveBestStops;
  if (bestPartialThisPoll) {
    nextProgressive = bestStopsThisPoll;
    setPlan(bestPartialThisPoll);
  }
  const maxLeg = Math.max(0, ...Array.from(byLeg.keys()));
  const legs: unknown[][] = [];
  for (let i = 0; i <= maxLeg; i++) {
    legs.push(byLeg.get(i) ?? []);
  }
  setJobLiveSolverLegs(legs);
  return { progressiveBestStops: nextProgressive };
}

type RefinementStage = "skipped" | "pending" | "active" | "done" | "error" | "idle";

function refinementStageStyle(s: RefinementStage): { glyph: string; color: string } {
  switch (s) {
    case "done":
      return { glyph: "✓", color: "#15803d" };
    case "error":
      return { glyph: "✗", color: "#b91c1c" };
    case "skipped":
      return { glyph: "—", color: "#9ca3af" };
    case "active":
      return { glyph: "◐", color: "#0369a1" };
    case "idle":
      return { glyph: "○", color: "#d1d5db" };
    case "pending":
    default:
      return { glyph: "◔", color: "#78716c" };
  }
}

/**
 * Renders `debug.segmentsAttempted`-shaped rows (one least-time / overnight **solver attempt** per card).
 * - **Blocking `POST /plan`:** data arrives in one response; optional **stagger** reveals cards for readability.
 * - **Async `planJob`:** rows are built from **checkpoint** `attempt` payloads (SSE or poll); no stagger — the server already streams checkpoints.
 * A **checkpoint** is one `{ t, legIndex, attempt }` row from `GET /plan/jobs/...` (or SSE `type: "checkpoint"`). **`partial_route`** checkpoints update the itinerary elsewhere and are not listed here.
 */
const SOLVER_DEBUG_STAGGER_MS = 120;

function DebugSolverAttemptsList({
  segments,
  heading,
  requestId,
  staggerMs = SOLVER_DEBUG_STAGGER_MS,
  liveCheckpoints = false
}: {
  segments: unknown[];
  heading: string;
  requestId: string;
  staggerMs?: number;
  /** True when rows come from live plan-job checkpoints (show all cards immediately; no stagger). */
  liveCheckpoints?: boolean;
}) {
  const [visibleCount, setVisibleCount] = useState(0);

  useEffect(() => {
    if (!segments.length) {
      setVisibleCount(0);
      return;
    }
    if (liveCheckpoints || staggerMs <= 0) {
      setVisibleCount(segments.length);
      return;
    }
    setVisibleCount(1);
    if (segments.length <= 1) return;
    let n = 1;
    const id = window.setInterval(() => {
      n += 1;
      setVisibleCount(n);
      if (n >= segments.length) window.clearInterval(id);
    }, staggerMs);
    return () => window.clearInterval(id);
  }, [requestId, segments.length, staggerMs, liveCheckpoints]);

  if (!segments.length) return null;
  const visible = segments.slice(0, visibleCount);

  return (
    <div
      style={{
        marginBottom: 10,
        padding: 12,
        background: "#faf5ff",
        border: "1px solid #d8b4fe",
        borderRadius: 6,
        fontSize: 12,
        color: "#4c1d95"
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{heading}</div>
      <p style={{ margin: "0 0 8px 0", fontSize: 11, color: "#6b21a8", lineHeight: 1.45 }}>
        Each card is one <strong>solver attempt</strong> (least-time / overnight loop), not a fixed vehicle{" "}
        <strong>range leg</strong>.{" "}
        {liveCheckpoints ? (
          <>
            Source: <strong>checkpoints</strong> from{" "}
            {planJobUseSse() ? (
              <>
                <code>GET /plan/jobs/:id/events</code> (SSE)
              </>
            ) : (
              <>
                polling <code>GET /plan/jobs/:id</code>
              </>
            )}{" "}
            — each non–<code>partial_route</code> checkpoint contributes one row here (
            <code>NEXT_PUBLIC_PLAN_USE_JOB</code>
            {planJobUseSse() ? "" : "; set NEXT_PUBLIC_PLAN_USE_SSE=false to force poll"}).{" "}
            <strong>Partial</strong> checkpoints drive the itinerary above, not this list.
          </>
        ) : (
          <>
            Source: <code>debug.segmentsAttempted</code> in the <strong>finished</strong> blocking{" "}
            <code>POST /plan</code> body. This panel <strong>staggers</strong> cards (~{SOLVER_DEBUG_STAGGER_MS}ms) for
            readability — the browser already has the full array.
          </>
        )}{" "}
        See <code>docs/designs/range-based-segments-intent.md</code>.
      </p>
      {visible.map((raw, idx) => {
        const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        const ok = s.solverStatus === "ok";
        const label =
          s.kind === "remainder"
            ? "Remainder → end"
            : s.chainIndex != null && s.toKind != null
              ? `Chain ${String(s.chainIndex)} → ${String(s.toId)} (${String(s.toKind)})`
              : s.overnightIndex != null
                ? `Attempt ${idx + 1} (overnight ${String(s.overnightIndex)})`
                : `Attempt ${idx + 1}`;
        return (
          <details
            key={`${requestId}-att-${idx}`}
            style={{
              marginBottom: 8,
              padding: "6px 8px",
              background: "#fff",
              border: "1px solid #e9d5ff",
              borderRadius: 4
            }}
          >
            <summary style={{ cursor: "pointer", listStyle: "none" }}>
              <span style={{ fontFamily: "monospace", fontWeight: 600 }}>{label}</span>
              {" · "}
              <span style={{ color: ok ? "#15803d" : "#b91c1c" }}>{String(s.solverStatus ?? "—")}</span>
              {s.outcome != null ? <span style={{ color: "#6b21a8" }}> · {String(s.outcome)}</span> : null}
            </summary>
            <div style={{ marginTop: 8, fontSize: 11, lineHeight: 1.5 }}>
              {s.segmentStartId != null ? (
                <div>
                  <strong>start</strong>{" "}
                  <span style={{ fontFamily: "monospace" }}>{String(s.segmentStartId)}</span>
                </div>
              ) : null}
              {s.overnightIndex != null ? (
                <div>
                  <strong>overnightIndex</strong> {String(s.overnightIndex)}
                </div>
              ) : null}
              {typeof s.totalTimeMinutes === "number" ? (
                <div>
                  <strong>totalTime</strong> {Math.round(s.totalTimeMinutes)} min
                </div>
              ) : null}
              {typeof s.stopsCount === "number" ? (
                <div>
                  <strong>stops</strong> {s.stopsCount}
                  {typeof s.chargeStopsCount === "number" ? ` (charge ${s.chargeStopsCount})` : null}
                </div>
              ) : null}
              {typeof s.legsCount === "number" ? (
                <div>
                  <strong>legs</strong> {s.legsCount}
                </div>
              ) : null}
              {typeof s.chargersPoolCount === "number" ? (
                <div>
                  <strong>chargers pool</strong> {s.chargersPoolCount}
                </div>
              ) : null}
              {s.errorMessage != null ? (
                <div style={{ color: "#b91c1c", marginTop: 6 }}>{String(s.errorMessage)}</div>
              ) : null}
              <pre
                style={{
                  margin: "8px 0 0 0",
                  whiteSpace: "pre-wrap",
                  fontSize: 10,
                  padding: 8,
                  background: "#f5f3ff",
                  borderRadius: 4,
                  maxHeight: 220,
                  overflow: "auto"
                }}
              >
                {JSON.stringify(s, null, 2)}
              </pre>
            </div>
          </details>
        );
      })}
    </div>
  );
}

export default function MapPage() {
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const candidateMarkersRef = useRef<maplibregl.Marker[]>([]);
  const poiMarkersRef = useRef<maplibregl.Marker[]>([]);
  const autoFitConsumedRef = useRef(false);
  const [mapReady, setMapReady] = useState(false);

  /** F1: clear route + markers immediately on replan (before async state updates). */
  function clearMapPlanArtifacts() {
    const map = mapRef.current;
    if (!map) return;
    for (const m of markersRef.current) m.remove();
    markersRef.current = [];
    for (const m of candidateMarkersRef.current) m.remove();
    candidateMarkersRef.current = [];
    for (const m of poiMarkersRef.current) m.remove();
    poiMarkersRef.current = [];
    for (const lid of [
      "route-line",
      "route-line-halo",
      "route-preview-line",
      "route-preview-line-halo",
      "stops-fallback-circle",
      "stops-fallback-sleep",
      "candidates-fallback-chargers",
      "candidates-fallback-hotels",
      "poi-candidates-fallback"
    ]) {
      if (map.getLayer(lid)) map.removeLayer(lid);
    }
    if (map.getSource("route-geojson")) map.removeSource("route-geojson");
    if (map.getSource("route-preview-geojson")) map.removeSource("route-preview-geojson");
    if (map.getSource("stops-fallback-geojson")) map.removeSource("stops-fallback-geojson");
    if (map.getSource("candidates-fallback-geojson")) map.removeSource("candidates-fallback-geojson");
    if (map.getSource("poi-candidates-fallback-geojson")) map.removeSource("poi-candidates-fallback-geojson");
  }

  const [start, setStart] = useState("Raleigh, NC");
  const [end, setEnd] = useState("Seattle, WA");
  /** One destination per line (optional). Chained as ordered waypoints between start and end. */
  const [waypointsText, setWaypointsText] = useState("");
  const [optimizeWaypointOrder, setOptimizeWaypointOrder] = useState(
    () => (process.env.NEXT_PUBLIC_OPTIMIZE_WAYPOINT_ORDER ?? "true").toLowerCase() !== "false"
  );
  const defaultShowCandidates = mapShowCandidatesDefault();
  const defaultShowWaypoints = mapShowWaypointsDefault();
  const [showChargerCandidates, setShowChargerCandidates] = useState(defaultShowCandidates);
  const [showHotelCandidates, setShowHotelCandidates] = useState(defaultShowCandidates);
  const [loading, setLoading] = useState(false);
  /** Wall-clock seconds while `loading` — proves the tab is not frozen (ROUTING_UX_SPEC §6.5). */
  const [planElapsedSec, setPlanElapsedSec] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanTripResponse | null>(null);
  /** True while `GET /plan/jobs/…` is still running and the UI shows a checkpoint-only snapshot (ROUTING_UX_SPEC §6.6). */
  const isPartialPlanSnapshot = useMemo(
    () =>
      Boolean(
        plan &&
        plan.status === "ok" &&
        (plan.debug as Record<string, unknown> | undefined)?.planJobPartialRoute === true
      ),
    [plan]
  );
  /**
   * While an async plan job runs (`planJob: true`), checkpoint `attempt` rows per waypoint leg (leg index), for Debug.
   * Cleared when the final `result` is applied to `plan`.
   */
  const [jobLiveSolverLegs, setJobLiveSolverLegs] = useState<unknown[][] | null>(null);
  /** Request id shown for live job debug list (from 202 body or poll). */
  const [jobLiveRequestId, setJobLiveRequestId] = useState<string | null>(null);
  /** Pillar 3: server checkpoints received (SSE accumulator or latest poll length); cleared when the job ends. */
  const [planJobCheckpointCount, setPlanJobCheckpointCount] = useState<number | null>(null);
  /** §4 segment-hop refinements (`refinement.kind === "segment_prefix"`) seen in plan-job checkpoints. */
  const [segmentPrefixRefinementCount, setSegmentPrefixRefinementCount] = useState<number | null>(null);
  /** Slice 3: pins from `POST /candidates` before `/plan` completes (same id universe). */
  const [candidatePreview, setCandidatePreview] = useState<PlanTripCandidates | null>(null);
  const candidatesRequestGenRef = useRef(0);
  /** Slice 4: fast road line + horizon TBT from `POST /route-preview` (one call per hop; merged when waypoints). */
  const [routePreview, setRoutePreview] = useState<RoutePreviewApiResponse | null>(null);
  /** True while a single-leg `POST /route-preview` is in flight — suppress misleading chord lines until it settles. */
  const [routePreviewPending, setRoutePreviewPending] = useState(false);
  const routePreviewRequestGenRef = useRef(0);
  /** Per-leg ordered charger locks (Slice 1 UI: single-leg trips only; multi-leg rows stay empty). */
  const [lockedChargersByLeg, setLockedChargersByLeg] = useState<string[][]>([[]]);
  const [lockedHotelId, setLockedHotelId] = useState<string | null>(null);
  type PoiSelectMode = "off" | "all" | "charger" | "accommodation";
  type CorridorPoi = {
    id: string;
    poi_type: "accommodation" | "charger";
    name: string;
    lat: number;
    lon: number;
    address?: string;
    city?: string;
    state?: string;
    zip_code?: string;
    network?: string;
    distance_from_route_mi?: number;
    attributes: Record<string, string | number | boolean | undefined>;
  };
  const [poiMode, setPoiMode] = useState<PoiSelectMode>("off");
  const [poiNetwork, setPoiNetwork] = useState("");
  const [poiRadiusMi, setPoiRadiusMi] = useState("25");
  const [poiLimit, setPoiLimit] = useState("50");
  const [poiCandidates, setPoiCandidates] = useState<CorridorPoi[] | null>(null);
  const [poiSelection, setPoiSelection] = useState<Record<string, boolean>>({});
  const [poiFetching, setPoiFetching] = useState(false);
  const [poiError, setPoiError] = useState<string | null>(null);
  const prevPoiModeRef = useRef<PoiSelectMode>("off");
  /** Slice 2: mid-journey replan — omit `start`, use coords or a stop from the last plan. */
  const [replanMode, setReplanMode] = useState<"off" | "coords" | "stopId">("off");
  const [replanLat, setReplanLat] = useState("35.7796");
  const [replanLon, setReplanLon] = useState("-78.6382");
  const [replanStopId, setReplanStopId] = useState("");

  const parsedWaypoints = useMemo(
    () =>
      waypointsText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    [waypointsText]
  );
  const legCount = Math.max(1, parsedWaypoints.length + 1);
  const singleLegTrip = parsedWaypoints.length === 0;
  const showWaypointMarkers = defaultShowWaypoints;

  /** Slice 4 Phase 3: honest “what’s running” vs a flat “Planning…” (ROUTING_UX_SPEC §7). */
  const planningButtonLabel = useMemo(() => {
    if (!loading) return "Plan Trip";
    if (routePreviewPending) return "Road preview…";
    if (isPartialPlanSnapshot && plan && plan.stops.length > 0) {
      return `Itinerary (${plan.stops.length} stops)…`;
    }
    return "Planning trip…";
  }, [loading, routePreviewPending, isPartialPlanSnapshot, plan]);

  const planningLoadingHelp = useMemo(() => {
    if (!loading) return null;
    if (routePreviewPending) {
      return "Fetching Valhalla road preview (runs in parallel with the EV planner).";
    }
    if (isPartialPlanSnapshot && plan && plan.stops.length > 0) {
      return `Partial route from the server (${plan.stops.length} stops so far). The map and itinerary list update as checkpoints arrive; totals and full debug ship when the job completes.`;
    }
    if (planUseJob()) {
      return "EV least-time planner running (chargers, stops, times) — usually the slowest stage. With NEXT_PUBLIC_PLAN_USE_JOB, partial checkpoints update the map; Debug lists solver rows from each non-partial checkpoint as they arrive.";
    }
    return "EV least-time planner running (chargers, stops, times) — usually the slowest stage on long trips.";
  }, [loading, routePreviewPending, isPartialPlanSnapshot, plan]);

  useEffect(() => {
    if (!loading) {
      setPlanElapsedSec(0);
      return;
    }
    const t0 = Date.now();
    const id = window.setInterval(() => {
      setPlanElapsedSec(Math.floor((Date.now() - t0) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [loading]);

  /** ROUTING_UX_SPEC §4 — staged refinement (MVP: honest pipeline, not server-side loops). */
  const prefetchCandidatesEnv = useMemo(
    () => (process.env.NEXT_PUBLIC_PREFETCH_CANDIDATES ?? "true").toLowerCase() !== "false",
    []
  );
  const prefetchRoutePreviewEnv = useMemo(
    () => (process.env.NEXT_PUBLIC_PREFETCH_ROUTE_PREVIEW ?? "true").toLowerCase() !== "false",
    []
  );
  const previewChainForRefinement = useMemo(
    () => (replanMode === "off" ? routePreviewSegmentChain(start, parsedWaypoints, end) : []),
    [replanMode, start, parsedWaypoints, end]
  );
  const roadPreviewEnabled = previewChainForRefinement.length >= 2 && prefetchRoutePreviewEnv;

  const hasPlanActivity = Boolean(
    loading || plan !== null || routePreview !== null || candidatePreview !== null || error !== null
  );

  /** Latest single-leg lock row + hotel for backup when entering multi-waypoint mode. */
  const locksSnapshotRef = useRef<{ chargers: string[]; hotel: string | null }>({
    chargers: [],
    hotel: null
  });
  locksSnapshotRef.current = {
    chargers: lockedChargersByLeg[0] ?? [],
    hotel: lockedHotelId
  };
  /** Restored when waypoints are cleared back to a single driving segment. */
  const singleLegLocksBackupRef = useRef<{ chargers: string[]; hotel: string | null } | null>(null);
  const prevWaypointCountRef = useRef(parsedWaypoints.length);

  // `NEXT_PUBLIC_API_BASE` is optional; default to current host for WSL/Windows cross-host dev.
  const apiBase = useMemo(
    () => {
      const fromEnv = process.env.NEXT_PUBLIC_API_BASE?.trim();
      if (fromEnv) return fromEnv;
      if (typeof window !== "undefined") return `http://${window.location.hostname}:3001`;
      return "http://localhost:3001";
    },
    []
  );

  useEffect(() => {
    if (!mapEl.current) return;
    if (mapRef.current) return;

    // Basemap with readable city/highway labels.
    const styleUrl = "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json";
    const map = new maplibregl.Map({
      container: mapEl.current,
      style: styleUrl,
      center: [-97.0, 38.0],
      zoom: 3
    });

    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.once("load", () => {
      map.resize();
      setMapReady(true);
    });
    map.on("styledata", () => {
      if (map.isStyleLoaded()) setMapReady(true);
    });
    mapRef.current = map;
  }, []);

  /**
   * Locks are only clickable for a single driving segment (no waypoints).
   * When the user adds waypoints we stash prior single-leg locks and clear rows; when they clear
   * waypoints we restore the stash so they don't have to re-lock from scratch.
   */
  useEffect(() => {
    const n = parsedWaypoints.length;
    const prev = prevWaypointCountRef.current;
    prevWaypointCountRef.current = n;

    if (prev === n) return;

    if (prev === 0 && n > 0) {
      const snap = locksSnapshotRef.current;
      if (snap.chargers.length || snap.hotel) {
        singleLegLocksBackupRef.current = {
          chargers: [...snap.chargers],
          hotel: snap.hotel
        };
      } else {
        singleLegLocksBackupRef.current = null;
      }
      setLockedChargersByLeg(Array.from({ length: n + 1 }, () => []));
      setLockedHotelId(null);
    } else if (prev > 0 && n === 0) {
      const b = singleLegLocksBackupRef.current;
      singleLegLocksBackupRef.current = null;
      if (b) {
        setLockedChargersByLeg([b.chargers]);
        setLockedHotelId(b.hotel);
      } else {
        setLockedChargersByLeg([[]]);
      }
    } else if (n > 0 && prev > 0) {
      setLockedChargersByLeg(Array.from({ length: n + 1 }, () => []));
      setLockedHotelId(null);
    }
  }, [parsedWaypoints.length]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Teal route-preview layers are managed in the next effect only. Do not
    // clear them here: this effect also depends on routePreviewPending, and
    // clearing preview layers without a routePreview dep change would erase
    // the dashed line when preview fetch finishes.

    // Clear previous visualization layers (including legacy per–range-leg `route-line-0`…).
    const layersToRemove = ["route-line", "route-line-halo", "stops-fallback-circle", "stops-fallback-sleep"];
    for (let i = 0; i < RANGE_LEG_LAYER_COUNT; i++) {
      layersToRemove.push(`route-line-${i}`);
    }
    for (const lid of layersToRemove) {
      if (map.getLayer(lid)) map.removeLayer(lid);
    }
    const sourcesToRemove = ["route-geojson", "stops-fallback-geojson"];
    for (const sid of sourcesToRemove) {
      if (map.getSource(sid)) map.removeSource(sid);
    }

    if (!plan) {
      return;
    }

    if (plan.stops.length === 0) {
      return;
    }

    // Route geometry.
    // For normal trips (replan off) prefer merged `POST /route-preview` polylines over any per-leg geometry —
    // solver legs may carry straight chord LineStrings that would incorrectly win here.
    const previewPoly =
      routePreview?.status === "ok" && routePreview.preview?.polyline?.coordinates?.length
        ? routePreview.preview.polyline
        : null;
    const preferPreviewPolyline =
      replanMode === "off" && previewPoly && previewPoly.coordinates.length >= 2;

    const planJobPartialRoute = Boolean(
      (plan.debug as Record<string, unknown> | undefined)?.planJobPartialRoute === true
    );

    const linePoints: Array<[number, number]> = [];
    for (const leg of plan.legs ?? []) {
      if (leg.geometry?.type === "LineString" && Array.isArray(leg.geometry.coordinates)) {
        for (const c of leg.geometry.coordinates) {
          linePoints.push([c[0], c[1]]);
        }
      }
    }

    const partialLegRoadGeometryFirst =
      plan.status === "ok" &&
      partialSnapshotLegGeometryDrivesSolidLine(plan.legs, loading, planJobPartialRoute) &&
      linePoints.length >= 2;

    /**
     * Blocking `POST /plan`: avoid a flash of straight chords while merged `/route-preview` is loading.
     * Async `planJob` + poll: `loading` stays true for minutes while partial plans stream — still show chord
     * so the corridor is visible before preview polyline arrives (range-leg polyline split is debug-only).
     */
    const suppressChordUntilPreview =
      replanMode === "off" &&
      routePreviewPending &&
      !previewPoly &&
      !(loading && plan.status === "ok");

    let routeCoords: Array<[number, number]> = [];
    if (preferPreviewPolyline && previewPoly && !partialLegRoadGeometryFirst) {
      const pm = routePreview?.preview?.partialPreviewMeta;
      if (
        pm &&
        pm.loadedSegments < pm.totalSegments &&
        plan.status === "ok"
      ) {
        const anchors = geographicAnchorsFromStops(plan.stops);
        if (anchors.length === pm.totalSegments + 1) {
          routeCoords = extendPartialPreviewPolyline(
            previewPoly.coordinates as number[][],
            pm,
            anchors
          );
        } else {
          routeCoords = previewPoly.coordinates as Array<[number, number]>;
        }
      } else {
        routeCoords = previewPoly.coordinates as Array<[number, number]>;
      }
    } else if (partialLegRoadGeometryFirst) {
      routeCoords = linePoints;
    } else if (suppressChordUntilPreview) {
      routeCoords = [];
    } else if (linePoints.length >= 2) {
      routeCoords = linePoints;
    } else if (previewPoly && previewPoly.coordinates.length >= 2) {
      routeCoords = previewPoly.coordinates as Array<[number, number]>;
    } else {
      const chord = plan.stops.map((s) => [s.coords.lon, s.coords.lat] as [number, number]);
      if (chord.length >= 2) routeCoords = chord;
    }

    const rangeLegFc =
      mapDebugRangeLegs() &&
        plan.status === "ok" &&
        plan.rangeLegs &&
        plan.rangeLegs.length > 0
        ? buildRangeLegRouteFeatureCollection(plan, routeCoords, plan.rangeLegs)
        : null;

    if (routeCoords.length >= 2) {
      if (rangeLegFc && rangeLegFc.features.length > 0) {
        map.addSource("route-geojson", {
          type: "geojson",
          data: rangeLegFc
        });

        map.addLayer({
          id: "route-line-halo",
          type: "line",
          source: "route-geojson",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#000000", "line-width": 10, "line-opacity": 0.22 }
        });
        map.addLayer({
          id: "route-line",
          type: "line",
          source: "route-geojson",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": COLORS.roadBlue, "line-width": 5 }
        });
      } else {
        map.addSource("route-geojson", {
          type: "geojson",
          data: {
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              coordinates: routeCoords
            }
          }
        });

        map.addLayer({
          id: "route-line-halo",
          type: "line",
          source: "route-geojson",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#000000", "line-width": 10, "line-opacity": 0.22 }
        });
        map.addLayer({
          id: "route-line",
          type: "line",
          source: "route-geojson",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": COLORS.roadBlue, "line-width": 5 }
        });
      }
    }

    // Guaranteed-on path for stop rendering: ties stop symbols to the same effect that draws route layers.
    const drawableStopsForLayer = plan.stops.filter(
      (s) => hasFiniteCoords(s.coords) && (s.type !== "waypoint" || showWaypointMarkers)
    );
    if (drawableStopsForLayer.length > 0) {
      const stopFeatures = drawableStopsForLayer.map((s) => {
        const stopMeta = (s.meta ?? {}) as Record<string, unknown>;
        const stopPowerKw = toNumberOrNull(
          stopMeta.chargerMaxPowerKw ?? stopMeta.maxPowerKw
        );
        const sleepHasCharger = Boolean(stopMeta.chargerFound);
        const color =
          s.type === "start"
            ? "#1b6ef3"
            : s.type === "end"
              ? "#9b59b6"
              : s.type === "waypoint"
                ? "#6c5ce7"
                : s.type === "sleep"
                  ? sleepHasCharger
                    ? COLORS.sleepDarkRed
                    : COLORS.sleepHotelBrightBlue
                  : isLikelyL2Power(stopPowerKw)
                    ? COLORS.l2Teal
                    : COLORS.dcfcTeal;
        return {
          type: "Feature" as const,
          properties: { stopType: s.type, color },
          geometry: {
            type: "Point" as const,
            coordinates: [Number(s.coords.lon), Number(s.coords.lat)] as [number, number]
          }
        };
      });
      map.addSource("stops-fallback-geojson", {
        type: "geojson",
        data: { type: "FeatureCollection", features: stopFeatures }
      });
      map.addLayer({
        id: "stops-fallback-circle",
        type: "circle",
        source: "stops-fallback-geojson",
        filter: ["!=", ["get", "stopType"], "sleep"],
        paint: {
          "circle-radius": 6,
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.2
        }
      });
      map.addLayer({
        id: "stops-fallback-sleep",
        type: "symbol",
        source: "stops-fallback-geojson",
        filter: ["==", ["get", "stopType"], "sleep"],
        layout: {
          "text-field": "◆",
          "text-size": 16,
          "text-allow-overlap": true
        },
        paint: {
          "text-color": ["get", "color"],
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.1
        }
      });
    }

    map.resize();
  }, [plan, routePreview, singleLegTrip, replanMode, routePreviewPending, loading, mapReady]);

  /** Itinerary stop markers — separate from route layers so `routePreview` updates do not clear/rebuild pins. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (poiMode !== "off") {
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
      for (const lid of ["stops-fallback-circle", "stops-fallback-sleep"]) {
        if (map.getLayer(lid)) map.removeLayer(lid);
      }
      if (map.getSource("stops-fallback-geojson")) map.removeSource("stops-fallback-geojson");
      return;
    }
    for (const lid of ["stops-fallback-circle", "stops-fallback-sleep"]) {
      if (map.getLayer(lid)) map.removeLayer(lid);
    }
    if (map.getSource("stops-fallback-geojson")) map.removeSource("stops-fallback-geojson");

    if (!plan) {
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
      return;
    }

    if (plan.stops.length === 0) {
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
      return;
    }

    for (const m of markersRef.current) m.remove();
    markersRef.current = [];

    const drawableStops = plan.stops.filter(
      (s) => hasFiniteCoords(s.coords) && (s.type !== "waypoint" || showWaypointMarkers)
    );
    if (drawableStops.length === 0) return;

    const bounds = drawableStops.reduce(
      (acc, s) => {
        const lon = Number(s.coords.lon);
        const lat = Number(s.coords.lat);
        acc.minLon = Math.min(acc.minLon, lon);
        acc.maxLon = Math.max(acc.maxLon, lon);
        acc.minLat = Math.min(acc.minLat, lat);
        acc.maxLat = Math.max(acc.maxLat, lat);
        return acc;
      },
      { minLon: 180, maxLon: -180, minLat: 90, maxLat: -90 }
    );
    const spanLon = bounds.maxLon - bounds.minLon;
    const spanLat = bounds.maxLat - bounds.minLat;
    if (
      !autoFitConsumedRef.current &&
      Number.isFinite(spanLon) &&
      Number.isFinite(spanLat) &&
      spanLon > 0 &&
      spanLat > 0
    ) {
      map.fitBounds(
        [
          [bounds.minLon, bounds.minLat],
          [bounds.maxLon, bounds.maxLat]
        ],
        { padding: 40, duration: 0 }
      );
      autoFitConsumedRef.current = true;
    }
    map.resize();

    for (const s of drawableStops) {
      const stopMeta = (s.meta ?? {}) as Record<string, unknown>;
      const stopPowerKw = toNumberOrNull(
        stopMeta.chargerMaxPowerKw ?? stopMeta.maxPowerKw
      );
      const sleepHasCharger = Boolean(stopMeta.chargerFound);
      if (s.type === "sleep") {
        const marker = new maplibregl.Marker({
          element: sleepStopMarkerElement(sleepHasCharger),
          anchor: "center"
        })
          .setLngLat([Number(s.coords.lon), Number(s.coords.lat)])
          .addTo(map);
        marker.getElement().style.zIndex = "5";
        markersRef.current.push(marker);
        continue;
      }
      const color =
        s.type === "start"
          ? "#1b6ef3"
          : s.type === "end"
            ? "#9b59b6"
            : s.type === "waypoint"
              ? "#6c5ce7"
              : isLikelyL2Power(stopPowerKw)
                ? COLORS.l2Teal
                : COLORS.dcfcTeal;
      const marker = new maplibregl.Marker({ color })
        .setLngLat([Number(s.coords.lon), Number(s.coords.lat)])
        .addTo(map);
      marker.getElement().style.zIndex = "5";
      markersRef.current.push(marker);
    }

    // Canvas-layer fallback: keeps stop markers visible even if DOM markers fail in this runtime.
    const stopFeatures = drawableStops.map((s) => {
      const stopMeta = (s.meta ?? {}) as Record<string, unknown>;
      const stopPowerKw = toNumberOrNull(
        stopMeta.chargerMaxPowerKw ?? stopMeta.maxPowerKw
      );
      const sleepHasCharger = Boolean(stopMeta.chargerFound);
      const color =
        s.type === "start"
          ? "#1b6ef3"
          : s.type === "end"
            ? "#9b59b6"
            : s.type === "waypoint"
              ? "#6c5ce7"
              : s.type === "sleep"
                ? sleepHasCharger
                  ? COLORS.sleepDarkRed
                  : COLORS.sleepHotelBrightBlue
                : isLikelyL2Power(stopPowerKw)
                  ? COLORS.l2Teal
                  : COLORS.dcfcTeal;
      return {
        type: "Feature" as const,
        properties: {
          stopType: s.type,
          color
        },
        geometry: {
          type: "Point" as const,
          coordinates: [Number(s.coords.lon), Number(s.coords.lat)] as [number, number]
        }
      };
    });
    map.addSource("stops-fallback-geojson", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: stopFeatures
      }
    });
    map.addLayer({
      id: "stops-fallback-circle",
      type: "circle",
      source: "stops-fallback-geojson",
      filter: ["!=", ["get", "stopType"], "sleep"],
      paint: {
        "circle-radius": 6,
        "circle-color": ["get", "color"],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.2
      }
    });
    map.addLayer({
      id: "stops-fallback-sleep",
      type: "symbol",
      source: "stops-fallback-geojson",
      filter: ["==", ["get", "stopType"], "sleep"],
      layout: {
        "text-field": "◆",
        "text-size": 16,
        "text-allow-overlap": true
      },
      paint: {
        "text-color": ["get", "color"],
        "text-halo-color": "#ffffff",
        "text-halo-width": 1.1
      }
    });
  }, [plan, mapReady, poiMode]);

  /** Slice 4: draw approximate road line from `POST /route-preview` until a successful plan replaces it. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const lid of ["route-preview-line", "route-preview-line-halo"]) {
      if (map.getLayer(lid)) map.removeLayer(lid);
    }
    if (map.getSource("route-preview-geojson")) map.removeSource("route-preview-geojson");

    /**
     * Progressive `planJob` checkpoints use `status: "ok"` on partial snapshots — only drop the dashed preview once
     * planning has finished (`loading` false), not on every partial route update.
     */
    if (plan?.status === "ok" && !loading) return;

    const planJobPartial =
      plan?.status === "ok" &&
      (plan.debug as Record<string, unknown> | undefined)?.planJobPartialRoute === true;
    if (
      planJobPartial &&
      loading &&
      countLegLineStringCoordinates(plan.legs) >= PARTIAL_PLAN_ROAD_GEOMETRY_MIN_COORDS
    ) {
      /** Pillar 3b: solid line from partial `legs` geometry — avoid double draw with dashed preview. */
      return;
    }

    const poly = routePreview?.preview?.polyline;
    if (!poly?.coordinates?.length || poly.coordinates.length < 2) return;

    map.addSource("route-preview-geojson", {
      type: "geojson",
      data: {
        type: "Feature",
        properties: {},
        geometry: poly
      }
    });
    map.addLayer({
      id: "route-preview-line-halo",
      type: "line",
      source: "route-preview-geojson",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#000000", "line-width": 8, "line-opacity": 0.15 }
    });
    map.addLayer({
      id: "route-preview-line",
      type: "line",
      source: "route-preview-geojson",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": COLORS.roadBlue,
        "line-width": 4,
        "line-dasharray": [2, 2]
      }
    });

    const coords = poly.coordinates;
    let minLon = 180;
    let maxLon = -180;
    let minLat = 90;
    let maxLat = -90;
    for (const c of coords) {
      const lon = c[0];
      const lat = c[1];
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
    const spanLon = maxLon - minLon;
    const spanLat = maxLat - minLat;
    if (
      !autoFitConsumedRef.current &&
      Number.isFinite(spanLon) &&
      Number.isFinite(spanLat) &&
      spanLon > 0 &&
      spanLat > 0
    ) {
      map.fitBounds(
        [
          [minLon, minLat],
          [maxLon, maxLat]
        ],
        { padding: 40, duration: 0 }
      );
      autoFitConsumedRef.current = true;
    }
    map.resize();
  }, [plan, routePreview, routePreviewPending, loading, mapReady]);

  const candidatesForMap: PlanTripCandidates | null =
    plan?.status === "ok" && plan.candidates && !isPartialPlanSnapshot
      ? plan.candidates
      : candidatePreview;

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const lid of ["candidates-fallback-chargers", "candidates-fallback-hotels"]) {
      if (map.getLayer(lid)) map.removeLayer(lid);
    }
    if (map.getSource("candidates-fallback-geojson")) map.removeSource("candidates-fallback-geojson");
    for (const m of candidateMarkersRef.current) m.remove();
    candidateMarkersRef.current = [];
    if (!candidatesForMap || poiMode !== "off") return;

    if (showChargerCandidates) {
      for (const c of candidatesForMap.chargers) {
        if (!hasFiniteCoords(c.coords)) continue;
        const locked =
          singleLegTrip && lockedChargersByLeg[0]?.includes(c.id);
        const l2 = isLikelyL2Power(toNumberOrNull(c.maxPowerKw));
        const marker = new maplibregl.Marker({
          color: locked
            ? l2
              ? "#4aa39f"
              : "#225a56"
            : l2
              ? COLORS.l2Teal
              : COLORS.dcfcTeal
        })
          .setLngLat([Number(c.coords.lon), Number(c.coords.lat)])
          .addTo(map);
        const el = marker.getElement();
        el.style.zIndex = "1";
        el.style.cursor = singleLegTrip ? "pointer" : "default";
        if (singleLegTrip) {
          el.addEventListener("click", (ev) => {
            ev.stopPropagation();
            setLockedChargersByLeg((rows) => {
              const row = [...(rows[0] ?? [])];
              const i = row.indexOf(c.id);
              if (i >= 0) row.splice(i, 1);
              else row.push(c.id);
              const next = [...rows];
              next[0] = row;
              return next;
            });
          });
        }
        candidateMarkersRef.current.push(marker);
      }
    }
    if (showHotelCandidates) {
      for (const h of candidatesForMap.hotels) {
        if (!hasFiniteCoords(h.coords)) continue;
        const sel = singleLegTrip && lockedHotelId === h.id;
        const hasNearbyCharger = candidatesForMap.chargers.some(
          (c) => haversineMiles(h.coords, c.coords) <= 400 / 1760
        );
        const marker = new maplibregl.Marker({
          color: sel
            ? hasNearbyCharger
              ? "#8a3d16"
              : "#cf711f"
            : hasNearbyCharger
              ? COLORS.hotelDarkOrange
              : COLORS.hotelLightOrange
        })
          .setLngLat([Number(h.coords.lon), Number(h.coords.lat)])
          .addTo(map);
        const el = marker.getElement();
        el.style.zIndex = "1";
        el.style.cursor = singleLegTrip ? "pointer" : "default";
        if (singleLegTrip) {
          el.addEventListener("click", (ev) => {
            ev.stopPropagation();
            setLockedHotelId((cur) => (cur === h.id ? null : h.id));
          });
        }
        candidateMarkersRef.current.push(marker);
      }
    }

    const chargerFeatures = showChargerCandidates
      ? candidatesForMap.chargers
        .filter((c) => hasFiniteCoords(c.coords))
        .map((c) => {
          const locked = singleLegTrip && lockedChargersByLeg[0]?.includes(c.id);
          const l2 = isLikelyL2Power(toNumberOrNull(c.maxPowerKw));
          const color = locked
            ? l2
              ? "#4aa39f"
              : "#225a56"
            : l2
              ? COLORS.l2Teal
              : COLORS.dcfcTeal;
          return {
            type: "Feature" as const,
            properties: { kind: "charger", color },
            geometry: {
              type: "Point" as const,
              coordinates: [Number(c.coords.lon), Number(c.coords.lat)] as [number, number]
            }
          };
        })
      : [];

    const hotelFeatures = showHotelCandidates
      ? candidatesForMap.hotels
        .filter((h) => hasFiniteCoords(h.coords))
        .map((h) => {
          const sel = singleLegTrip && lockedHotelId === h.id;
          const hasNearbyCharger = candidatesForMap.chargers.some(
            (c) => hasFiniteCoords(c.coords) && haversineMiles(h.coords, c.coords) <= 400 / 1760
          );
          const color = sel
            ? hasNearbyCharger
              ? "#8a3d16"
              : "#cf711f"
            : hasNearbyCharger
              ? COLORS.hotelDarkOrange
              : COLORS.hotelLightOrange;
          return {
            type: "Feature" as const,
            properties: { kind: "hotel", color },
            geometry: {
              type: "Point" as const,
              coordinates: [Number(h.coords.lon), Number(h.coords.lat)] as [number, number]
            }
          };
        })
      : [];

    const candidateFeatures = [...chargerFeatures, ...hotelFeatures];
    if (candidateFeatures.length > 0) {
      map.addSource("candidates-fallback-geojson", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: candidateFeatures
        }
      });
      map.addLayer({
        id: "candidates-fallback-chargers",
        type: "circle",
        source: "candidates-fallback-geojson",
        filter: ["==", ["get", "kind"], "charger"],
        paint: {
          "circle-radius": 5,
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1
        }
      });
      map.addLayer({
        id: "candidates-fallback-hotels",
        type: "circle",
        source: "candidates-fallback-geojson",
        filter: ["==", ["get", "kind"], "hotel"],
        paint: {
          "circle-radius": 5,
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1
        }
      });
    }
  }, [
    candidatesForMap,
    showChargerCandidates,
    showHotelCandidates,
    singleLegTrip,
    lockedChargersByLeg,
    lockedHotelId,
    mapReady,
    poiCandidates,
    poiSelection,
    poiMode
  ]);

  // Clear POI candidate state only when switching between two active (non-"off") POI
  // types so stale candidates don't appear under a different filter. When toggling to
  // "off" (EV Route) or back, preserve state so selections survive the round-trip.
  useEffect(() => {
    const prev = prevPoiModeRef.current;
    prevPoiModeRef.current = poiMode;
    if (prev !== "off" && poiMode !== "off" && prev !== poiMode) {
      setPoiCandidates(null);
      setPoiSelection((cur) => (Object.keys(cur).length === 0 ? cur : {}));
      setPoiError(null);
    }
  }, [poiMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const lid of ["poi-candidates-fallback"] as const) {
      if (map.getLayer(lid)) map.removeLayer(lid);
    }
    if (map.getSource("poi-candidates-fallback-geojson")) map.removeSource("poi-candidates-fallback-geojson");
    for (const m of poiMarkersRef.current) m.remove();
    poiMarkersRef.current = [];
    if (!poiCandidates || !poiCandidates.length || poiMode === "off") return;

    // Identify paired hotel+charger within 400 yards — same algorithm as EV-route view.
    const PAIR_THRESHOLD_MI = 400 / 1760;
    const poiHotels = poiCandidates.filter((p) => p.poi_type === "accommodation");
    const poiChargers = poiCandidates.filter((p) => p.poi_type === "charger");
    const pairedPoiIds = new Set<string>();
    for (const h of poiHotels) {
      for (const c of poiChargers) {
        if (haversineMiles({ lat: h.lat, lon: h.lon }, { lat: c.lat, lon: c.lon }) <= PAIR_THRESHOLD_MI) {
          pairedPoiIds.add(h.id);
          pairedPoiIds.add(c.id);
        }
      }
    }

    for (const poi of poiCandidates) {
      const isPaired = pairedPoiIds.has(poi.id);
      const color = isPaired
        ? COLORS.sleepDarkRed
        : poi.poi_type === "charger" ? COLORS.dcfcTeal : COLORS.hotelLightOrange;
      const selected = Boolean(poiSelection[poi.id]);
      const marker = new maplibregl.Marker({ element: poiCandidateMarkerElement(selected, color) })
        .setLngLat([poi.lon, poi.lat])
        .addTo(map);
      const el = marker.getElement();
      el.style.zIndex = "2";
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        setPoiSelection((cur) => ({
          ...cur,
          [poi.id]: !cur[poi.id]
        }));
      });
      poiMarkersRef.current.push(marker);
    }
  }, [mapReady, poiCandidates, poiSelection, poiMode]);

  function humanizePlannerMessage(msg: string): string {
    if (/Planner exceeded time limit \(\d+ms\)/i.test(msg)) {
      return `${msg} — Segment-level planner timeout fired. Increase PLAN_SEGMENT_TIMEOUT_MS in the API .env if needed.`;
    }
    if (/Valhalla fetch failed|Valhalla route|\/route\b/i.test(msg)) {
      return `${msg} — Start Valhalla locally or set VALHALLA_BASE_URL in the API .env (e.g. http://localhost:8002).`;
    }
    return msg;
  }

  function classifyPlanError(e: unknown, resp: Response | null): string {
    if (e instanceof DOMException && e.name === "AbortError") {
      const ms = planClientTimeoutMs();
      return `Planner request timed out after ${Math.round(ms / 1000)}s (NEXT_PUBLIC_PLAN_CLIENT_TIMEOUT_MS). No planner response body — no Debug solver list or provider timing.`;
    }
    if (e instanceof TypeError && /fetch|Load failed|NetworkError/i.test(String(e.message))) {
      return "Network error: could not reach the planner API. Check that the API is running and CORS allows this origin.";
    }
    if (resp?.status === 408) {
      const raw = e instanceof Error ? e.message : "";
      if (raw && /exceeded time limit|timed out/i.test(raw)) {
        return humanizePlannerMessage(raw);
      }
      return "The planner took too long (server time limit). Try a shorter route or retry later.";
    }
    if (resp?.status === 400 || resp?.status === 500 || resp?.status === 502) {
      const raw = e instanceof Error ? e.message : "Planning failed";
      return humanizePlannerMessage(raw);
    }
    const raw = e instanceof Error ? e.message : "Planning failed";
    return humanizePlannerMessage(raw);
  }

  async function getRoutePreviewShape(): Promise<Array<{ lat: number; lon: number }>> {
    const coords = routePreview?.preview?.polyline?.coordinates;
    if (routePreview?.status === "ok" && coords?.length && coords.length >= 2) {
      return coords.map(([lon, lat]) => ({ lat, lon }));
    }

    if (replanMode !== "off" || parsedWaypoints.length > 0) {
      throw new Error("POI Select is only available for single-leg start/end trips.");
    }

    const previewChain = routePreviewSegmentChain(start, [], end);
    const preview = await fetchMergedRoutePreview(
      apiBase,
      previewChain,
      abortSignalAfterMs(routePreviewClientTimeoutMs())
    );
    if (!preview || preview.status !== "ok" || !preview.preview?.polyline?.coordinates?.length) {
      throw new Error("Unable to fetch a route preview for the current corridor.");
    }
    setRoutePreview(preview);
    return preview.preview.polyline.coordinates.map(([lon, lat]) => ({ lat, lon }));
  }

  async function onFetchPoiCandidates() {
    setPoiError(null);
    setPoiCandidates(null);
    setPoiSelection({});
    if (!poiMode || poiMode === "off") {
      setPoiError("Select a POI mode before fetching corridor POIs.");
      return;
    }
    if (replanMode !== "off" || parsedWaypoints.length > 0) {
      setPoiError("POI Select only supports single-leg start/end trips for now.");
      return;
    }

    const radius = Number(poiRadiusMi);
    const perSectionLimit = Math.max(1, Math.round(Number(poiLimit)));
    if (!Number.isFinite(radius) || radius <= 0) {
      setPoiError("Enter a valid corridor radius in miles.");
      return;
    }
    if (!Number.isFinite(perSectionLimit) || perSectionLimit < 1) {
      setPoiError("Enter a valid per-segment limit (minimum 1).");
      return;
    }

    setPoiFetching(true);
    try {
      const rawShape = await getRoutePreviewShape();
      // Valhalla polylines cluster points in complex urban areas and spread thin on highways.
      // Use distance-based sampling: one point per mile for uniform geographic coverage.
      const MIN_SPACING_MI = 1;
      const sampledShape = (() => {
        if (rawShape.length <= 2) return rawShape;
        const out: typeof rawShape = [rawShape[0]];
        let last = rawShape[0];
        for (let i = 1; i < rawShape.length - 1; i++) {
          if (haversineMiles(last, rawShape[i]) >= MIN_SPACING_MI) {
            out.push(rawShape[i]);
            last = rawShape[i];
          }
        }
        out.push(rawShape[rawShape.length - 1]);
        return out;
      })();

      // The POI service fills `limit` from the nearest points at the start of the shape,
      // so a single query for a long route returns everything near the origin and nothing
      // near the destination. Fix: split the route into ~150-mile sections, query each in
      // parallel with a per-section limit, then deduplicate by id.
      const SECTION_MI = 150;
      const sections: Array<typeof sampledShape> = [];
      let secStart = 0;
      let accumulated = 0;
      for (let i = 1; i < sampledShape.length; i++) {
        accumulated += haversineMiles(sampledShape[i - 1], sampledShape[i]);
        if (accumulated >= SECTION_MI || i === sampledShape.length - 1) {
          sections.push(sampledShape.slice(secStart, i + 1));
          secStart = i;
          accumulated = 0;
        }
      }
      if (sections.length === 0) sections.push(sampledShape);

      // perSectionLimit is resolved above from poiLimit — used directly, not divided by section count.
      const url = `${apiBase.replace(/\/$/, "")}/corridor/pois`;

      const sectionResults = await Promise.all(
        sections.map(async (shape) => {
          const body: Record<string, unknown> = {
            shape,
            corridor_radius_mi: radius,
            poi_type: poiMode,
            limit: perSectionLimit
          };
          if (poiMode === "charger" && poiNetwork.trim()) {
            body.network = poiNetwork.trim();
          }
          const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          });
          const json = (await resp.json().catch(() => null)) as
            | { status: "ok"; pois: CorridorPoi[] }
            | { status?: string; message?: string };
          if (!resp.ok || json.status !== "ok" || !Array.isArray((json as any).pois)) {
            throw new Error((json as { message?: string }).message ?? "Failed to fetch corridor POIs.");
          }
          return (json as { pois: CorridorPoi[] }).pois;
        })
      );

      // Deduplicate by id across sections, preserving order.
      const seen = new Set<string>();
      const merged: CorridorPoi[] = [];
      for (const batch of sectionResults) {
        for (const poi of batch) {
          if (!seen.has(poi.id)) {
            seen.add(poi.id);
            merged.push(poi);
          }
        }
      }

      if (merged.length === 0) {
        setPoiError("No POIs found along this corridor.");
        return;
      }
      setPoiCandidates(merged);
    } catch (err) {
      setPoiError(err instanceof Error ? err.message : String(err));
    } finally {
      setPoiFetching(false);
    }
  }

  async function onPlanTrip() {
    clearMapPlanArtifacts();
    autoFitConsumedRef.current = false;
    setLoading(true);
    setError(null);
    setCandidatePreview(null);
    if (replanMode !== "off") {
      setRoutePreview(null);
    }
    /**
     * Keep `routePreview` for normal trips (replan off): the merged polyline redraws after `clearMapPlanArtifacts`
     * and stays visible while `/plan` runs (clearing here blanked the map until refetch). Replan modes clear above
     * — we do not refetch merged `/route-preview` for those flows.
     * Slice 2 `replanFrom.stopId` needs stops from the prior plan — capture before clearing UI state.
     */
    const priorPlanForReplan = plan;
    setPlan(null);
    setJobLiveSolverLegs(null);
    setJobLiveRequestId(null);
    setPlanJobCheckpointCount(null);
    setSegmentPrefixRefinementCount(null);
    const clientMs = planClientTimeoutMs();
    const controller = new AbortController();
    let timer: number | undefined;
    let resp: Response | null = null;
    const prefetchCandidates =
      (process.env.NEXT_PUBLIC_PREFETCH_CANDIDATES ?? "true").toLowerCase() !== "false";
    const prefetchRoutePreview =
      (process.env.NEXT_PUBLIC_PREFETCH_ROUTE_PREVIEW ?? "true").toLowerCase() !== "false";
    const candidatesGen = ++candidatesRequestGenRef.current;
    const routePreviewGen = ++routePreviewRequestGenRef.current;
    let pendingFailsafeTimer: number | undefined;
    try {
      const apiUrl = `${apiBase.replace(/\/$/, "")}/plan`;
      const candidatesUrl = `${apiBase.replace(/\/$/, "")}/candidates`;
      const wps = parsedWaypoints;
      const locks = lockedChargersByLeg.slice(0, legCount).map((r) => [...r]);
      const hasLocks = poiMode === "off" && locks.some((r) => r.length > 0);
      let allWaypoints = wps;
      const body: Record<string, unknown> = {
        end,
        includeCandidates: true,
        ...(wps.length ? { waypoints: wps } : {}),
        ...(hasLocks ? { lockedChargersByLeg: locks } : {}),
        ...(lockedHotelId && poiMode === "off" ? { lockedHotelId } : {}),
        ...(wps.length >= 2 &&
          !hasLocks &&
          replanMode === "off" &&
          optimizeWaypointOrder
          ? { optimizeWaypointOrder: true }
          : {})
      };

      if (poiCandidates && Object.values(poiSelection).some(Boolean) && singleLegTrip && replanMode === "off") {
        const selectedPois = poiCandidates.filter((poi) => poiSelection[poi.id]);
        const selectedHotels = selectedPois
          .filter((poi) => poi.poi_type === "accommodation")
          .map((poi) => poi.id);

        // Add selected charger POI coordinates as waypoints (hotels go via lockedHotelId, not waypoints)
        const poiWaypoints = selectedPois
          .filter((poi) => poi.poi_type !== "accommodation" && Number.isFinite(poi.lat) && Number.isFinite(poi.lon))
          .map((poi) => `${poi.lat},${poi.lon}`);
        allWaypoints = [...wps, ...poiWaypoints];

        // Note: When POIs are selected as waypoints, we don't need to lock them
        // since they're already waypoints in the route
        if (selectedHotels.length > 0) {
          body.lockedHotelId = selectedHotels[0];
        }
        if (allWaypoints.length > 0) {
          body.waypoints = allWaypoints;
        }
      }

      const candidatesBody: Record<string, unknown> = {
        end,
        ...(allWaypoints?.length ? { waypoints: allWaypoints } : wps.length ? { waypoints: wps } : {})
      };

      if (replanMode === "coords") {
        const lat = Number.parseFloat(replanLat);
        const lon = Number.parseFloat(replanLon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          throw new Error("Replan: enter valid latitude and longitude.");
        }
        body.replanFrom = { coords: { lat, lon } };
        candidatesBody.replanFrom = { coords: { lat, lon } };
      } else if (replanMode === "stopId") {
        if (!priorPlanForReplan?.stops?.length) {
          throw new Error('Replan from stop: run a normal "Plan Trip" first, then pick a stop.');
        }
        const sid = replanStopId.trim();
        if (!sid || !priorPlanForReplan.stops.some((s) => s.id === sid)) {
          throw new Error("Replan from stop: choose a valid stop id from the list.");
        }
        body.replanFrom = { stopId: sid };
        body.previousStops = priorPlanForReplan.stops;
        candidatesBody.replanFrom = { stopId: sid };
        candidatesBody.previousStops = priorPlanForReplan.stops;
      } else {
        body.start = start;
        candidatesBody.start = start;
      }

      if (prefetchCandidates) {
        void fetch(candidatesUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(candidatesBody)
        })
          .then(async (r) => {
            if (candidatesGen !== candidatesRequestGenRef.current) return;
            const j = (await r.json().catch(() => null)) as CandidatesApiResponse | null;
            if (r.ok && j?.status === "ok" && j.candidates) {
              setCandidatePreview(j.candidates);
            }
          })
          .catch(() => {
            /* ignore prefetch failure — /plan still drives UX */
          });
      }

      const previewChain =
        replanMode === "off" ? routePreviewSegmentChain(start, wps, end) : [];
      const shouldPrefetchPreview =
        prefetchRoutePreview && replanMode === "off" && previewChain.length >= 2;
      setRoutePreviewPending(shouldPrefetchPreview);

      const routePreviewTimeoutMs = routePreviewClientTimeoutMs();
      const routePreviewAbort = abortSignalAfterMs(routePreviewTimeoutMs);

      /** Run in parallel with /plan; single-leg = one request, waypoints = one request per hop (merged). */
      const routePreviewPromise: Promise<RoutePreviewApiResponse | null> =
        shouldPrefetchPreview
          ? fetchMergedRoutePreview(apiBase, previewChain, routePreviewAbort, (partial) => {
            if (routePreviewGen !== routePreviewRequestGenRef.current) return;
            setRoutePreview(partial);
            setRoutePreviewPending(false);
          })
          : Promise.resolve(null);

      /** Failsafe: if fetches hang without rejecting, still clear pending so the map can draw chord/leg geometry. */
      pendingFailsafeTimer = window.setTimeout(() => {
        if (routePreviewGen !== routePreviewRequestGenRef.current) return;
        setRoutePreviewPending(false);
      }, routePreviewTimeoutMs + 5000);

      void routePreviewPromise
        .then((previewJson) => {
          if (routePreviewGen !== routePreviewRequestGenRef.current) return;
          /** Only apply successful merges; never clear here — a late `null` after partials must not wipe the map. */
          if (previewJson) setRoutePreview(previewJson);
        })
        .catch(() => {
          /* ignore */
        })
        .finally(() => {
          window.clearTimeout(pendingFailsafeTimer);
          if (routePreviewGen !== routePreviewRequestGenRef.current) return;
          setRoutePreviewPending(false);
        });

      const usePlanJob = planUseJob();
      if (usePlanJob) {
        body.planJob = true;
        setJobLiveSolverLegs([]);
        setJobLiveRequestId(null);

        resp = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
        });

        let accepted: {
          jobId?: string;
          requestId?: string;
          responseVersion?: string;
          eventsUrl?: string;
        };
        try {
          accepted = (await resp.json()) as typeof accepted;
        } catch {
          throw new Error(`Invalid response from planner (HTTP ${resp.status}).`);
        }

        if (!resp.ok) {
          const errBody = accepted as unknown as PlanTripResponse;
          setPlan(errBody?.requestId ? errBody : null);
          throw new Error(errBody?.message ?? `Planning failed (HTTP ${resp.status})`);
        }

        if (resp.status !== 202) {
          throw new Error(`Expected HTTP 202 for planJob, got ${resp.status}`);
        }
        if (!accepted.jobId) {
          throw new Error("planJob response missing jobId");
        }
        setJobLiveRequestId(accepted.requestId ?? accepted.jobId ?? "plan-job");

        type PlanJobPollJson = {
          status: "running" | "complete" | "error";
          checkpoints?: Array<{ t?: string | number; legIndex: number; attempt: Record<string, unknown> }>;
          result?: PlanTripResponse;
          message?: string;
          debug?: Record<string, unknown>;
          lastPartialSnapshot?: {
            stops?: ItineraryStop[];
            legs?: ItineraryLeg[];
            rangeLegs?: RangeLegSummary[];
            legIndex?: number;
            stopsCount?: number;
            t?: number;
          };
        };

        const applyTerminalComplete = (pjResult: PlanTripResponse) => {
          setJobLiveSolverLegs(null);
          setJobLiveRequestId(null);
          setPlanJobCheckpointCount(null);
          setSegmentPrefixRefinementCount(null);
          if (pjResult.status === "ok") setPlan(pjResult);
          if (pjResult.status === "ok" && pjResult.candidates) {
            setCandidatePreview(null);
          }
          if (pjResult.status !== "ok") {
            setPlan((cur) => (cur ? cur : pjResult));
            throw new Error(pjResult.message ?? "Planning failed");
          }
        };

        const applyTerminalError = (pj: PlanJobPollJson) => {
          setJobLiveSolverLegs(null);
          setJobLiveRequestId(null);
          setPlanJobCheckpointCount(null);
          setSegmentPrefixRefinementCount(null);
          const msg = pj.message ?? "Planning failed";
          if (
            pj.lastPartialSnapshot &&
            Array.isArray(pj.lastPartialSnapshot.stops) &&
            Array.isArray(pj.lastPartialSnapshot.legs)
          ) {
            const partialFromError = planTripResponseFromPartialSnapshot(accepted, {
              stops: pj.lastPartialSnapshot.stops,
              legs: pj.lastPartialSnapshot.legs,
              rangeLegs: Array.isArray(pj.lastPartialSnapshot.rangeLegs)
                ? pj.lastPartialSnapshot.rangeLegs
                : undefined
            });
            setPlan((cur) =>
              cur && Array.isArray(cur.stops) && cur.stops.length >= partialFromError.stops.length
                ? cur
                : partialFromError
            );
          }
          const errPlan: PlanTripResponse = {
            requestId: accepted.requestId ?? accepted.jobId ?? "unknown",
            responseVersion: accepted.responseVersion ?? "v2-1",
            status: "error",
            message: msg,
            stops: [],
            legs: [],
            ...(pj.debug && Object.keys(pj.debug).length > 0 ? { debug: pj.debug } : {})
          };
          setPlan((cur) => {
            if (!cur) return errPlan;
            const mergedDebug = {
              ...((cur.debug ?? {}) as Record<string, unknown>),
              ...(pj.debug ?? {}),
              planJobTerminalError: true,
              planJobTerminalErrorMessage: msg
            };
            return {
              ...cur,
              message: msg,
              debug: mergedDebug
            };
          });
          throw new Error(msg);
        };

        const pollUrl = `${apiBase.replace(/\/$/, "")}/plan/jobs/${accepted.jobId}`;
        const useSse = planJobUseSse() && typeof EventSource !== "undefined";

        if (useSse) {
          await new Promise<void>((resolve, reject) => {
            const eventsUrl = resolvePlanJobEventsUrl(apiBase, accepted.jobId!, accepted.eventsUrl);
            const acc: PlanJobCheckpointRow[] = [];
            let idleDeadline = Date.now() + clientMs;
            let lastCheckpointSig = "";
            let progressiveBestStops = 0;
            let completed = false;
            let reconnectAttempt = 0;
            let reconnectTimer: number | null = null;
            let watchdog: number | null = null;
            let currentEs: EventSource | null = null;

            const bumpIdle = () => {
              idleDeadline = Date.now() + clientMs;
            };

            const clearReconnectTimer = () => {
              if (reconnectTimer != null) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
              }
            };

            const stopWatchdog = () => {
              if (watchdog != null) {
                clearInterval(watchdog);
                watchdog = null;
              }
            };

            const closeEs = () => {
              if (currentEs) {
                currentEs.close();
                currentEs = null;
              }
            };

            const fullCleanup = () => {
              clearReconnectTimer();
              stopWatchdog();
              closeEs();
            };

            const abortHandler = () => {
              if (completed) return;
              fullCleanup();
              controller.signal.removeEventListener("abort", abortHandler);
              reject(new DOMException("Aborted", "AbortError"));
            };
            controller.signal.addEventListener("abort", abortHandler);

            const startWatchdog = () => {
              stopWatchdog();
              watchdog = window.setInterval(() => {
                if (controller.signal.aborted) {
                  fullCleanup();
                  controller.signal.removeEventListener("abort", abortHandler);
                  reject(new DOMException("Aborted", "AbortError"));
                  return;
                }
                if (!completed && Date.now() > idleDeadline) {
                  fullCleanup();
                  controller.signal.removeEventListener("abort", abortHandler);
                  setJobLiveSolverLegs(null);
                  setJobLiveRequestId(null);
                  setPlanJobCheckpointCount(null);
                  setSegmentPrefixRefinementCount(null);
                  reject(
                    new Error(
                      `Planner SSE idle-timeout after ${Math.round(
                        clientMs / 1000
                      )}s with no checkpoints or heartbeats (NEXT_PUBLIC_PLAN_CLIENT_TIMEOUT_MS).`
                    )
                  );
                }
              }, 500);
            };

            const attachEventSource = () => {
              bumpIdle();
              startWatchdog();
              const es = new EventSource(eventsUrl);
              currentEs = es;

              es.onmessage = (ev) => {
                if (completed) return;
                let j: unknown;
                try {
                  j = JSON.parse(ev.data);
                } catch {
                  return;
                }
                if (!j || typeof j !== "object") return;
                const o = j as Record<string, unknown>;
                if (o.type === "heartbeat") {
                  bumpIdle();
                  return;
                }
                if (o.type === "checkpoint" && o.checkpoint && typeof o.checkpoint === "object") {
                  const row = o.checkpoint as PlanJobCheckpointRow;
                  acc.push(row);
                  setPlanJobCheckpointCount(acc.length);
                  setSegmentPrefixRefinementCount(countSegmentPrefixRefinementRows(acc));
                  const newest = acc[acc.length - 1];
                  const newestSig = `${acc.length}:${newest.t ?? ""}:${newest.legIndex}:${newest.attempt?.kind ?? ""
                    }`;
                  if (newestSig !== lastCheckpointSig) {
                    lastCheckpointSig = newestSig;
                    bumpIdle();
                  }
                  const r = applyPlanJobCheckpointRows(
                    acc,
                    accepted,
                    progressiveBestStops,
                    setPlan,
                    setJobLiveSolverLegs
                  );
                  progressiveBestStops = r.progressiveBestStops;
                } else if (o.type === "complete" && o.result) {
                  completed = true;
                  clearReconnectTimer();
                  fullCleanup();
                  controller.signal.removeEventListener("abort", abortHandler);
                  try {
                    applyTerminalComplete(o.result as PlanTripResponse);
                    resolve();
                  } catch (e) {
                    reject(e);
                  }
                } else if (o.type === "error") {
                  completed = true;
                  clearReconnectTimer();
                  fullCleanup();
                  controller.signal.removeEventListener("abort", abortHandler);
                  try {
                    applyTerminalError({
                      status: "error",
                      message: typeof o.message === "string" ? o.message : undefined,
                      debug:
                        o.debug && typeof o.debug === "object"
                          ? (o.debug as Record<string, unknown>)
                          : undefined,
                      lastPartialSnapshot: o.lastPartialSnapshot as PlanJobPollJson["lastPartialSnapshot"]
                    });
                  } catch (e) {
                    reject(e);
                  }
                }
              };

              es.onerror = () => {
                if (completed) return;
                es.close();
                if (currentEs === es) currentEs = null;
                stopWatchdog();
                if (reconnectAttempt >= PLAN_JOB_SSE_MAX_RECONNECTS) {
                  clearReconnectTimer();
                  controller.signal.removeEventListener("abort", abortHandler);
                  setJobLiveSolverLegs(null);
                  setJobLiveRequestId(null);
                  setPlanJobCheckpointCount(null);
                  setSegmentPrefixRefinementCount(null);
                  reject(
                    new Error(
                      `Plan job SSE failed after ${PLAN_JOB_SSE_MAX_RECONNECTS} reconnect attempts`
                    )
                  );
                  return;
                }
                reconnectAttempt += 1;
                const delay = planJobSseReconnectDelayMs(reconnectAttempt);
                clearReconnectTimer();
                reconnectTimer = window.setTimeout(() => {
                  reconnectTimer = null;
                  if (controller.signal.aborted || completed) return;
                  acc.length = 0;
                  progressiveBestStops = 0;
                  lastCheckpointSig = "";
                  setPlanJobCheckpointCount(0);
                  setSegmentPrefixRefinementCount(0);
                  attachEventSource();
                }, delay);
              };
            };

            attachEventSource();
          });
        } else {
          let idleDeadline = Date.now() + clientMs;
          let completed = false;
          let lastCheckpointSig = "";
          let progressiveBestStops = 0;

          while (Date.now() < idleDeadline && !completed) {
            if (controller.signal.aborted) {
              setJobLiveSolverLegs(null);
              setJobLiveRequestId(null);
              setPlanJobCheckpointCount(null);
              setSegmentPrefixRefinementCount(null);
              throw new DOMException("Aborted", "AbortError");
            }

            const pr = await fetch(pollUrl, { signal: controller.signal });
            if (!pr.ok) {
              setJobLiveSolverLegs(null);
              setJobLiveRequestId(null);
              setPlanJobCheckpointCount(null);
              setSegmentPrefixRefinementCount(null);
              if (pr.status === 404) {
                throw new Error("Plan job expired or unknown (404). Retry Plan Trip.");
              }
              throw new Error(`Poll failed (HTTP ${pr.status})`);
            }

            let pj: PlanJobPollJson;
            try {
              pj = (await pr.json()) as PlanJobPollJson;
            } catch {
              throw new Error("Invalid JSON from plan job poll.");
            }

            if (Array.isArray(pj.checkpoints) && pj.checkpoints.length > 0) {
              setPlanJobCheckpointCount(pj.checkpoints.length);
              setSegmentPrefixRefinementCount(
                countSegmentPrefixRefinementRows(pj.checkpoints as PlanJobCheckpointRow[])
              );
              const newest = pj.checkpoints[pj.checkpoints.length - 1];
              const newestSig = `${pj.checkpoints.length}:${newest.t ?? ""}:${newest.legIndex}:${newest.attempt?.kind ?? ""
                }`;
              if (newestSig !== lastCheckpointSig) {
                lastCheckpointSig = newestSig;
                idleDeadline = Date.now() + clientMs;
              }
              const r = applyPlanJobCheckpointRows(
                pj.checkpoints as PlanJobCheckpointRow[],
                accepted,
                progressiveBestStops,
                setPlan,
                setJobLiveSolverLegs
              );
              progressiveBestStops = r.progressiveBestStops;
            }

            if (pj.status === "complete" && pj.result) {
              applyTerminalComplete(pj.result);
              completed = true;
              break;
            }

            if (pj.status === "error") {
              applyTerminalError(pj);
            }

            await new Promise((r) => setTimeout(r, 250));
          }

          if (!completed) {
            setJobLiveSolverLegs(null);
            setJobLiveRequestId(null);
            setPlanJobCheckpointCount(null);
            setSegmentPrefixRefinementCount(null);
            throw new Error(
              `Planner poll idle-timeout after ${Math.round(
                clientMs / 1000
              )}s with no new checkpoints (NEXT_PUBLIC_PLAN_CLIENT_TIMEOUT_MS).`
            );
          }
        }
      } else {
        timer = window.setTimeout(() => controller.abort(), clientMs);
        resp = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        let json: PlanTripResponse;
        try {
          json = (await resp.json()) as PlanTripResponse;
        } catch {
          throw new Error(`Invalid response from planner (HTTP ${resp.status}).`);
        }

        if (!resp.ok) {
          setPlan(json);
          throw new Error(json.message ?? `Planning failed (HTTP ${resp.status})`);
        }
        setPlan(json);
        if (json.status === "ok" && json.candidates) {
          setCandidatePreview(null);
        }
      }
    } catch (e) {
      setRoutePreviewPending(false);
      setJobLiveSolverLegs(null);
      setJobLiveRequestId(null);
      setPlanJobCheckpointCount(null);
      setSegmentPrefixRefinementCount(null);
      setError(classifyPlanError(e, resp));
    } finally {
      if (pendingFailsafeTimer !== undefined) window.clearTimeout(pendingFailsafeTimer);
      if (timer !== undefined) window.clearTimeout(timer);
      setLoading(false);
    }
  }

  const roadRefinementStage: RefinementStage = (() => {
    if (!roadPreviewEnabled) return "skipped";
    if (routePreview?.status === "ok") return "done";
    if (routePreview?.status === "error") return "error";
    if (!hasPlanActivity) return "idle";
    if (loading && routePreviewPending) return "active";
    if (loading) return "pending";
    return "pending";
  })();

  const candidatesRefinementStage: RefinementStage = (() => {
    if (!prefetchCandidatesEnv) return "skipped";
    if (candidatePreview != null) return "done";
    if (!loading && plan !== null) return "done";
    if (!hasPlanActivity) return "idle";
    if (loading) return "active";
    return "pending";
  })();

  const planRefinementStage: RefinementStage = (() => {
    if (!hasPlanActivity) return "idle";
    if (error || plan?.status === "error") return "error";
    // Partial `planJob` snapshots use `status: ok` before the job finishes — keep stage 3 active until `loading` clears.
    if (loading) return "active";
    if (plan?.status === "ok") return "done";
    return "pending";
  })();

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 420px) minmax(0, 1fr)",
        gridTemplateRows: "minmax(0, 1fr)",
        height: "100vh",
        width: "100%",
        overflow: "hidden"
      }}
    >
      <div style={{ padding: 16, borderRight: "1px solid #e5e5e5", overflow: "auto", minHeight: 0 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>EV Travel Planner (v2)</h1>
        <p style={{ margin: "6px 0 0 0", fontSize: 12, color: "#555" }}>
          Along-route charger + hotel candidates appear as teal / coral markers (Slice 3: requested early via{" "}
          <code>POST /candidates</code> in parallel with <code>/plan</code> unless{" "}
          <code>NEXT_PUBLIC_PREFETCH_CANDIDATES=false</code>). <strong>Slice 4:</strong> normal trips (start + optional
          waypoints + end) fetch <code>POST /route-preview</code> per hop and merge (blue dashed initial route + horizon turn list) unless{" "}
          <code>NEXT_PUBLIC_PREFETCH_ROUTE_PREVIEW=false</code>. Itinerary stops use blue / purple / orange / green.
        </p>
        <p style={{ margin: "8px 0 0 0", fontSize: 12, color: "#555" }}>
          <strong>Locks (single segment only):</strong> click a green charger to require it on the route; click
          coral hotel to prefer it for overnight (when needed). Clear locks by clicking again. Multi-stop waypoints
          disable map locking for now.
        </p>

        <div
          style={{
            marginTop: 12,
            padding: "10px 12px",
            background: "#fafafa",
            border: "1px solid #e5e7eb",
            borderRadius: 6
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Progressive refinement (ROUTING_UX_SPEC §4)</div>
          <p style={{ margin: "0 0 8px 0", fontSize: 11, color: "#666" }}>
            Stages: road corridor → along-route pins → full EV itinerary. With <strong>Optimize waypoint order</strong>{" "}
            (≥2 waypoints, no locks), the server may reorder stops to shorten a haversine proxy before planning. With{" "}
            <code>NEXT_PUBLIC_PLAN_USE_JOB</code>, stage 3 shows checkpoint counts and{" "}
            <strong>segment-hop refinements</strong> as the solver commits each timed hop toward the next charge or end.
          </p>
          {(() => {
            const roadSub =
              roadRefinementStage === "skipped"
                ? replanMode !== "off"
                  ? "Skipped: replan flow does not run parallel /route-preview."
                  : !prefetchRoutePreviewEnv
                    ? "Skipped: NEXT_PUBLIC_PREFETCH_ROUTE_PREVIEW=false."
                    : "Skipped: no preview chain for this trip."
                : undefined;
            const candSub =
              candidatesRefinementStage === "skipped"
                ? "Skipped: NEXT_PUBLIC_PREFETCH_CANDIDATES=false."
                : undefined;
            const planJobCpSuffix =
              planUseJob() &&
                loading &&
                planJobCheckpointCount != null &&
                planJobCheckpointCount > 0
                ? ` · ${planJobCheckpointCount} checkpoint${planJobCheckpointCount === 1 ? "" : "s"
                } from server${segmentPrefixRefinementCount != null && segmentPrefixRefinementCount > 0
                  ? ` · ${segmentPrefixRefinementCount} segment-hop refinement${segmentPrefixRefinementCount === 1 ? "" : "s"
                  }`
                  : ""
                }`
                : "";
            const planSub =
              loading && planRefinementStage === "active"
                ? planUseJob()
                  ? isPartialPlanSnapshot && plan && plan.stops.length > 0
                    ? `Elapsed ${formatElapsedMmSs(planElapsedSec)} — partial itinerary visible (${plan.stops.length} stops from latest checkpoint; not final). More checkpoints may follow; route line uses chord or preview until the job completes.${planJobCpSuffix}`
                    : `Elapsed ${formatElapsedMmSs(planElapsedSec)} — EV solver still running (async plan job). Route preview + pins are separate requests; Debug shows checkpoint solver rows as they arrive.${planJobCpSuffix}`
                  : `Elapsed ${formatElapsedMmSs(planElapsedSec)} — EV solver still running. Route preview + pins are separate requests; the itinerary and Debug (staggered solver rows) appear only when this step finishes (blocking POST /plan — not live).`
                : undefined;
            const rows: Array<{ label: string; stage: RefinementStage; sub?: string }> = [
              { label: "1. Road corridor (Valhalla /route-preview)", stage: roadRefinementStage, sub: roadSub },
              { label: "2. Along-route candidate pins (/candidates)", stage: candidatesRefinementStage, sub: candSub },
              { label: "3. EV itinerary (POST /plan)", stage: planRefinementStage, sub: planSub }
            ];
            return rows.map((r) => {
              const st = refinementStageStyle(r.stage);
              return (
                <div
                  key={r.label}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "flex-start",
                    marginBottom: 4,
                    fontSize: 12
                  }}
                >
                  <span style={{ color: st.color, fontWeight: 700, width: 18, flexShrink: 0 }} aria-hidden>
                    {st.glyph}
                  </span>
                  <div>
                    <div style={{ color: "#374151" }}>{r.label}</div>
                    {r.sub ? (
                      <div style={{ fontSize: 11, color: "#9ca3af" }}>{r.sub}</div>
                    ) : null}
                  </div>
                </div>
              );
            });
          })()}
          {(() => {
            const wopt = (plan?.debug as Record<string, unknown> | undefined)?.waypointOrderOptimization as
              | { applied?: boolean; userOrder?: string[]; chosenOrder?: string[] }
              | undefined;
            if (!wopt?.applied || !Array.isArray(wopt.userOrder) || !Array.isArray(wopt.chosenOrder)) return null;
            return (
              <div
                style={{
                  marginTop: 8,
                  padding: "8px 10px",
                  background: "#eff6ff",
                  border: "1px solid #93c5fd",
                  borderRadius: 6,
                  fontSize: 11,
                  color: "#1e3a5f",
                  lineHeight: 1.45
                }}
              >
                <strong>Waypoint order optimized</strong> (haversine leg-sum proxy): your order{" "}
                <span style={{ opacity: 0.9 }}>{wopt.userOrder.join(" → ")}</span> → planner used{" "}
                <span style={{ fontWeight: 600 }}>{wopt.chosenOrder.join(" → ")}</span>.
              </div>
            );
          })()}
          {loading && plan === null ? (
            <div
              style={{
                marginTop: 10,
                padding: "10px 12px",
                background: "#fffbeb",
                border: "1px solid #fcd34d",
                borderRadius: 6,
                fontSize: 11,
                color: "#78350f",
                lineHeight: 1.45
              }}
            >
              <strong>Typical timing:</strong> road preview ~2s, charger/hotel pins ~10–15s (parallel prefetches).{" "}
              {planUseJob() ? (
                <>
                  With <code>NEXT_PUBLIC_PLAN_USE_JOB=true</code>, the map uses an async plan job:{" "}
                  <strong>Debug — plan-job checkpoints</strong> lists solver rows as checkpoints arrive over SSE{" "}
                  <code>/events</code> (or poll);
                  the full itinerary and complete <code>debug.*</code> appear when the job finishes (often 2+ minutes on
                  long EV solves). See <strong>TESTING.md</strong>.
                </>
              ) : (
                <>
                  <strong>Solver attempts in Debug</strong> (<code>debug.segmentsAttempted</code>) and the itinerary
                  below ship <strong>with</strong> the blocking <code>POST /plan</code> body — often 2+ minutes on long
                  cross-country EV solves. The browser does not receive each attempt during the solve; after the response
                  returns, attempts are revealed in order (staggered readout — see{" "}
                  <strong>Solver attempts (staggered readout)</strong> below).
                </>
              )}
            </div>
          ) : null}
          {loading && isPartialPlanSnapshot && plan && plan.stops.length > 0 ? (
            <div
              style={{
                marginTop: 10,
                padding: "10px 12px",
                background: "#ecfdf5",
                border: "1px solid #6ee7b7",
                borderRadius: 6,
                fontSize: 11,
                color: "#064e3b",
                lineHeight: 1.45
              }}
              role="status"
              aria-live="polite"
            >
              <strong>Partial itinerary (real checkpoints)</strong> — {plan.stops.length} stop
              {plan.stops.length === 1 ? "" : "s"} on the map and in the list below
              {planJobCheckpointCount != null && planJobCheckpointCount > 0 ? (
                <>
                  . <strong>{planJobCheckpointCount}</strong> server checkpoint
                  {planJobCheckpointCount === 1 ? "" : "s"} received so far
                </>
              ) : null}
              . This is <strong>server data</strong>, not a simulated progress bar. Stops and route may grow as the
              planner finishes; final totals and <code>debug.*</code> arrive when the job completes.
            </div>
          ) : null}
        </div>

        <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
          <fieldset style={{ margin: 0, padding: "10px 12px", border: "1px solid #ddd", borderRadius: 6 }}>
            <legend style={{ fontSize: 13 }}>Slice 2 — replan start</legend>
            <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="radio"
                  name="replanMode"
                  checked={replanMode === "off"}
                  onChange={() => setReplanMode("off")}
                />
                Normal start (address)
              </label>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="radio"
                  name="replanMode"
                  checked={replanMode === "coords"}
                  onChange={() => setReplanMode("coords")}
                />
                Replan from lat/lon (device / map)
              </label>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="radio"
                  name="replanMode"
                  checked={replanMode === "stopId"}
                  onChange={() => setReplanMode("stopId")}
                />
                Replan from prior itinerary stop
              </label>
            </div>
          </fieldset>

          <label>
            <div style={{ marginBottom: 6 }}>Start {replanMode !== "off" ? "(unused)" : ""}</div>
            <input
              value={start}
              onChange={(e) => setStart(e.target.value)}
              disabled={replanMode !== "off"}
              style={{ width: "100%", padding: 8, opacity: replanMode !== "off" ? 0.5 : 1 }}
            />
          </label>

          {replanMode === "coords" ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <label>
                <div style={{ marginBottom: 4, fontSize: 12 }}>Replan latitude</div>
                <input
                  value={replanLat}
                  onChange={(e) => setReplanLat(e.target.value)}
                  style={{ width: "100%", padding: 8 }}
                />
              </label>
              <label>
                <div style={{ marginBottom: 4, fontSize: 12 }}>Replan longitude</div>
                <input
                  value={replanLon}
                  onChange={(e) => setReplanLon(e.target.value)}
                  style={{ width: "100%", padding: 8 }}
                />
              </label>
            </div>
          ) : null}

          {replanMode === "stopId" ? (
            <label>
              <div style={{ marginBottom: 6, fontSize: 12 }}>
                Prior stop (from last successful plan below)
              </div>
              <select
                value={replanStopId}
                onChange={(e) => setReplanStopId(e.target.value)}
                style={{ width: "100%", padding: 8 }}
              >
                <option value="">— select stop —</option>
                {(plan?.stops ?? []).map((s, idx) => (
                  <option key={`${s.id}-${idx}`} value={s.id}>
                    {s.type}: {s.name} ({s.id})
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            <div style={{ marginBottom: 6 }}>End</div>
            <input
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              style={{ width: "100%", padding: 8 }}
            />
          </label>
          <label>
            <div style={{ marginBottom: 6 }}>Waypoints (optional, one per line)</div>
            <textarea
              value={waypointsText}
              onChange={(e) => setWaypointsText(e.target.value)}
              placeholder="Charlotte, NC"
              rows={3}
              style={{ width: "100%", padding: 8, fontFamily: "inherit" }}
            />
          </label>

          {parsedWaypoints.length >= 2 && replanMode === "off" ? (
            <label
              style={{
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
                fontSize: 12,
                color: "#374151",
                lineHeight: 1.45
              }}
            >
              <input
                type="checkbox"
                checked={optimizeWaypointOrder}
                onChange={(e) => setOptimizeWaypointOrder(e.target.checked)}
                disabled={lockedChargersByLeg.some((r) => r.length > 0) || Boolean(lockedHotelId)}
                style={{ marginTop: 2 }}
              />
              <span>
                <strong>Optimize waypoint order</strong> — server minimizes straight-line leg distance (time-bounded)
                before EV planning. Off when locks or replan are active. Default:{" "}
                <code>NEXT_PUBLIC_OPTIMIZE_WAYPOINT_ORDER</code> (build-time).
              </span>
            </label>
          ) : null}

          <div style={{ display: "flex", gap: 8, marginBottom: 12, borderBottom: "1px solid #ddd", paddingBottom: 8 }}>
            <button
              type="button"
              onClick={() => setPoiMode("off")}
              style={{
                padding: "8px 12px",
                background: poiMode === "off" ? "#0b7cff" : "#e5e7eb",
                color: poiMode === "off" ? "#fff" : "#374151",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                fontWeight: poiMode === "off" ? 600 : 500,
                fontSize: 13
              }}
            >
              EV Route
            </button>
            <button
              type="button"
              onClick={() => setPoiMode("all")}
              style={{
                padding: "8px 12px",
                background: poiMode !== "off" ? "#0b7cff" : "#e5e7eb",
                color: poiMode !== "off" ? "#fff" : "#374151",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                fontWeight: poiMode !== "off" ? 600 : 500,
                fontSize: 13
              }}
            >
              POI Select
            </button>
          </div>

          {poiMode === "off" ? (
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 }}>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={showChargerCandidates}
                  onChange={(e) => setShowChargerCandidates(e.target.checked)}
                />
                Show charger candidates
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={showHotelCandidates}
                  onChange={(e) => setShowHotelCandidates(e.target.checked)}
                />
                Show hotel candidates
              </label>
            </div>
          ) : null}

          {poiMode !== "off" ? (
            <fieldset
              style={{
                marginTop: 12,
                padding: "12px 12px 10px",
                border: "1px solid #ddd",
                borderRadius: 6,
                background: "#fafafa"
              }}
            >
              <legend style={{ fontSize: 13, fontWeight: 600 }}>POI Select Filters</legend>
              <p style={{ margin: "0 0 10px 0", fontSize: 12, color: "#555" }}>
                Filter corridor POIs and select to lock into your route.
              </p>
              <div style={{ display: "grid", gap: 8, marginBottom: 10, fontSize: 13 }}>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="radio"
                    name="poiMode"
                    checked={poiMode === "all"}
                    onChange={() => setPoiMode("all")}
                  />
                  All POIs
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="radio"
                    name="poiMode"
                    checked={poiMode === "charger"}
                    onChange={() => setPoiMode("charger")}
                  />
                  Chargers
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="radio"
                    name="poiMode"
                    checked={poiMode === "accommodation"}
                    onChange={() => setPoiMode("accommodation")}
                  />
                  Hotels
                </label>
              </div>
              {poiMode === "charger" ? (
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  <div>Network filter (optional)</div>
                  <input
                    value={poiNetwork}
                    onChange={(e) => setPoiNetwork(e.target.value)}
                    placeholder="e.g. Tesla, ChargePoint"
                    style={{ width: "100%", padding: 8 }}
                  />
                </label>
              ) : null}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  <div>Corridor radius (mi)</div>
                  <input
                    value={poiRadiusMi}
                    onChange={(e) => setPoiRadiusMi(e.target.value)}
                    style={{ width: "100%", padding: 8 }}
                  />
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  <div>Per segment</div>
                  <input
                    value={poiLimit}
                    onChange={(e) => setPoiLimit(e.target.value)}
                    style={{ width: "100%", padding: 8 }}
                  />
                </label>
              </div>
              <button
                type="button"
                onClick={onFetchPoiCandidates}
                disabled={poiFetching || loading}
                style={{ marginTop: 10, padding: 10 }}
              >
                {poiFetching ? "Fetching POIs…" : "Fetch corridor POIs"}
              </button>
              {poiError ? (
                <div style={{ marginTop: 10, color: "crimson", fontSize: 12 }}>{poiError}</div>
              ) : null}
              {poiCandidates ? (
                <div style={{ marginTop: 10, fontSize: 12, color: "#374151" }}>
                  <div style={{ marginBottom: 6 }}>
                    {poiCandidates.length} POI{poiCandidates.length === 1 ? "" : "s"} found. Click map markers or
                    checkboxes to select.
                  </div>
                  <div style={{ display: "grid", gap: 6, maxHeight: 220, overflow: "auto" }}>
                    {[...poiCandidates]
                      .sort((a, b) => {
                        const as = Boolean(poiSelection[a.id]);
                        const bs = Boolean(poiSelection[b.id]);
                        return as === bs ? 0 : as ? -1 : 1;
                      })
                      .map((poi) => {
                        const selected = Boolean(poiSelection[poi.id]);
                        return (
                          <label
                            key={poi.id}
                            style={{
                              display: "flex",
                              gap: 8,
                              alignItems: "center",
                              padding: "6px 8px",
                              background: selected ? "#eef2ff" : "#fff",
                              border: "1px solid #e5e7eb",
                              borderRadius: 6,
                              cursor: "pointer"
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() =>
                                setPoiSelection((cur) => ({ ...cur, [poi.id]: !cur[poi.id] }))
                              }
                            />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 600, fontSize: 12 }}>{poi.name}</div>
                              <div style={{ fontSize: 11, color: "#6b7280" }}>
                                {poi.poi_type} · {poi.city ?? poi.state ?? "unknown"}
                                {poi.network ? ` · ${poi.network}` : ""}
                              </div>
                            </div>
                          </label>
                        );
                      })}
                  </div>
                </div>
              ) : null}
            </fieldset>
          ) : null}

          {poiMode === "off" && (!defaultShowCandidates || !defaultShowWaypoints) ? (
            <div
              style={{
                marginTop: 6,
                fontSize: 12,
                color: "#6b7280"
              }}
            >
              Map defaults are currently reducing debug marker density ({!defaultShowCandidates
                ? "candidates hidden by default"
                : null}
              {!defaultShowCandidates && !defaultShowWaypoints ? ", " : null}
              {!defaultShowWaypoints ? "auto-waypoint markers hidden by default" : null}
              ). You can still enable candidate markers with the toggles above, or override via{" "}
              <code>NEXT_PUBLIC_MAP_SHOW_CANDIDATES_DEFAULT</code> /{" "}
              <code>NEXT_PUBLIC_MAP_SHOW_WAYPOINTS_DEFAULT</code>.
            </div>
          ) : null}

          <div
            style={{
              marginTop: 8,
              padding: "8px 10px",
              border: "1px solid #e5e7eb",
              borderRadius: 6,
              background: "#fafafa",
              fontSize: 12
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 6, color: "#374151" }}>Map legend</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", color: "#4b5563" }}>
              {(
                [
                  { label: "Hotel", color: COLORS.hotelLightOrange },
                  { label: "Hotel + nearby charger", color: COLORS.hotelDarkOrange },
                  { label: "POI paired (hotel+charger ≤400 yd)", color: COLORS.sleepDarkRed },
                  {
                    label: "Sleep hotel (no charger)",
                    color: COLORS.sleepHotelBrightBlue,
                    diamond: true
                  },
                  {
                    label: "Sleep hotel + charger",
                    color: COLORS.sleepDarkRed,
                    diamond: true
                  },
                  { label: "DCFC", color: COLORS.dcfcTeal },
                  { label: "L2 charger", color: COLORS.l2Teal },
                  { label: "Road", color: COLORS.roadBlue }
                ] as const
              ).map((item) => (
                <span key={item.label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {"diamond" in item && item.diamond ? (
                    <span
                      aria-hidden="true"
                      style={{
                        width: 10,
                        height: 10,
                        boxSizing: "border-box",
                        background: item.color,
                        transform: "rotate(45deg)",
                        borderRadius: 2,
                        border: "1.5px solid rgba(255, 255, 255, 0.92)",
                        boxShadow: "0 0 0 1px rgba(0,0,0,0.12)"
                      }}
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        background: item.color,
                        border: "1px solid rgba(0,0,0,0.2)"
                      }}
                    />
                  )}
                  {item.label}
                </span>
              ))}
            </div>
          </div>

          <button onClick={onPlanTrip} disabled={loading} style={{ padding: 10 }}>
            {loading ? planningButtonLabel : "Plan Trip"}
          </button>
          {loading ? (
            <div
              style={{
                marginTop: 6,
                padding: "8px 10px",
                background: "#eff6ff",
                border: "1px solid #bfdbfe",
                borderRadius: 6,
                fontSize: 12,
                color: "#1e3a5f"
              }}
              role="status"
              aria-live="polite"
            >
              <strong>{formatElapsedMmSs(planElapsedSec)}</strong> elapsed · {planningLoadingHelp ?? "—"}
              <div style={{ marginTop: 6, fontSize: 11, color: "#4b5563" }}>
                This is a <strong>liveness</strong> clock (the tab is updating). Client aborts after{" "}
                <strong>{Math.round(planClientTimeoutMs() / 1000)}s</strong> of no progress in plan-job mode to avoid a
                stuck tab; API segment solves use <code>PLAN_SEGMENT_TIMEOUT_MS</code>. See <strong>TESTING.md</strong>.
              </div>
            </div>
          ) : null}
          {singleLegTrip ? (
            <div style={{ fontSize: 12, color: "#444" }}>
              <div>
                Locked chargers:{" "}
                {lockedChargersByLeg[0]?.length
                  ? lockedChargersByLeg[0].join(", ")
                  : "(none)"}
              </div>
              <div>Locked hotel: {lockedHotelId ?? "(none)"}</div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "#888" }}>
              Charger/hotel locks are disabled while waypoints are set. Clear the waypoints box to lock
              chargers again; your previous single-segment locks are restored automatically.
            </div>
          )}
        </div>

        {error ? (
          <div style={{ marginTop: 12, color: "crimson" }}>
            {error}
          </div>
        ) : null}

        {error && /Planner request timed out after/i.test(error) ? (
          <div
            style={{
              marginTop: 10,
              padding: 12,
              background: "#fefce8",
              border: "1px solid #fde047",
              borderRadius: 6,
              fontSize: 12,
              color: "#713f12"
            }}
          >
            <strong>Why Debug has no provider timing, full solver list, or final itinerary</strong>
            <p style={{ margin: "8px 0 0 0", lineHeight: 1.45 }}>
              <code>debug.providerCalls</code>, full <code>debug.segmentsAttempted</code>, and the stop list only exist
              in the <strong>finished</strong> plan response. With the default <strong>blocking</strong>{" "}
              <code>POST /plan</code>, aborting discards that whole body. If you use{" "}
              <code>NEXT_PUBLIC_PLAN_USE_JOB</code>, you may have seen live <strong>checkpoint</strong> rows in{" "}
              <strong>Debug — plan-job checkpoints</strong> before abort; <code>debug.providerCalls</code> still arrives
              only in the final <code>result</code>.
            </p>
            <p style={{ margin: "8px 0 0 0", lineHeight: 1.45 }}>
              <strong>Road preview (teal line)</strong> uses separate <code>POST /route-preview</code> calls and can
              still appear above. If you see <strong>no</strong> approximate route after a timeout, Valhalla may be
              down/slow, or <code>NEXT_PUBLIC_ROUTE_PREVIEW_CLIENT_TIMEOUT_MS</code> is too low for multi-hop merges —
              see <strong>TESTING.md</strong> and <strong>VALHALLA.md</strong>.
            </p>
            <p style={{ margin: "8px 0 0 0", lineHeight: 1.45 }}>
              Long multi-stop trips often need <strong>5–10+ minutes</strong>. Raise{" "}
              <code>NEXT_PUBLIC_PLAN_CLIENT_TIMEOUT_MS</code> and <code>PLAN_TOTAL_TIMEOUT_MS</code> together (see{" "}
              <strong>TESTING.md</strong>), then rebuild the web app so the public env value is inlined.
            </p>
          </div>
        ) : null}

        {routePreview?.status === "ok" && routePreview.preview && plan?.status !== "ok" ? (
          <div
            style={{
              marginTop: 16,
              padding: 12,
              background: "#f0fdfa",
              border: "1px solid #99f6e4",
              borderRadius: 6
            }}
          >
            <h2 style={{ margin: "0 0 8px 0", fontSize: 15 }}>Approximate road route (preview)</h2>
            {loading && routePreview.status === "ok" ? (
              <p style={{ margin: "0 0 8px 0", fontSize: 12, color: "#0f766e" }}>
                <strong>Refining:</strong> EV least-time planner is still running; this road preview updates first.
              </p>
            ) : null}
            {routePreview.preview.partialPreviewMeta ? (
              <p style={{ margin: "0 0 8px 0", fontSize: 11, color: "#0f766e" }}>
                <strong>Multi-hop preview:</strong> line shows{" "}
                {routePreview.preview.partialPreviewMeta.loadedSegments} of{" "}
                {routePreview.preview.partialPreviewMeta.totalSegments} segment(s) so far — the map updates as each hop
                completes (first segment no longer waits for the slowest hop).
              </p>
            ) : null}
            <p style={{ margin: "0 0 8px 0", fontSize: 12, color: "#444" }}>
              Valhalla driving line (blue dashed on map) and turn-by-turn
              {parsedWaypoints.length === 0 ? (
                <>
                  {" "}
                  (first ~{routePreview.preview.horizon.maxMinutes} min of driving
                  {routePreview.preview.nextHorizon?.maneuvers?.length
                    ? `, plus a second ~${routePreview.preview.nextHorizon.maxMinutes} min chunk prefetched`
                    : ""}
                  )
                </>
              ) : (
                <> for each segment — same list after planning finishes</>
              )}
              . No EV charging or stops yet; the full itinerary appears when planning finishes.
            </p>
            <div
              style={{
                margin: "0 0 10px 0",
                padding: "8px 10px",
                fontSize: 11,
                color: "#065f46",
                background: "#ecfdf5",
                border: "1px solid #6ee7b7",
                borderRadius: 4
              }}
            >
              <strong>Next segment:</strong>{" "}
              {routePreview.preview.nextHorizon?.maneuvers?.length ? (
                <>
                  Following turns after the first horizon are <strong>prefetched</strong> (see second list below)—not
                  unknown while you read the first chunk.
                </>
              ) : (
                <>
                  No second turn list (route likely ends within the first horizon, or Valhalla returned no further
                  steps). Use the map line for corridor context beyond this text.
                </>
              )}
            </div>
            <p style={{ margin: "0 0 8px 0", fontSize: 11, color: "#666" }}>
              <strong>Beyond the first two chunks:</strong> longer legs still have more road than these lists. Follow
              the map line and wait for the full itinerary below for charging decisions.
            </p>
            <div style={{ fontSize: 12, color: "#333" }}>
              Trip (preview): ~{Math.round(routePreview.preview.tripTimeMinutes)} min driving · ~{" "}
              {Math.round(routePreview.preview.tripDistanceMiles * 10) / 10} mi
            </div>
            <h3 style={{ margin: "12px 0 6px 0", fontSize: 13 }}>Horizon (turn-by-turn)</h3>
            {routePreview.preview.horizon.maneuvers.length ? (
              <ol style={{ margin: 0, paddingLeft: 18 }}>
                {routePreview.preview.horizon.maneuvers.map((m, i) => (
                  <li
                    key={`${i}-${m.text.slice(0, 24)}`}
                    style={{
                      marginBottom: 10,
                      fontWeight: m.instructionType === "segment_heading" ? 600 : 400,
                      listStyleType: m.instructionType === "segment_heading" ? "none" : undefined,
                      marginLeft: m.instructionType === "segment_heading" ? -18 : undefined
                    }}
                  >
                    {m.text}
                  </li>
                ))}
              </ol>
            ) : (
              <div style={{ fontSize: 12, color: "#666" }}>No maneuver text from Valhalla for this clip.</div>
            )}
            {routePreview.preview.nextHorizon?.maneuvers?.length ? (
              <>
                <h3 style={{ margin: "14px 0 6px 0", fontSize: 13 }}>Next horizon (prefetched)</h3>
                <p style={{ margin: "0 0 6px 0", fontSize: 11, color: "#555" }}>
                  ~{routePreview.preview.nextHorizon.maxMinutes} min of driving after the first list (same route,
                  clipped from Valhalla).
                </p>
                <ol style={{ margin: 0, paddingLeft: 18 }}>
                  {routePreview.preview.nextHorizon.maneuvers.map((m, i) => (
                    <li
                      key={`nx-${i}-${m.text.slice(0, 24)}`}
                      style={{
                        marginBottom: 10,
                        fontWeight: m.instructionType === "segment_heading" ? 600 : 400,
                        listStyleType: m.instructionType === "segment_heading" ? "none" : undefined,
                        marginLeft: m.instructionType === "segment_heading" ? -18 : undefined
                      }}
                    >
                      {m.text}
                    </li>
                  ))}
                </ol>
              </>
            ) : null}
          </div>
        ) : null}

        {jobLiveSolverLegs !== null &&
          jobLiveRequestId &&
          loading &&
          jobLiveSolverLegs.some((leg) => Array.isArray(leg) && leg.length > 0) ? (
          <div style={{ marginTop: 16 }}>
            <h3 style={{ margin: "12px 0 6px 0", fontSize: 14 }}>Debug (MVP) — plan-job checkpoints</h3>
            <p style={{ fontSize: 12, color: "#555", marginBottom: 10 }}>
              Each row below is a <strong>checkpoint</strong>’s <code>attempt</code> (solver progress), not the full{" "}
              <code>debug</code> object. <code>partial_route</code> checkpoints update the itinerary above and are omitted
              here. Transport:{" "}
              {planJobUseSse() ? (
                <>
                  SSE <code>/plan/jobs/…/events</code>
                </>
              ) : (
                <>
                  <code>GET /plan/jobs/…</code> poll (set <code>NEXT_PUBLIC_PLAN_USE_SSE=false</code>)
                </>
              )}{" "}
              (<code>NEXT_PUBLIC_PLAN_USE_JOB</code>). Full <code>debug.*</code> ships with the <code>complete</code>{" "}
              result.
            </p>
            {jobLiveSolverLegs.length === 1 ? (
              <DebugSolverAttemptsList
                segments={jobLiveSolverLegs[0] ?? []}
                heading="Solver rows from checkpoints (live)"
                requestId={jobLiveRequestId}
                liveCheckpoints
                staggerMs={0}
              />
            ) : (
              jobLiveSolverLegs.map((segs, li) =>
                !Array.isArray(segs) || segs.length === 0 ? null : (
                  <DebugSolverAttemptsList
                    key={`${jobLiveRequestId}-job-leg-${li}`}
                    segments={segs}
                    heading={`Waypoint leg ${li + 1} · solver rows from checkpoints (live)`}
                    requestId={`${jobLiveRequestId}-leg-${li}`}
                    liveCheckpoints
                    staggerMs={0}
                  />
                )
              )
            )}
          </div>
        ) : null}

        {plan ? (
          <div style={{ marginTop: 16 }}>
            {(() => {
              const d = (plan.debug ?? {}) as Record<string, unknown>;
              const isPartialSnapshot = d.planJobPartialRoute === true;
              return isPartialSnapshot ? (
                <div
                  style={{
                    marginBottom: 8,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 8px",
                    borderRadius: 999,
                    border: "1px solid #facc15",
                    background: "#fef9c3",
                    color: "#854d0e",
                    fontSize: 11,
                    fontWeight: 700
                  }}
                  title="Incremental plan-job checkpoint; final itinerary may change."
                >
                  Partial snapshot
                </div>
              ) : null;
            })()}
            {isPartialPlanSnapshot ? (
              <div
                style={{
                  marginBottom: 8,
                  padding: "8px 10px",
                  borderRadius: 6,
                  border: "1px solid #fcd34d",
                  background: "#fffbeb",
                  color: "#92400e",
                  fontSize: 12
                }}
              >
                Showing a quick checkpoint while the solver runs. Candidate pins stay on the map from prefetch;
                final stops/charging replace this when solve completes.
              </div>
            ) : null}
            <h2 style={{ margin: "0 0 8px 0", fontSize: 16 }}>
              Itinerary
              {plan.status === "ok" && !isPartialPlanSnapshot ? (
                <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 600, color: "#15803d" }}>
                  — Full plan up to date
                </span>
              ) : null}
            </h2>
            <div style={{ fontFamily: "monospace", fontSize: 12, color: "#444" }}>
              {plan.totals ? (
                <div>
                  Total time (est): {Math.round(plan.totals.totalTimeMinutes / 60 * 10) / 10} hours
                </div>
              ) : null}
              <div style={{ marginTop: 8 }}>
                Stops: {plan.stops.length}
              </div>
            </div>
            {(() => {
              const map = mapRef.current;
              const stopTypeCounts = plan.stops.reduce<Record<string, number>>((acc, s) => {
                acc[s.type] = (acc[s.type] ?? 0) + 1;
                return acc;
              }, {});
              const poiStopsCount = plan.stops.filter(isLikelyPoiStop).length;
              const candidateChargerCount = candidatesForMap?.chargers?.length ?? 0;
              const candidateHotelCount = candidatesForMap?.hotels?.length ?? 0;
              const mapDiagnostics = map
                ? {
                  routeSource: Boolean(map.getSource("route-geojson")),
                  routeLayer: Boolean(map.getLayer("route-line")),
                  stopsFallbackSource: Boolean(map.getSource("stops-fallback-geojson")),
                  stopsFallbackCircle: Boolean(map.getLayer("stops-fallback-circle")),
                  stopsFallbackSleep: Boolean(map.getLayer("stops-fallback-sleep")),
                  candidatesFallbackSource: Boolean(map.getSource("candidates-fallback-geojson")),
                  candidatesFallbackChargers: Boolean(map.getLayer("candidates-fallback-chargers")),
                  candidatesFallbackHotels: Boolean(map.getLayer("candidates-fallback-hotels"))
                }
                : null;
              return (
                <div
                  style={{
                    marginTop: 8,
                    padding: 8,
                    border: "1px dashed #cbd5e1",
                    borderRadius: 6,
                    background: "#f8fafc",
                    fontFamily: "monospace",
                    fontSize: 11,
                    color: "#334155"
                  }}
                >
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>Render diagnostics</div>
                  <div>Stop types: {JSON.stringify(stopTypeCounts)}</div>
                  <div>POI stops (heuristic): {poiStopsCount}</div>
                  <div>
                    Markers refs: stops={markersRef.current.length}, candidates=
                    {candidateMarkersRef.current.length}
                  </div>
                  <div>
                    Candidate pools: chargers={candidateChargerCount}, hotels={candidateHotelCount}
                  </div>
                  <div>Map layers/sources: {JSON.stringify(mapDiagnostics)}</div>
                </div>
              );
            })()}
            <ol style={{ marginTop: 10 }}>
              {plan.stops.map((s, idx) => (
                <li key={`${s.id}-${idx}`}>
                  <strong>{s.type}</strong> —{" "}
                  {s.type === "sleep" && (s.meta as any)?.chargerFound
                    ? `${s.name} (EV charger: ${(s.meta as any)?.chargerName ?? "nearby"})`
                    : s.name}
                </li>
              ))}
            </ol>

            {plan.status === "ok" && plan.stops.filter((s) => s.type !== "start").length > 0 ? (
              <div
                style={{
                  marginTop: 10,
                  padding: 10,
                  background: "#f9fafb",
                  border: "1px solid #e5e7eb",
                  borderRadius: 6,
                  fontSize: 12,
                  color: "#4b5563"
                }}
              >
                <strong>Refinement anchors (§4):</strong> ordered stops after start —{" "}
                {plan.stops
                  .filter((s) => s.type !== "start")
                  .map((s) => `${s.type}: ${s.name}`)
                  .join(" → ")}
                . Each leg adds modeled drive/charge time in the segment table below.
              </div>
            ) : null}

            {plan.status === "ok" &&
              routePreview?.preview &&
              (routePreview.preview.horizon.maneuvers.length > 0 ||
                (routePreview.preview.nextHorizon?.maneuvers?.length ?? 0) > 0) ? (
              <div
                style={{
                  marginTop: 16,
                  padding: 12,
                  background: "#f0fdfa",
                  border: "1px solid #99f6e4",
                  borderRadius: 6
                }}
              >
                <h3 style={{ margin: "0 0 8px 0", fontSize: 14 }}>Road directions (Valhalla)</h3>
                <p style={{ margin: "0 0 8px 0", fontSize: 11, color: "#555" }}>
                  {parsedWaypoints.length === 0 ? (
                    <>
                      First ~{routePreview.preview.horizon.maxMinutes} min along the <strong>start→end</strong> road
                      corridor (same geometry as the blue line when the planner does not return per-leg road shapes)
                      {routePreview.preview.nextHorizon?.maneuvers?.length
                        ? `, plus a second ~${routePreview.preview.nextHorizon.maxMinutes} min chunk prefetched`
                        : ""}
                      .
                    </>
                  ) : (
                    <>
                      ~{routePreview.preview.horizon.maxMinutes} min of driving directions per segment (Valhalla
                      horizon), listed in order for <strong>each</strong> hop — same merged corridor as the blue line.
                      {routePreview.preview.nextHorizon?.maneuvers?.length
                        ? " A second horizon per segment is merged when available."
                        : ""}
                    </>
                  )}{" "}
                  Itinerary stops and charging are optimized separately.
                </p>
                <p style={{ margin: "0 0 8px 0", fontSize: 11, color: "#666" }}>
                  <strong>Beyond these two chunks:</strong> long legs still have more road than the maneuvers listed
                  here. Use the itinerary for stop timing and charging; the map line shows the full driving corridor.
                </p>
                {routePreview.preview.horizon.maneuvers.length ? (
                  <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#333" }}>
                    {routePreview.preview.horizon.maneuvers.map((m, i) => (
                      <li
                        key={`rv-${i}-${m.text.slice(0, 20)}`}
                        style={{
                          marginBottom: 8,
                          fontWeight: m.instructionType === "segment_heading" ? 600 : 400,
                          listStyleType: m.instructionType === "segment_heading" ? "none" : undefined,
                          marginLeft: m.instructionType === "segment_heading" ? -18 : undefined
                        }}
                      >
                        {m.text}
                      </li>
                    ))}
                  </ol>
                ) : null}
                {routePreview.preview.nextHorizon?.maneuvers?.length ? (
                  <>
                    <h4 style={{ margin: "12px 0 6px 0", fontSize: 12 }}>Next horizon (prefetched)</h4>
                    <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#333" }}>
                      {routePreview.preview.nextHorizon.maneuvers.map((m, i) => (
                        <li
                          key={`rv2-${i}-${m.text.slice(0, 20)}`}
                          style={{
                            marginBottom: 8,
                            fontWeight: m.instructionType === "segment_heading" ? 600 : 400,
                            listStyleType: m.instructionType === "segment_heading" ? "none" : undefined,
                            marginLeft: m.instructionType === "segment_heading" ? -18 : undefined
                          }}
                        >
                          {m.text}
                        </li>
                      ))}
                    </ol>
                  </>
                ) : null}
              </div>
            ) : null}

            <h3 style={{ margin: "16px 0 8px 0", fontSize: 14 }}>Segment-by-segment (planner)</h3>
            <p style={{ margin: "0 0 10px 0", fontSize: 11, color: "#666" }}>
              Estimated hops between stops from the planner (drive/charge times). When{" "}
              <strong>Road directions (Valhalla)</strong> appears above, use it for turn-by-turn on the road
              corridor.
            </p>
            {(() => {
              const legByPair = new Map(
                plan.legs.map((l) => [`${l.fromStopId}->${l.toStopId}`, l])
              );

              type DriveStep = {
                kind: "drive";
                day: number;
                from: ItineraryStop;
                to: ItineraryStop;
                travelMin?: number;
                chargeMin?: number;
              };
              type SleepStep = { kind: "sleep"; day: number; hotelName: string; chargerName?: string };
              const steps: Array<DriveStep | SleepStep> = [];

              const countPriorSleeps = (idx: number) => {
                let c = 0;
                for (let i = 0; i < idx; i++) {
                  if (plan.stops[i].type === "sleep") c++;
                }
                return c;
              };

              for (let i = 0; i < plan.stops.length - 1; i++) {
                const from = plan.stops[i];
                const to = plan.stops[i + 1];
                const day = 1 + countPriorSleeps(i);

                if (to.type === "sleep") {
                  steps.push({
                    kind: "sleep",
                    day,
                    hotelName: to.name,
                    chargerName: (to.meta as any)?.chargerName
                  });
                  continue;
                }

                const leg = legByPair.get(`${from.id}->${to.id}`);
                steps.push({
                  kind: "drive",
                  day,
                  from,
                  to,
                  travelMin: leg?.travelTimeMinutes,
                  chargeMin: leg?.chargeTimeMinutes
                });
              }

              // Render grouped by day with simple separators.
              let lastDay = -1;
              return (
                <div style={{ fontSize: 12, color: "#333" }}>
                  {steps.map((s, idx) => {
                    const key = `${s.kind}-${idx}`;
                    const needsHeader = s.day !== lastDay;
                    if (needsHeader) lastDay = s.day;
                    return (
                      <div key={key} style={{ marginBottom: 10 }}>
                        {needsHeader ? (
                          <div style={{ fontWeight: 700, marginBottom: 6 }}>
                            Day {s.day}
                          </div>
                        ) : null}
                        {s.kind === "sleep" ? (
                          <div>
                            Sleep: {s.hotelName} (8h)
                            {s.chargerName ? ` + Charge: ${s.chargerName}` : null}
                          </div>
                        ) : (
                          <div>
                            Drive: {s.from.name} → {s.to.name}
                            {typeof s.chargeMin === "number" ? ` (charge ~${Math.round(s.chargeMin)} min)` : null}
                            {typeof s.travelMin === "number" ? ` (drive ~${Math.round(s.travelMin)} min)` : null}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
            {mapDebugRangeLegs() && plan.status === "ok" && plan.rangeLegs && plan.rangeLegs.length > 0 ? (
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  background: "#ecfeff",
                  border: "1px solid #67e8f9",
                  borderRadius: 6,
                  fontSize: 12,
                  color: "#0e7490"
                }}
              >
                <h3 style={{ margin: "0 0 6px 0", fontSize: 14 }}>Range legs (debug)</h3>
                <p style={{ margin: "0 0 10px 0", fontSize: 11, color: "#155e75", lineHeight: 1.45 }}>
                  <strong>Dev-only:</strong> enable with <code>NEXT_PUBLIC_MAP_DEBUG_RANGE_LEGS=true</code> (see{" "}
                  <code>docs/WEB_SWITCHES.md</code>). Groups the itinerary at <strong>charge</strong> stops; the map may
                  use a multi-feature GeoJSON route source when the merged polyline splits cleanly (see{" "}
                  <code>rangeLegRouteFeatures.ts</code>). Same least-time solver —{" "}
                  <code>docs/designs/range-based-segments-intent.md</code>. Optional API columns{" "}
                  <strong>max hop / budget</strong> are chord sanity checks vs <code>EV_RANGE_MILES</code> +{" "}
                  <code>CHARGE_BUFFER_SOC</code>.
                </p>
                <p style={{ margin: "0 0 10px 0", fontSize: 11, color: "#155e75", lineHeight: 1.45 }}>
                  <strong>Timing:</strong> With default <strong>blocking</strong> <code>POST /plan</code>, the itinerary,
                  route line, and this panel appear <strong>together</strong> when the server finishes (long trips can
                  take many minutes). Set <code>NEXT_PUBLIC_PLAN_USE_JOB=true</code> to see <strong>checkpoint solver rows</strong>{" "}
                  in Debug while the job runs; the final route still arrives with <code>result</code>.
                </p>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", padding: "4px 8px 4px 0", color: "#0e7490" }}>#</th>
                      <th style={{ textAlign: "center", padding: 4, color: "#0e7490", width: 36 }}>
                        Line
                      </th>
                      <th style={{ textAlign: "left", padding: 4, color: "#0e7490" }}>From → to (stops)</th>
                      <th style={{ textAlign: "right", padding: 4, color: "#0e7490" }}>Drive min</th>
                      <th style={{ textAlign: "right", padding: 4, color: "#0e7490" }}>Charge min</th>
                      <th style={{ textAlign: "right", padding: 4, color: "#0e7490" }}>Chord mi ≈</th>
                      {(plan.rangeLegs ?? []).some((rl) => typeof rl.usableRangeMiles === "number") ? (
                        <>
                          <th style={{ textAlign: "right", padding: 4, color: "#0e7490" }}>Max hop mi ≈</th>
                          <th style={{ textAlign: "right", padding: 4, color: "#0e7490" }}>Range budget mi</th>
                        </>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {plan.rangeLegs.map((rl, legIdx) => (
                      <tr key={`${rl.fromStopId}-${rl.toStopId}-${rl.index}`}>
                        <td style={{ padding: "4px 8px 4px 0", verticalAlign: "top" }}>{rl.index + 1}</td>
                        <td style={{ padding: 4, verticalAlign: "top", textAlign: "center" }}>
                          <span
                            title="Route line on map (same blue for all legs)"
                            style={{
                              display: "inline-block",
                              width: 14,
                              height: 14,
                              borderRadius: 3,
                              border: "1px solid rgba(0,0,0,0.15)",
                              backgroundColor: COLORS.roadBlue,
                              verticalAlign: "middle"
                            }}
                          />
                        </td>
                        <td style={{ padding: 4, verticalAlign: "top" }}>
                          <span style={{ fontFamily: "monospace", fontSize: 10 }}>{rl.fromStopId}</span>
                          {" → "}
                          <span style={{ fontFamily: "monospace", fontSize: 10 }}>{rl.toStopId}</span>
                          <div style={{ fontSize: 10, color: "#64748b", marginTop: 4 }}>
                            {rl.stopIds.length} stops along leg
                          </div>
                        </td>
                        <td style={{ textAlign: "right", padding: 4, verticalAlign: "top" }}>
                          {Math.round(rl.travelTimeMinutes)}
                        </td>
                        <td style={{ textAlign: "right", padding: 4, verticalAlign: "top" }}>
                          {Math.round(rl.chargeTimeMinutes)}
                        </td>
                        <td style={{ textAlign: "right", padding: 4, verticalAlign: "top" }}>
                          {rl.chordMilesApprox.toFixed(1)}
                        </td>
                        {(plan.rangeLegs ?? []).some((rl) => typeof rl.usableRangeMiles === "number") ? (
                          <>
                            <td
                              style={{
                                textAlign: "right",
                                padding: 4,
                                verticalAlign: "top",
                                color: rl.maxHopExceedsRangeBudget ? "#b45309" : undefined
                              }}
                              title={
                                rl.maxHopExceedsRangeBudget
                                  ? "Largest straight-line sub-hop exceeds usable range (chord vs EV_RANGE + buffer)"
                                  : undefined
                              }
                            >
                              {typeof rl.maxHopChordMilesApprox === "number"
                                ? `${rl.maxHopChordMilesApprox.toFixed(1)}${rl.maxHopExceedsRangeBudget ? " ⚠" : ""}`
                                : "—"}
                            </td>
                            <td style={{ textAlign: "right", padding: 4, verticalAlign: "top" }}>
                              {typeof rl.usableRangeMiles === "number" ? rl.usableRangeMiles.toFixed(1) : "—"}
                            </td>
                          </>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {plan.message ? (
              <div style={{ marginTop: 12, padding: 10, background: "#fff3cd", border: "1px solid #ffe69c", borderRadius: 6 }}>
                {plan.message}
              </div>
            ) : null}
            {plan.debug ? (
              <div style={{ marginTop: 10 }}>
                <h3 style={{ margin: "12px 0 6px 0", fontSize: 14 }}>Debug (MVP)</h3>
                {(() => {
                  const d = plan.debug as Record<string, unknown>;
                  const sr = d.sourceRouting as Record<string, unknown> | undefined;
                  const pc = d.providerCalls as
                    | Record<
                      string,
                      {
                        calls?: number;
                        totalMs?: number;
                        avgMs?: number;
                        durationsMs?: unknown;
                      }
                    >
                    | undefined;
                  const segmentsAttempted = d.segmentsAttempted;
                  const multiLegDbg = d.multiLeg === true;
                  const legDebugList = multiLegDbg ? (d.legs as unknown[] | undefined) : undefined;

                  const rest: Record<string, unknown> = { ...d };
                  if (sr !== undefined) delete rest.sourceRouting;
                  if (pc !== undefined) delete rest.providerCalls;
                  if (segmentsAttempted !== undefined) delete rest.segmentsAttempted;
                  if (multiLegDbg && Array.isArray(d.legs)) delete rest.legs;
                  if (d.rangeLegs !== undefined) delete rest.rangeLegs;
                  const fmtAge = (h: unknown) => {
                    if (typeof h !== "number" || !Number.isFinite(h)) return null;
                    if (h >= 48) return `${(h / 24).toFixed(1)} d`;
                    return `${Math.round(h)} h`;
                  };

                  return (
                    <>
                      {sr && Object.keys(sr).length > 0 ? (
                        <div
                          style={{
                            marginBottom: 10,
                            padding: 12,
                            background: "#f0fdf4",
                            border: "1px solid #86efac",
                            borderRadius: 6,
                            fontSize: 12,
                            color: "#14532d"
                          }}
                        >
                          <div style={{ fontWeight: 600, marginBottom: 8 }}>Source routing (§2 trust)</div>
                          <table style={{ width: "100%", borderCollapse: "collapse" }}>
                            <tbody>
                              {sr.sourceRoutingMode != null ? (
                                <tr>
                                  <td style={{ padding: "4px 8px 4px 0", color: "#166534", verticalAlign: "top" }}>
                                    Configured mode
                                  </td>
                                  <td style={{ padding: "4px 0", fontFamily: "monospace" }}>
                                    {String(sr.sourceRoutingMode)}
                                  </td>
                                </tr>
                              ) : null}
                              {sr.effectiveSourceRoutingMode != null ? (
                                <tr>
                                  <td style={{ padding: "4px 8px 4px 0", color: "#166534", verticalAlign: "top" }}>
                                    Effective mode
                                  </td>
                                  <td style={{ padding: "4px 0", fontFamily: "monospace" }}>
                                    {String(sr.effectiveSourceRoutingMode)}
                                  </td>
                                </tr>
                              ) : null}
                              {sr.mirrorSnapshotId != null ? (
                                <tr>
                                  <td style={{ padding: "4px 8px 4px 0", color: "#166534", verticalAlign: "top" }}>
                                    Mirror snapshot
                                  </td>
                                  <td
                                    style={{ padding: "4px 0", fontFamily: "monospace", wordBreak: "break-all" }}
                                  >
                                    {String(sr.mirrorSnapshotId)}
                                  </td>
                                </tr>
                              ) : null}
                              {sr.mirrorSchemaVersion != null ? (
                                <tr>
                                  <td style={{ padding: "4px 8px 4px 0", color: "#166534", verticalAlign: "top" }}>
                                    Mirror schema
                                  </td>
                                  <td style={{ padding: "4px 0", fontFamily: "monospace" }}>
                                    {String(sr.mirrorSchemaVersion)}
                                  </td>
                                </tr>
                              ) : null}
                              {sr.mirrorCreatedAt != null ? (
                                <tr>
                                  <td style={{ padding: "4px 8px 4px 0", color: "#166534", verticalAlign: "top" }}>
                                    Snapshot time
                                  </td>
                                  <td style={{ padding: "4px 0", fontFamily: "monospace" }}>
                                    {String(sr.mirrorCreatedAt)}
                                  </td>
                                </tr>
                              ) : null}
                              {sr.mirrorAgeHours != null ? (
                                <tr>
                                  <td style={{ padding: "4px 8px 4px 0", color: "#166534", verticalAlign: "top" }}>
                                    Data age
                                  </td>
                                  <td style={{ padding: "4px 0", fontFamily: "monospace" }}>
                                    {fmtAge(sr.mirrorAgeHours) ?? String(sr.mirrorAgeHours)}
                                  </td>
                                </tr>
                              ) : null}
                            </tbody>
                          </table>
                          <p style={{ margin: "8px 0 0 0", fontSize: 11, color: "#15803d" }}>
                            Charger/POI tier follows <strong>effective mode</strong>. See ROUTING_UX_SPEC §2.
                          </p>
                        </div>
                      ) : null}
                      {Array.isArray(segmentsAttempted) && segmentsAttempted.length > 0 && !multiLegDbg ? (
                        <DebugSolverAttemptsList
                          segments={segmentsAttempted}
                          heading="Solver attempts (staggered readout)"
                          requestId={plan.requestId ?? "unknown"}
                        />
                      ) : null}
                      {multiLegDbg && Array.isArray(legDebugList) && legDebugList.length > 0
                        ? legDebugList.map((legDbg, li) => {
                          const lg =
                            legDbg && typeof legDbg === "object"
                              ? (legDbg as Record<string, unknown>)
                              : {};
                          const segs = lg.segmentsAttempted;
                          if (!Array.isArray(segs) || segs.length === 0) return null;
                          return (
                            <DebugSolverAttemptsList
                              key={`${plan.requestId ?? "unknown"}-solver-leg-${li}`}
                              segments={segs}
                              heading={`Waypoint leg ${li + 1} · solver attempts (staggered readout)`}
                              requestId={`${plan.requestId ?? "unknown"}-leg-${li}`}
                            />
                          );
                        })
                        : null}
                      {pc && typeof pc === "object" && Object.keys(pc).length > 0 ? (
                        <div
                          style={{
                            marginBottom: 10,
                            padding: 12,
                            background: "#eff6ff",
                            border: "1px solid #93c5fd",
                            borderRadius: 6,
                            fontSize: 12,
                            color: "#1e3a5f"
                          }}
                        >
                          <div style={{ fontWeight: 600, marginBottom: 8 }}>Provider HTTP timing</div>
                          <p style={{ margin: "0 0 8px 0", fontSize: 11, color: "#475569" }}>
                            Summaries from <code>debug.providerCalls</code> (Valhalla / NREL / Overpass / geocode). Full
                            per-call lists may appear in the JSON block below.
                          </p>
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                            <thead>
                              <tr>
                                <th style={{ textAlign: "left", padding: "4px 8px 4px 0", color: "#64748b" }}>
                                  Provider
                                </th>
                                <th style={{ textAlign: "right", padding: 4, color: "#64748b" }}>Calls</th>
                                <th style={{ textAlign: "right", padding: 4, color: "#64748b" }}>Total ms</th>
                                <th style={{ textAlign: "right", padding: 4, color: "#64748b" }}>Avg ms</th>
                              </tr>
                            </thead>
                            <tbody>
                              {Object.entries(pc).map(([k, row]) => {
                                if (!row || typeof row !== "object") return null;
                                const r = row as { calls?: number; totalMs?: number; avgMs?: number };
                                return (
                                  <tr key={k}>
                                    <td style={{ padding: "4px 8px 4px 0", fontFamily: "monospace" }}>{k}</td>
                                    <td style={{ textAlign: "right", padding: 4 }}>{r.calls ?? "—"}</td>
                                    <td style={{ textAlign: "right", padding: 4 }}>{r.totalMs ?? "—"}</td>
                                    <td style={{ textAlign: "right", padding: 4 }}>{r.avgMs ?? "—"}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      ) : null}
                      {Object.keys(rest).length > 0 ? (
                        <pre
                          style={{
                            whiteSpace: "pre-wrap",
                            fontSize: 11,
                            padding: 10,
                            background: "#f7f7f7",
                            border: "1px solid #e8e8e8",
                            borderRadius: 6
                          }}
                        >
                          {JSON.stringify(rest, null, 2)}
                        </pre>
                      ) : null}
                    </>
                  );
                })()}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div
        ref={mapEl}
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          minWidth: 0,
          minHeight: 0
        }}
      />
    </div>
  );
}

