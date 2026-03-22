"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type {
  CandidatesApiResponse,
  ItineraryStop,
  PlanTripCandidates,
  PlanTripResponse,
  RoutePreviewApiResponse
} from "../../../../shared/types";
import { fetchMergedRoutePreview, routePreviewSegmentChain } from "../../lib/mergeRoutePreview";

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

export default function MapPage() {
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const candidateMarkersRef = useRef<maplibregl.Marker[]>([]);

  /** F1: clear route + markers immediately on replan (before async state updates). */
  function clearMapPlanArtifacts() {
    const map = mapRef.current;
    if (!map) return;
    for (const m of markersRef.current) m.remove();
    markersRef.current = [];
    for (const m of candidateMarkersRef.current) m.remove();
    candidateMarkersRef.current = [];
    for (const lid of [
      "route-line",
      "route-line-halo",
      "route-preview-line",
      "route-preview-line-halo"
    ]) {
      if (map.getLayer(lid)) map.removeLayer(lid);
    }
    if (map.getSource("route-geojson")) map.removeSource("route-geojson");
    if (map.getSource("route-preview-geojson")) map.removeSource("route-preview-geojson");
  }

  const [start, setStart] = useState("Raleigh, NC");
  const [end, setEnd] = useState("Seattle, WA");
  /** One destination per line (optional). Chained as ordered waypoints between start and end. */
  const [waypointsText, setWaypointsText] = useState("");
  const [showChargerCandidates, setShowChargerCandidates] = useState(true);
  const [showHotelCandidates, setShowHotelCandidates] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanTripResponse | null>(null);
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

  /** Slice 4 Phase 3: honest “what’s running” vs a flat “Planning…” (ROUTING_UX_SPEC §7). */
  const planningButtonLabel = useMemo(() => {
    if (!loading) return "Plan Trip";
    if (routePreviewPending) return "Road preview…";
    return "Planning trip…";
  }, [loading, routePreviewPending]);

  const planningLoadingHelp = useMemo(() => {
    if (!loading) return null;
    if (routePreviewPending) {
      return "Fetching Valhalla road preview (runs in parallel with the EV planner).";
    }
    return "EV least-time planner running (chargers, stops, times).";
  }, [loading, routePreviewPending]);

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

    // Clear Slice 4 preview layers whenever this effect runs (plan or no plan).
    for (const lid of ["route-preview-line", "route-preview-line-halo"]) {
      if (map.getLayer(lid)) map.removeLayer(lid);
    }
    if (map.getSource("route-preview-geojson")) map.removeSource("route-preview-geojson");

    // Clear previous visualization layers.
    const layersToRemove = ["route-line", "route-line-halo"];
    for (const lid of layersToRemove) {
      if (map.getLayer(lid)) map.removeLayer(lid);
    }
    const sourcesToRemove = ["route-geojson"];
    for (const sid of sourcesToRemove) {
      if (map.getSource(sid)) map.removeSource(sid);
    }

    // Markers: simplest MVP—remove any previous markers by rebuilding after each plan.
    // (In production, keep marker refs to avoid churn.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

    // Clear markers from previous plan render.
    for (const m of markersRef.current) m.remove();
    markersRef.current = [];

    // Fit view to stops.
    const bounds = plan.stops.reduce(
      (acc, s) => {
        acc.minLon = Math.min(acc.minLon, s.coords.lon);
        acc.maxLon = Math.max(acc.maxLon, s.coords.lon);
        acc.minLat = Math.min(acc.minLat, s.coords.lat);
        acc.maxLat = Math.max(acc.maxLat, s.coords.lat);
        return acc;
      },
      { minLon: 180, maxLon: -180, minLat: 90, maxLat: -90 }
    );
    const spanLon = bounds.maxLon - bounds.minLon;
    const spanLat = bounds.maxLat - bounds.minLat;
    if (Number.isFinite(spanLon) && Number.isFinite(spanLat) && spanLon > 0 && spanLat > 0) {
      map.fitBounds(
        [
          [bounds.minLon, bounds.minLat],
          [bounds.maxLon, bounds.maxLat]
        ],
        { padding: 40, duration: 0 }
      );
    }
    map.resize();

    // Route geometry.
    // For normal trips (replan off) prefer merged `POST /route-preview` polylines over any per-leg geometry —
    // solver legs may carry straight chord LineStrings that would incorrectly win here.
    const previewPoly =
      routePreview?.status === "ok" && routePreview.preview?.polyline?.coordinates?.length
        ? routePreview.preview.polyline
        : null;
    const preferPreviewPolyline =
      replanMode === "off" && previewPoly && previewPoly.coordinates.length >= 2;

    /** Plan may return before route-preview; avoid a flash of straight chords while preview is loading. */
    const suppressChordUntilPreview =
      replanMode === "off" && routePreviewPending && !previewPoly;

    const linePoints: Array<[number, number]> = [];
    for (const leg of plan.legs) {
      if (leg.geometry?.type === "LineString" && Array.isArray(leg.geometry.coordinates)) {
        for (const c of leg.geometry.coordinates) {
          linePoints.push([c[0], c[1]]);
        }
      }
    }

    let routeCoords: Array<[number, number]> = [];
    if (preferPreviewPolyline && previewPoly) {
      routeCoords = previewPoly.coordinates as Array<[number, number]>;
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

    if (routeCoords.length >= 2) {
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
        paint: { "line-color": "#0b7cff", "line-width": 5 }
      });
    }

    // Candidate markers are handled in a separate effect (layers + toggles).

    // Stop markers.
    for (const s of plan.stops) {
      const color =
        s.type === "start"
          ? "#1b6ef3"
          : s.type === "end"
            ? "#9b59b6"
            : s.type === "waypoint"
              ? "#6c5ce7"
              : s.type === "sleep"
                ? "#ff8c00"
                : "#00b894"; // charge
      const marker = new maplibregl.Marker({ color })
        .setLngLat([s.coords.lon, s.coords.lat])
        .addTo(map);
      markersRef.current.push(marker);
    }
  }, [plan, routePreview, singleLegTrip, replanMode, routePreviewPending]);

  /** Slice 4: draw approximate road line from `POST /route-preview` until a successful plan replaces it. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const lid of ["route-preview-line", "route-preview-line-halo"]) {
      if (map.getLayer(lid)) map.removeLayer(lid);
    }
    if (map.getSource("route-preview-geojson")) map.removeSource("route-preview-geojson");

    if (plan?.status === "ok") return;

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
        "line-color": "#0d9488",
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
    if (Number.isFinite(spanLon) && Number.isFinite(spanLat) && spanLon > 0 && spanLat > 0) {
      map.fitBounds(
        [
          [minLon, minLat],
          [maxLon, maxLat]
        ],
        { padding: 40, duration: 0 }
      );
    }
    map.resize();
  }, [plan, routePreview]);

  const candidatesForMap: PlanTripCandidates | null =
    plan?.status === "ok" && plan.candidates ? plan.candidates : candidatePreview;

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const m of candidateMarkersRef.current) m.remove();
    candidateMarkersRef.current = [];
    if (!candidatesForMap) return;

    if (showChargerCandidates) {
      for (const c of candidatesForMap.chargers) {
        const locked =
          singleLegTrip && lockedChargersByLeg[0]?.includes(c.id);
        const marker = new maplibregl.Marker({
          color: locked ? "#14532d" : "#2d8a5e"
        })
          .setLngLat([c.coords.lon, c.coords.lat])
          .addTo(map);
        const el = marker.getElement();
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
        const sel = singleLegTrip && lockedHotelId === h.id;
        const marker = new maplibregl.Marker({
          color: sel ? "#922b21" : "#e17055"
        })
          .setLngLat([h.coords.lon, h.coords.lat])
          .addTo(map);
        const el = marker.getElement();
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
  }, [
    candidatesForMap,
    showChargerCandidates,
    showHotelCandidates,
    singleLegTrip,
    lockedChargersByLeg,
    lockedHotelId
  ]);

  function humanizePlannerMessage(msg: string): string {
    if (/Valhalla fetch failed|Valhalla route|\/route\b/i.test(msg)) {
      return `${msg} — Start Valhalla locally or set VALHALLA_BASE_URL in the API .env (e.g. http://localhost:8002).`;
    }
    return msg;
  }

  function classifyPlanError(e: unknown, resp: Response | null): string {
    if (e instanceof DOMException && e.name === "AbortError") {
      const ms = Number(process.env.NEXT_PUBLIC_PLAN_CLIENT_TIMEOUT_MS ?? 130000);
      return `Planner request timed out after ${Math.round(ms / 1000)}s (NEXT_PUBLIC_PLAN_CLIENT_TIMEOUT_MS). Long multi-stop trips often need a higher limit and PLAN_TOTAL_TIMEOUT_MS on the API — see TESTING.md.`;
    }
    if (e instanceof TypeError && /fetch|Load failed|NetworkError/i.test(String(e.message))) {
      return "Network error: could not reach the planner API. Check that the API is running and CORS allows this origin.";
    }
    if (resp?.status === 408) {
      return "The planner took too long (server time limit). Try a shorter route or retry later.";
    }
    if (resp?.status === 400 || resp?.status === 500 || resp?.status === 502) {
      const raw = e instanceof Error ? e.message : "Planning failed";
      return humanizePlannerMessage(raw);
    }
    const raw = e instanceof Error ? e.message : "Planning failed";
    return humanizePlannerMessage(raw);
  }

  async function onPlanTrip() {
    clearMapPlanArtifacts();
    setLoading(true);
    setError(null);
    setCandidatePreview(null);
    setRoutePreview(null);
    /** Slice 2 `replanFrom.stopId` needs stops from the prior plan — capture before clearing UI state. */
    const priorPlanForReplan = plan;
    setPlan(null);
    const clientMs = Number(process.env.NEXT_PUBLIC_PLAN_CLIENT_TIMEOUT_MS ?? 130000);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), clientMs);
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
      const hasLocks = locks.some((r) => r.length > 0);
      const body: Record<string, unknown> = {
        end,
        includeCandidates: true,
        ...(wps.length ? { waypoints: wps } : {}),
        ...(hasLocks ? { lockedChargersByLeg: locks } : {}),
        ...(lockedHotelId ? { lockedHotelId } : {})
      };

      const candidatesBody: Record<string, unknown> = {
        end,
        ...(wps.length ? { waypoints: wps } : {})
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

      const routePreviewTimeoutMs = Number(
        process.env.NEXT_PUBLIC_ROUTE_PREVIEW_CLIENT_TIMEOUT_MS ?? 180000
      );
      const routePreviewAbort = abortSignalAfterMs(routePreviewTimeoutMs);

      /** Run in parallel with /plan; single-leg = one request, waypoints = one request per hop (merged). */
      const routePreviewPromise: Promise<RoutePreviewApiResponse | null> =
        shouldPrefetchPreview
          ? fetchMergedRoutePreview(apiBase, previewChain, routePreviewAbort)
          : Promise.resolve(null);

      /** Failsafe: if fetches hang without rejecting, still clear pending so the map can draw chord/leg geometry. */
      pendingFailsafeTimer = window.setTimeout(() => {
        if (routePreviewGen !== routePreviewRequestGenRef.current) return;
        setRoutePreviewPending(false);
      }, routePreviewTimeoutMs + 5000);

      void routePreviewPromise
        .then((previewJson) => {
          if (routePreviewGen !== routePreviewRequestGenRef.current) return;
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
    } catch (e) {
      setRoutePreviewPending(false);
      setError(classifyPlanError(e, resp));
    } finally {
      if (pendingFailsafeTimer !== undefined) window.clearTimeout(pendingFailsafeTimer);
      window.clearTimeout(timer);
      setLoading(false);
    }
  }

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
          Along-route charger + hotel candidates appear as green / coral markers (Slice 3: requested early via{" "}
          <code>POST /candidates</code> in parallel with <code>/plan</code> unless{" "}
          <code>NEXT_PUBLIC_PREFETCH_CANDIDATES=false</code>). <strong>Slice 4:</strong> normal trips (start + optional
          waypoints + end) fetch <code>POST /route-preview</code> per hop and merge (teal dashed line + horizon turn list) unless{" "}
          <code>NEXT_PUBLIC_PREFETCH_ROUTE_PREVIEW=false</code>. Itinerary stops use blue / purple / orange / green.
        </p>
        <p style={{ margin: "8px 0 0 0", fontSize: 12, color: "#555" }}>
          <strong>Locks (single segment only):</strong> click a green charger to require it on the route; click
          coral hotel to prefer it for overnight (when needed). Clear locks by clicking again. Multi-stop waypoints
          disable map locking for now.
        </p>

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
                {(plan?.stops ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
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

          <button onClick={onPlanTrip} disabled={loading} style={{ padding: 10 }}>
            {loading ? "Planning..." : "Plan Trip"}
          </button>
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
            <p style={{ margin: "0 0 8px 0", fontSize: 12, color: "#444" }}>
              Valhalla driving line (teal dashed on map) and turn-by-turn
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

        {plan ? (
          <div style={{ marginTop: 16 }}>
            <h2 style={{ margin: "0 0 8px 0", fontSize: 16 }}>
              Itinerary
              {plan.status === "ok" ? (
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
            <ol style={{ marginTop: 10 }}>
              {plan.stops.map((s) => (
                <li key={s.id}>
                  <strong>{s.type}</strong> —{" "}
                  {s.type === "sleep" && (s.meta as any)?.chargerFound
                    ? `${s.name} (EV charger: ${(s.meta as any)?.chargerName ?? "nearby"})`
                    : s.name}
                </li>
              ))}
            </ol>

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
            {plan.message ? (
              <div style={{ marginTop: 12, padding: 10, background: "#fff3cd", border: "1px solid #ffe69c", borderRadius: 6 }}>
                {plan.message}
              </div>
            ) : null}
            {plan.debug ? (
              <div style={{ marginTop: 10 }}>
                <h3 style={{ margin: "12px 0 6px 0", fontSize: 14 }}>Debug (MVP)</h3>
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
                  {JSON.stringify(plan.debug, null, 2)}
                </pre>
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

