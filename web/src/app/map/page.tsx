"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { ItineraryStop, PlanTripResponse } from "../../../../shared/types";

export default function MapPage() {
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);

  const [start, setStart] = useState("Raleigh, NC");
  const [end, setEnd] = useState("Seattle, WA");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanTripResponse | null>(null);

  // `NEXT_PUBLIC_API_BASE` is optional; default to local API for dev.
  const apiBase = useMemo(
    () => process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001",
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
    mapRef.current = map;
  }, []);

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
    map.fitBounds(
      [
        [bounds.minLon, bounds.minLat],
        [bounds.maxLon, bounds.maxLat]
      ],
      { padding: 40, duration: 0 }
    );

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
          paint: { "line-color": "#0b7cff", "line-width": 3 }
        });
      }
    }

    // Stop markers.
    for (const s of plan.stops) {
      const color =
        s.type === "start"
          ? "#1b6ef3"
          : s.type === "end"
            ? "#9b59b6"
            : s.type === "sleep"
              ? "#ff8c00"
              : "#00b894"; // charge
      const marker = new maplibregl.Marker({ color })
        .setLngLat([s.coords.lon, s.coords.lat])
        .addTo(map);
      markersRef.current.push(marker);
    }
  }, [plan]);

  async function onPlanTrip() {
    setLoading(true);
    setError(null);
    setPlan(null);
    try {
      const apiUrl = `${apiBase}/plan`;
      const resp = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start, end })
      });
      const json = (await resp.json()) as PlanTripResponse;
      if (!resp.ok) {
        // Keep the full error payload so we can surface `debug` in the UI.
        setPlan(json);
        throw new Error(json.message ?? "Planning failed");
      }
      setPlan(json);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Planning failed";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "420px 1fr", height: "100vh" }}>
      <div style={{ padding: 16, borderRight: "1px solid #e5e5e5", overflow: "auto" }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>EV Travel Planner (MVP)</h1>

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

          <button onClick={onPlanTrip} disabled={loading} style={{ padding: 10 }}>
            {loading ? "Planning..." : "Plan Trip"}
          </button>
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
              const stopById = new Map(plan.stops.map((s) => [s.id, s]));
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
      <div ref={mapEl} />
    </div>
  );
}

