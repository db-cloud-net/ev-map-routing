export type LatLng = { lat: number; lon: number };

export type StopType = "start" | "charge" | "sleep" | "end" | "waypoint";

export type ItineraryStop = {
  id: string;
  type: StopType;
  name: string;
  coords: LatLng;
  etaMinutesFromStart?: number; // estimated timing for the stop
  meta?: Record<string, string | number | boolean | null>;
};

export type ItineraryLeg = {
  fromStopId: string;
  toStopId: string;
  travelTimeMinutes?: number; // estimated/known
  chargeTimeMinutes?: number; // estimated if from a charger stop
  // MVP: expects LineString-like geometry when available.
  // We keep this type local (no `GeoJSON.*` global dependency).
  geometry?: { type: "LineString"; coordinates: [number, number][] };
  // Optional directions when available from Valhalla.
  maneuvers?: Array<{
    text: string;
    instructionType?: string;
    distanceMeters?: number;
    timeSeconds?: number;
  }>;
};

/** Mid-journey replan: use coords or a stop id from `previousStops` (mutually exclusive with `start`). */
export type ReplanFrom =
  | { coords: LatLng }
  | { stopId: string };

/** Request body for `POST /plan` (v2 adds optional fields; omit for v1 A→B). */
export type PlanTripRequest = {
  /** User-provided start place text (geocode later). Omit when `replanFrom` is set (Slice 2). */
  start?: string;
  end: string;
  /** Ordered intermediate destinations (geocoded strings). Omitted or empty = v1 behavior. */
  waypoints?: string[];
  /** When true, successful responses may include `candidates` for map layers (same IDs as planning). */
  includeCandidates?: boolean;
  /**
   * Per driving leg (length = `max(1, waypoints.length + 1)`): ordered charger ids that must be visited on that leg.
   * Ids must appear in `candidates.chargers` from a prior plan for the same corridor (same id universe as NREL).
   */
  lockedChargersByLeg?: string[][];
  /** When an overnight stop is inserted, prefer this hotel id (Overpass id) if it appears near the anchor. */
  lockedHotelId?: string;
  /**
   * **Slice 2:** New plan start — device coords or a stop from the prior plan.
   * Requires `end` (and optional remainder `waypoints`). With `stopId`, send **`previousStops`** from the last `POST /plan` response.
   */
  replanFrom?: ReplanFrom;
  /** Stops array from the immediately previous successful `POST /plan` — required for `replanFrom.stopId`. */
  previousStops?: ItineraryStop[];
};

export type CandidateCharger = {
  id: string;
  name: string;
  coords: LatLng;
  maxPowerKw?: number;
  source: "nrel";
};

export type CandidateHotel = {
  id: string;
  name: string;
  coords: LatLng;
  source: "overpass";
};

export type PlanTripCandidates = {
  chargers: CandidateCharger[];
  hotels: CandidateHotel[];
  /** Which leg these candidates belong to when `waypoints` are used (0-based). */
  legIndex: number;
};

export type PlanTripResponse = {
  requestId: string;
  responseVersion: string;
  status: "ok" | "error";
  message?: string;
  /** Machine-readable error for clients (validation / lock feasibility). */
  errorCode?: string;
  debug?: Record<string, unknown>;
  stops: ItineraryStop[];
  legs: ItineraryLeg[];
  totals?: {
    travelTimeMinutes: number;
    chargeTimeMinutes: number;
    sleepTimeMinutes: number;
    totalTimeMinutes: number;
    overnightStopsCount: number;
  };
  /** Present when `includeCandidates` was requested and planning succeeded for at least one leg. */
  candidates?: PlanTripCandidates;
};

