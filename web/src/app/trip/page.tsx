"use client";

import React, { useCallback, useRef, useState } from "react";
import { MapCanvas } from "../../components/MapCanvas";
import type { StopFeatureCollection } from "../../components/MapCanvas";
import { getCandidates, getRoutePreview, planTrip, ApiError } from "../../../../shared/api-client";
import type { PlanTripCandidates, PlanTripResponse, RoutePreviewApiResponse } from "../../../../shared/types";
import type { ItineraryStop } from "../../../../shared/types";

// ─── API base URL ─────────────────────────────────────────────────────────────

function resolveApiBase(): string {
  const fromEnv = (process.env.NEXT_PUBLIC_API_BASE ?? "").trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:3001`;
  }
  return "http://localhost:3001";
}

// ─── Stop colour helpers ──────────────────────────────────────────────────────

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const n = Number(v); if (Number.isFinite(n)) return n; }
  return null;
}

function stopColor(stop: ItineraryStop): string {
  const meta = (stop.meta ?? {}) as Record<string, unknown>;
  if (stop.type === "start") return "#1b6ef3";
  if (stop.type === "end") return "#9b59b6";
  if (stop.type === "waypoint") return "#6c5ce7";
  if (stop.type === "sleep") {
    return Boolean(meta.chargerFound) ? "#c53030" : "#1e90ff";
  }
  // charge stop — teal shade by power level
  const kw = toNum(meta.chargerMaxPowerKw ?? meta.maxPowerKw);
  return kw !== null && kw > 0 && kw < 50 ? "#7fd8d4" : "#39a6a1";
}

function stopsToFeatures(stops: ItineraryStop[]): StopFeatureCollection {
  return {
    type: "FeatureCollection",
    features: stops
      .filter((s) => {
        const lat = toNum(s.coords?.lat);
        const lon = toNum(s.coords?.lon);
        return lat !== null && lon !== null;
      })
      .map((s) => ({
        type: "Feature" as const,
        properties: { stopType: s.type, color: stopColor(s) },
        geometry: {
          type: "Point" as const,
          coordinates: [Number(s.coords.lon), Number(s.coords.lat)] as [number, number],
        },
      })),
  };
}

function planToRoadCoords(plan: PlanTripResponse): [number, number][] {
  const coords: [number, number][] = [];
  for (const leg of plan.legs ?? []) {
    if (leg.geometry?.type === "LineString") {
      for (const c of leg.geometry.coordinates) coords.push([c[0], c[1]]);
    }
  }
  return coords;
}

function planToChordCoords(plan: PlanTripResponse): [number, number][] {
  return (plan.stops ?? [])
    .filter((s) => toNum(s.coords?.lat) !== null && toNum(s.coords?.lon) !== null)
    .map((s) => [Number(s.coords.lon), Number(s.coords.lat)]);
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmtMinutes(min: number | undefined): string {
  if (!min || min <= 0) return "";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function stopTypeLabel(type: ItineraryStop["type"]): string {
  switch (type) {
    case "start": return "Start";
    case "end": return "Destination";
    case "charge": return "Charging stop";
    case "sleep": return "Overnight stop";
    case "waypoint": return "Waypoint";
  }
}

function stopIcon(type: ItineraryStop["type"]): string {
  return type === "sleep" ? "◆" : "●";
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function TripPage() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [plan, setPlan] = useState<PlanTripResponse | null>(null);
  const [candidates, setCandidates] = useState<PlanTripCandidates | null>(null);
  const [routePreview, setRoutePreview] = useState<RoutePreviewApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const elapsedRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimFrom = from.trim();
      const trimTo = to.trim();
      if (!trimFrom || !trimTo) return;

      // Cancel any in-flight request
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // Reset state
      setPlan(null);
      setCandidates(null);
      setRoutePreview(null);
      setError(null);
      setElapsed(0);
      setLoading(true);

      const startedAt = Date.now();
      elapsedRef.current = window.setInterval(() => {
        setElapsed(Math.floor((Date.now() - startedAt) / 1000));
      }, 1000);

      const base = resolveApiBase();
      const opts = { baseUrl: base, signal: controller.signal };

      // Fire route preview in parallel — fast Valhalla call gives a dashed
      // preview line on the map before the EV solver finishes.
      void getRoutePreview({ start: trimFrom, end: trimTo }, opts)
        .then((r) => { if (!controller.signal.aborted) setRoutePreview(r); })
        .catch(() => { /* preview failure is non-fatal */ });

      // Fire candidates in parallel — pins can appear before /plan finishes.
      void getCandidates({ start: trimFrom, end: trimTo }, opts)
        .then((r) => {
          if (!controller.signal.aborted && r.status === "ok" && r.candidates) {
            setCandidates(r.candidates);
          }
        })
        .catch(() => { /* non-fatal */ });

      try {
        const result = await planTrip({ start: trimFrom, end: trimTo }, opts);
        setPlan(result);
        if (result.status !== "ok") {
          setError(result.message ?? "Planning failed — no feasible route found.");
        }
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        if (err instanceof ApiError) {
          setError(err.message || `Request failed (HTTP ${err.status})`);
        } else if (err instanceof TypeError) {
          setError("Could not reach the planning API. Is it running?");
        } else {
          setError(err instanceof Error ? err.message : "An unexpected error occurred.");
        }
      } finally {
        window.clearInterval(elapsedRef.current ?? undefined);
        setLoading(false);
      }
    },
    [from, to]
  );

  // Derive map props from current state.
  // Priority: actual leg road geometry > route-preview polyline > stop chord.
  // Route-preview is shown as a dashed line during loading, and folded into
  // routeCoords (solid line) after the plan completes when leg geometry is absent.
  const planRoadCoords: [number, number][] =
    plan?.status === "ok" ? planToRoadCoords(plan) : [];

  const previewPolyCoords: [number, number][] =
    routePreview?.status === "ok"
      ? (routePreview.preview?.polyline?.coordinates as [number, number][] | undefined) ?? []
      : [];

  const routeCoords: [number, number][] = (() => {
    if (plan?.status !== "ok") return [];
    if (planRoadCoords.length >= 2) return planRoadCoords;
    // Prefer road-following route-preview over straight chord
    if (previewPolyCoords.length >= 2) return previewPolyCoords;
    return planToChordCoords(plan);
  })();

  // Dashed preview shown during loading only (before plan arrives)
  const routePreviewCoords: [number, number][] =
    !plan && previewPolyCoords.length >= 2 ? previewPolyCoords : [];

  const stopFeatures: StopFeatureCollection | null =
    plan?.status === "ok" && (plan.stops?.length ?? 0) > 0
      ? stopsToFeatures(plan.stops)
      : null;

  const totals = plan?.status === "ok" ? plan.totals : null;

  return (
    <div style={{ display: "flex", height: "100dvh", fontFamily: "system-ui, sans-serif", background: "#f9fafb" }}>

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <div style={{
        width: 320,
        minWidth: 280,
        display: "flex",
        flexDirection: "column",
        background: "#ffffff",
        borderRight: "1px solid #e5e7eb",
        overflow: "hidden",
      }}>

        {/* Header */}
        <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid #f3f4f6" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#111827", letterSpacing: "-0.3px" }}>
            EV Trip Planner
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ padding: "16px 20px", borderBottom: "1px solid #f3f4f6" }}>
          <label style={labelStyle}>
            From
            <input
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="e.g. Charlotte, NC"
              disabled={loading}
              style={inputStyle}
            />
          </label>
          <label style={{ ...labelStyle, marginTop: 10 }}>
            To
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="e.g. Seattle, WA"
              disabled={loading}
              style={inputStyle}
            />
          </label>
          <button
            type="submit"
            disabled={loading || !from.trim() || !to.trim()}
            style={buttonStyle(loading || !from.trim() || !to.trim())}
          >
            {loading ? `Planning… ${elapsed}s` : "Plan Trip"}
          </button>
        </form>

        {/* Error */}
        {error && !loading && (
          <div style={{
            margin: "12px 20px 0",
            padding: "10px 14px",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 8,
            fontSize: 13,
            color: "#b91c1c",
            lineHeight: 1.5,
          }}>
            {error}
          </div>
        )}

        {/* Summary */}
        {totals && (
          <div style={{
            padding: "12px 20px",
            borderBottom: "1px solid #f3f4f6",
            display: "flex",
            gap: 16,
          }}>
            <Stat label="Drive" value={fmtMinutes(totals.travelTimeMinutes)} />
            <Stat label="Charge" value={fmtMinutes(totals.chargeTimeMinutes)} />
            {totals.overnightStopsCount > 0 && (
              <Stat label="Nights" value={String(totals.overnightStopsCount)} />
            )}
            <Stat label="Total" value={fmtMinutes(totals.totalTimeMinutes)} />
          </div>
        )}

        {/* Itinerary */}
        {plan?.status === "ok" && plan.stops.length > 0 && (
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 20px" }}>
            {plan.stops.map((stop, i) => {
              const leg = plan.legs?.[i - 1];
              return (
                <div key={stop.id} style={{ display: "flex", gap: 10, marginBottom: 14 }}>
                  <div style={{
                    fontSize: 14,
                    color: stopColor(stop),
                    marginTop: 2,
                    flexShrink: 0,
                    width: 14,
                    textAlign: "center",
                  }}>
                    {stopIcon(stop.type)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#111827", lineHeight: 1.3 }}>
                      {stop.name}
                    </div>
                    <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                      {stopTypeLabel(stop.type)}
                      {leg && (
                        <>
                          {leg.travelTimeMinutes ? ` · Drive ${fmtMinutes(leg.travelTimeMinutes)}` : ""}
                          {leg.chargeTimeMinutes ? ` · Charge ${fmtMinutes(leg.chargeTimeMinutes)}` : ""}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Candidate hint */}
        {candidates && !plan && loading && (
          <div style={{ padding: "12px 20px", fontSize: 12, color: "#9ca3af" }}>
            Found {candidates.chargers.length} charger{candidates.chargers.length !== 1 ? "s" : ""} along route
          </div>
        )}

        {/* Dev tool link */}
        <div style={{ padding: "10px 20px", borderTop: "1px solid #f3f4f6", marginTop: "auto" }}>
          <a href="/map" style={{ fontSize: 11, color: "#9ca3af", textDecoration: "none" }}>
            Developer tool →
          </a>
        </div>
      </div>

      {/* ── Map ─────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
        <MapCanvas
          routeCoords={routeCoords.length >= 2 ? routeCoords : undefined}
          routePreviewCoords={routePreviewCoords.length >= 2 ? routePreviewCoords : undefined}
          stopFeatures={stopFeatures ?? undefined}
          style={{ width: "100%", height: "100%" }}
        />
      </div>

    </div>
  );
}

// ─── Small UI components ──────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>{value}</div>
      <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 1 }}>{label}</div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  fontSize: 12,
  fontWeight: 600,
  color: "#374151",
  gap: 4,
};

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  fontSize: 13,
  color: "#111827",
  background: "#fff",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

function buttonStyle(disabled: boolean): React.CSSProperties {
  return {
    marginTop: 12,
    width: "100%",
    padding: "9px 0",
    background: disabled ? "#e5e7eb" : "#1a73e8",
    color: disabled ? "#9ca3af" : "#ffffff",
    border: "none",
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    transition: "background 0.15s",
  };
}
