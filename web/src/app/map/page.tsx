"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { ItineraryStop, PlanTripResponse } from "../../../../shared/types";

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
    for (const lid of ["route-line", "route-line-halo"]) {
      if (map.getLayer(lid)) map.removeLayer(lid);
    }
    if (map.getSource("route-geojson")) map.removeSource("route-geojson");
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
  /** Per-leg ordered charger locks (Slice 1 UI: single-leg trips only; multi-leg rows stay empty). */
  const [lockedChargersByLeg, setLockedChargersByLeg] = useState<string[][]>([[]]);
  const [lockedHotelId, setLockedHotelId] = useState<string | null>(null);

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

  useEffect(() => {
    setLockedChargersByLeg((prev) =>
      Array.from({ length: legCount }, (_, i) => prev[i] ?? [])
    );
  }, [legCount]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

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
    // MVP: expects the backend to return at least one leg geometry; if absent, draw straight segments between stops.
    const linePoints: Array<[number, number]> = [];
    for (const leg of plan.legs) {
      if (leg.geometry?.type === "LineString" && Array.isArray(leg.geometry.coordinates)) {
        for (const c of leg.geometry.coordinates) {
          linePoints.push([c[0], c[1]]);
        }
      }
    }

    if (linePoints.length >= 2) {
      map.addSource("route-geojson", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: linePoints
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
    } else {
      // Fallback: connect stops in order.
      const coords = plan.stops.map((s) => [s.coords.lon, s.coords.lat] as [number, number]);
      if (coords.length >= 2) {
        map.addSource("route-geojson", {
          type: "geojson",
          data: {
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: coords }
          }
        });
        map.addLayer({
          id: "route-line",
          type: "line",
          source: "route-geojson",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#0b7cff", "line-width": 5 }
        });
      }
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
  }, [plan]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const m of candidateMarkersRef.current) m.remove();
    candidateMarkersRef.current = [];
    if (!plan || plan.status !== "ok" || !plan.candidates) return;

    if (showChargerCandidates) {
      for (const c of plan.candidates.chargers) {
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
      for (const h of plan.candidates.hotels) {
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
    plan,
    showChargerCandidates,
    showHotelCandidates,
    singleLegTrip,
    lockedChargersByLeg,
    lockedHotelId
  ]);

  function classifyPlanError(e: unknown, resp: Response | null): string {
    if (e instanceof DOMException && e.name === "AbortError") {
      const ms = Number(process.env.NEXT_PUBLIC_PLAN_CLIENT_TIMEOUT_MS ?? 130000);
      return `Request timed out after ${Math.round(ms / 1000)}s. Try a shorter route or retry.`;
    }
    if (e instanceof TypeError && /fetch|Load failed|NetworkError/i.test(String(e.message))) {
      return "Network error: could not reach the planner API. Check that the API is running and CORS allows this origin.";
    }
    if (resp?.status === 408) {
      return "The planner took too long (server time limit). Try a shorter route or retry later.";
    }
    if (resp?.status === 400 || resp?.status === 500 || resp?.status === 502) {
      return e instanceof Error ? e.message : "Planning failed";
    }
    return e instanceof Error ? e.message : "Planning failed";
  }

  async function onPlanTrip() {
    clearMapPlanArtifacts();
    setLoading(true);
    setError(null);
    setPlan(null);
    const clientMs = Number(process.env.NEXT_PUBLIC_PLAN_CLIENT_TIMEOUT_MS ?? 130000);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), clientMs);
    let resp: Response | null = null;
    try {
      const apiUrl = `${apiBase.replace(/\/$/, "")}/plan`;
      const wps = parsedWaypoints;
      const locks = lockedChargersByLeg.slice(0, legCount).map((r) => [...r]);
      const hasLocks = locks.some((r) => r.length > 0);
      const body: Record<string, unknown> = {
        start,
        end,
        includeCandidates: true,
        ...(wps.length ? { waypoints: wps } : {}),
        ...(hasLocks ? { lockedChargersByLeg: locks } : {}),
        ...(lockedHotelId ? { lockedHotelId } : {})
      };
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
    } catch (e) {
      setError(classifyPlanError(e, resp));
    } finally {
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
          Along-route charger + hotel candidates (when returned by the API) appear as green / coral markers; the
          itinerary uses blue / purple / orange / green for stops.
        </p>
        <p style={{ margin: "8px 0 0 0", fontSize: 12, color: "#555" }}>
          <strong>Locks (single segment only):</strong> click a green charger to require it on the route; click
          coral hotel to prefer it for overnight (when needed). Clear locks by clicking again. Multi-stop waypoints
          disable map locking for now.
        </p>

        <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
          <label>
            <div style={{ marginBottom: 6 }}>Start</div>
            <input
              value={start}
              onChange={(e) => setStart(e.target.value)}
              style={{ width: "100%", padding: 8 }}
            />
          </label>
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
              Add locks after clearing waypoints (single driving segment only in this UI).
            </div>
          )}
        </div>

        {error ? (
          <div style={{ marginTop: 12, color: "crimson" }}>
            {error}
          </div>
        ) : null}

        {plan ? (
          <div style={{ marginTop: 16 }}>
            <h2 style={{ margin: "0 0 8px 0", fontSize: 16 }}>Itinerary</h2>
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

            <h3 style={{ margin: "16px 0 8px 0", fontSize: 14 }}>Turn-by-turn (MVP)</h3>
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

