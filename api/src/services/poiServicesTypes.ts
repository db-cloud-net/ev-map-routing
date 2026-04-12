/**
 * Minimal types for POI Services v2 POST /corridor/query — aligned with sibling repo
 * contracts/openapi.yaml (subset used by Travel-Routing).
 */

export type PoiServicesLatLon = { lat: number; lon: number };

export type PoiServicesCorridorLayer =
  | "charger"
  | "hotel"
  | "restaurant"
  | "rest_stop"
  | "pairs"
  | "edges"
  | "shape";

export type PoiServicesCorridorRequest = {
  shape?: PoiServicesLatLon[];
  src?: PoiServicesLatLon;
  dst?: PoiServicesLatLon;
  corridor_radius_mi: number;
  layers: PoiServicesCorridorLayer[];
  filters?: {
    network?: string;
    connector?: string;
    poi_type?: string;
    /** Max hotel↔DCFC distance for `pairs` layer (yards). */
    pairs_max_distance_yd?: number;
  };
  /** Optional output cap; POI Services may apply it per-layer or to the overall query. */
  limit?: number;
};

/** One row from POI Services `pairs` layer (corridor or `/pois/hotel-charger-pairs`). */
export type PoiServicesHotelChargerPair = {
  hotel_id?: number;
  dcfc_id?: number;
  distance_yd?: number;
  hotel?: PoiServicesPoi;
  nearby_dcfc?: PoiServicesPoi;
};

export type PoiServicesPoi = {
  id: number;
  poi_type: string;
  name: string;
  lat: number;
  lon: number;
  address?: string;
  city?: string;
  state?: string;
  zip_code?: string;
  network?: string;
  power_kw?: number;
  connector_types?: string;
  num_ports?: number;
  phone?: string;
  website?: string;
  rooms?: number;
  status?: string;
  source?: string;
  source_id?: string;
  onsite_charger_level?: string;
  onsite_charger_power_kw?: number;
  onsite_charger_ports?: number;
  onsite_charger_network?: string;
  nearby_dcfc_id?: number;
  nearby_dcfc_distance_yd?: number;
};

export type PoiServicesEdge = {
  from_id: number;
  to_id: number;
  distance_m: number;
  duration_s: number;
};

export type PoiServicesCorridorResponse = {
  corridor: {
    radius_mi: number;
    shape_points: number;
    total_distance_mi?: number;
    total_duration_min?: number;
  };
  shape?: PoiServicesLatLon[];
  charger?: PoiServicesPoi[];
  hotel?: PoiServicesPoi[];
  restaurant?: PoiServicesPoi[];
  rest_stop?: PoiServicesPoi[];
  edges?: PoiServicesEdge[];
  pairs?: PoiServicesHotelChargerPair[];
  warnings: string[];
};
