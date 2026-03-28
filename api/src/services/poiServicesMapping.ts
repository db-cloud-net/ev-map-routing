import type { CanonicalCharger, CanonicalPoiHotel } from "../corridor/providerContracts";
import type {
  PoiServicesEdge,
  PoiServicesHotelChargerPair,
  PoiServicesLatLon,
  PoiServicesPoi
} from "./poiServicesTypes";

/** Build stable canonical charger id from a POI Services POI row. */
export function poiServicesChargerCanonicalId(poi: PoiServicesPoi): string {
  const src = (poi.source ?? "").toLowerCase();
  if (src === "nrel" && poi.source_id) {
    return `nrel:${poi.source_id}`;
  }
  return `poi:${poi.id}`;
}

export function mapPoiServicesChargerToCanonical(poi: PoiServicesPoi): CanonicalCharger {
  const src = (poi.source ?? "").toLowerCase();
  const isNrel = src === "nrel" && Boolean(poi.source_id);
  const id = poiServicesChargerCanonicalId(poi);
  const providerId = isNrel ? String(poi.source_id) : String(poi.id);
  return {
    entityType: "charger",
    id,
    providerId,
    source: isNrel ? "nrel" : "poi_services",
    name: poi.name || "Charger",
    coords: { lat: poi.lat, lon: poi.lon },
    maxPowerKw: poi.power_kw
  };
}

export function mapPoiServicesHotelToCanonical(poi: PoiServicesPoi): CanonicalPoiHotel {
  const id = `poi_services:hotel:${poi.id}`;
  return {
    entityType: "poi_hotel",
    id,
    providerId: String(poi.id),
    source: "poi_services",
    name: poi.name || "Hotel",
    coords: { lat: poi.lat, lon: poi.lon },
    brand: undefined,
    tourism: "hotel",
    osmType: "poi_services"
  };
}

export type PoiServicesEdgeMaps = {
  travelMinutes: Map<string, number>;
  distanceMiles: Map<string, number>;
};

/**
 * Build directed edge lookup maps keyed by `${canonicalFromId}|${canonicalToId}`.
 * Only includes edges where both endpoints appear in `chargers` (by integer POI id).
 */
export function buildEdgeMapsFromPoiServices(
  chargers: PoiServicesPoi[],
  edges: PoiServicesEdge[]
): PoiServicesEdgeMaps {
  const intToCanon = new Map<number, string>();
  for (const p of chargers) {
    intToCanon.set(p.id, poiServicesChargerCanonicalId(p));
  }

  const travelMinutes = new Map<string, number>();
  const distanceMiles = new Map<string, number>();

  for (const e of edges) {
    const fromCanon = intToCanon.get(e.from_id);
    const toCanon = intToCanon.get(e.to_id);
    if (!fromCanon || !toCanon) continue;
    const key = `${fromCanon}|${toCanon}`;
    const mins = e.duration_s / 60;
    const mi = e.distance_m / 1609.344;
    travelMinutes.set(key, mins);
    distanceMiles.set(key, mi);
  }

  return { travelMinutes, distanceMiles };
}

/** True if `v` is a non-empty lat/lon polyline usable as POI `shape`. */
export function isPoiShape(v: unknown): v is PoiServicesLatLon[] {
  if (!Array.isArray(v) || v.length < 2) return false;
  return v.every(
    (p) =>
      p !== null &&
      typeof p === "object" &&
      typeof (p as PoiServicesLatLon).lat === "number" &&
      typeof (p as PoiServicesLatLon).lon === "number"
  );
}

/**
 * Normalize `pairs` from a corridor response (or unknown JSON) into typed rows.
 * Drops malformed entries; does not resolve id-only pairs to full POI rows (caller may join on `charger[]`).
 */
export function parsePoiCorridorPairs(raw: unknown): PoiServicesHotelChargerPair[] {
  if (!Array.isArray(raw)) return [];
  const out: PoiServicesHotelChargerPair[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    const hotel = o.hotel as PoiServicesPoi | undefined;
    const nearby_dcfc = (o.nearby_dcfc ?? o.charger ?? o.dcfc) as PoiServicesPoi | undefined;
    const hotel_id =
      typeof o.hotel_id === "number"
        ? o.hotel_id
        : typeof hotel?.id === "number"
          ? hotel.id
          : undefined;
    const dcfc_id =
      typeof o.dcfc_id === "number"
        ? o.dcfc_id
        : typeof o.charger_id === "number"
          ? o.charger_id
          : typeof nearby_dcfc?.id === "number"
            ? nearby_dcfc.id
            : undefined;
    const distance_yd = typeof o.distance_yd === "number" ? o.distance_yd : undefined;
    if (hotel_id == null) continue;
    if (!nearby_dcfc && dcfc_id == null) continue;
    out.push({ hotel_id, dcfc_id, distance_yd, hotel, nearby_dcfc });
  }
  return out;
}
