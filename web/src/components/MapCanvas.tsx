"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// ─── Constants ───────────────────────────────────────────────────────────────

const STYLE_URL = "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json";
const DEFAULT_CENTER: [number, number] = [-97.0, 38.0];
const DEFAULT_ZOOM = 3;

/** Blue used for both the solid route line and the dashed preview line. */
export const ROUTE_BLUE = "#0b7cff";

// ─── Source / layer IDs ───────────────────────────────────────────────────────
//
// Prefixed with "mc-" to avoid collisions with any layers that the host page
// adds via the onMapReady escape hatch (e.g. /map dev tool's own route layers).

const SRC_ROUTE = "mc-route";
const SRC_PREVIEW = "mc-preview";
const SRC_STOPS = "mc-stops";

const LAYERS_ROUTE = ["mc-route-halo", "mc-route-line"] as const;
const LAYERS_PREVIEW = ["mc-preview-halo", "mc-preview-line"] as const;
const LAYERS_STOPS = ["mc-stops-circle", "mc-stops-sleep"] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StopFeature {
  type: "Feature";
  properties: { stopType: string; color: string };
  geometry: { type: "Point"; coordinates: [number, number] };
}

export interface StopFeatureCollection {
  type: "FeatureCollection";
  features: StopFeature[];
}

export interface MapCanvasProps {
  /**
   * Completed plan route coordinates (solid blue line).
   * Pass an empty array or undefined to clear.
   */
  routeCoords?: [number, number][];

  /**
   * Route preview coordinates shown while planning (dashed blue line).
   * Cleared automatically when routeCoords has content.
   */
  routePreviewCoords?: [number, number][];

  /**
   * Stop dots. Each feature needs `properties.stopType` and `properties.color`.
   * MapCanvas auto-fits the viewport to the stop bounds on first non-empty render.
   */
  stopFeatures?: StopFeatureCollection | null;

  /**
   * Escape hatch for pages that manage their own layers (e.g. /map dev tool).
   * Called once after the map finishes loading. The host page receives the
   * Map instance and is responsible for all its own source/layer management.
   *
   * When this prop is provided the data props (routeCoords, routePreviewCoords,
   * stopFeatures) are IGNORED — the host page owns the map entirely.
   */
  onMapReady?: (map: maplibregl.Map) => void;

  /**
   * Called when the map or WebGL fails to initialise.
   * If not provided, the error is logged and a fallback message is shown.
   */
  onError?: (message: string) => void;

  className?: string;
  style?: React.CSSProperties;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fitToCoords(map: maplibregl.Map, coords: [number, number][]) {
  if (coords.length < 2) return;
  let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
  for (const [lon, lat] of coords) {
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  const spanLon = maxLon - minLon;
  const spanLat = maxLat - minLat;
  if (!Number.isFinite(spanLon) || !Number.isFinite(spanLat) || spanLon <= 0 || spanLat <= 0) return;
  map.fitBounds(
    [[minLon, minLat], [maxLon, maxLat]],
    { padding: 40, duration: 600 }
  );
}

function safeRemoveLayers(map: maplibregl.Map, layerIds: readonly string[]) {
  for (const id of layerIds) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
}

function safeRemoveSource(map: maplibregl.Map, sourceId: string) {
  if (map.getSource(sourceId)) map.removeSource(sourceId);
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * MapCanvas — shared MapLibre GL map shell used by both the consumer /trip
 * page and the developer /map page.
 *
 * Two usage modes:
 *
 *   1. Managed (consumer apps):
 *      Pass routeCoords / routePreviewCoords / stopFeatures as props.
 *      MapCanvas owns source/layer lifecycle and auto-fits the viewport.
 *
 *   2. Escape-hatch (dev tool /map page):
 *      Pass onMapReady. MapCanvas fires the callback once the map loads.
 *      The host page owns ALL sources, layers, and markers from that point on.
 *      Data props are ignored in this mode.
 *
 * Performance contract:
 *   The maplibregl.Map instance is created once (stable useRef). Do NOT
 *   conditionally render <MapCanvas> in response to plan state changes — keep
 *   it mounted for the lifetime of the page to avoid expensive WebGL re-init.
 */
export function MapCanvas({
  routeCoords,
  routePreviewCoords,
  stopFeatures,
  onMapReady,
  onError,
  className,
  style,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const autoFitConsumedRef = useRef(false);
  const [mapReady, setMapReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  // ── Init (once) ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: STYLE_URL,
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Map failed to initialise";
      console.error("[MapCanvas] init error", err);
      setInitError(msg);
      onError?.(msg);
      return;
    }

    map.addControl(new maplibregl.NavigationControl(), "top-right");

    map.on("error", (e) => {
      const msg = e.error?.message ?? "Map render error";
      console.error("[MapCanvas] map error", e.error);
      // Surface to caller; don't call onError repeatedly for transient tile errors
      if (!mapReady) {
        setInitError(msg);
        onError?.(msg);
      }
    });

    map.once("load", () => {
      map.resize();
      setMapReady(true);
      if (onMapReady) {
        onMapReady(map);
      }
    });

    map.on("styledata", () => {
      if (map.isStyleLoaded() && !mapReady) setMapReady(true);
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // In escape-hatch mode the host manages everything — skip all data effects.
  const escapeHatch = Boolean(onMapReady);

  // ── Route line ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (escapeHatch) return;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    safeRemoveLayers(map, LAYERS_ROUTE);
    safeRemoveSource(map, SRC_ROUTE);

    if (!routeCoords || routeCoords.length < 2) return;

    map.addSource(SRC_ROUTE, {
      type: "geojson",
      data: {
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: routeCoords },
      },
    });
    map.addLayer({
      id: "mc-route-halo",
      type: "line",
      source: SRC_ROUTE,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#000000", "line-width": 10, "line-opacity": 0.22 },
    });
    map.addLayer({
      id: "mc-route-line",
      type: "line",
      source: SRC_ROUTE,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": ROUTE_BLUE, "line-width": 5 },
    });
  }, [escapeHatch, mapReady, routeCoords]);

  // ── Route preview (dashed) ─────────────────────────────────────────────────
  useEffect(() => {
    if (escapeHatch) return;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    safeRemoveLayers(map, LAYERS_PREVIEW);
    safeRemoveSource(map, SRC_PREVIEW);

    // Hide preview once the solid route line is present
    if (routeCoords && routeCoords.length >= 2) return;
    if (!routePreviewCoords || routePreviewCoords.length < 2) return;

    map.addSource(SRC_PREVIEW, {
      type: "geojson",
      data: {
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: routePreviewCoords },
      },
    });
    map.addLayer({
      id: "mc-preview-halo",
      type: "line",
      source: SRC_PREVIEW,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#000000", "line-width": 8, "line-opacity": 0.15 },
    });
    map.addLayer({
      id: "mc-preview-line",
      type: "line",
      source: SRC_PREVIEW,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": ROUTE_BLUE, "line-width": 4, "line-dasharray": [2, 2] },
    });

    // Auto-fit to preview extent on first load
    if (!autoFitConsumedRef.current) {
      fitToCoords(map, routePreviewCoords);
      autoFitConsumedRef.current = true;
    }
  }, [escapeHatch, mapReady, routeCoords, routePreviewCoords]);

  // ── Stop markers ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (escapeHatch) return;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    safeRemoveLayers(map, LAYERS_STOPS);
    safeRemoveSource(map, SRC_STOPS);

    const features = stopFeatures?.features ?? [];
    if (features.length === 0) return;

    map.addSource(SRC_STOPS, { type: "geojson", data: stopFeatures! });

    // Circles for charge stops, start, end, waypoints
    map.addLayer({
      id: "mc-stops-circle",
      type: "circle",
      source: SRC_STOPS,
      filter: ["!=", ["get", "stopType"], "sleep"],
      paint: {
        "circle-radius": 6,
        "circle-color": ["get", "color"],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.2,
      },
    });

    // Diamond glyph for sleep stops
    map.addLayer({
      id: "mc-stops-sleep",
      type: "symbol",
      source: SRC_STOPS,
      filter: ["==", ["get", "stopType"], "sleep"],
      layout: {
        "text-field": "◆",
        "text-size": 16,
        "text-allow-overlap": true,
      },
      paint: {
        "text-color": ["get", "color"],
        "text-halo-color": "#ffffff",
        "text-halo-width": 1.1,
      },
    });

    // Auto-fit to stop bounds on first non-empty render
    if (!autoFitConsumedRef.current) {
      const coords = features.map((f) => f.geometry.coordinates);
      fitToCoords(map, coords);
      autoFitConsumedRef.current = true;
    }

    map.resize();
  }, [escapeHatch, mapReady, stopFeatures]);

  // ── Render ─────────────────────────────────────────────────────────────────

  if (initError) {
    return (
      <div
        className={className}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f0f0f0",
          color: "#666",
          fontSize: 14,
          ...style,
        }}
      >
        Map unavailable
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ position: "relative", width: "100%", height: "100%", minWidth: 0, minHeight: 0, ...style }}
    />
  );
}
