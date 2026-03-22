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

/** Response shape for `POST /candidates` (Slice 3) — candidates only, no itinerary. */
export type CandidatesApiResponse = Pick<
  PlanTripResponse,
  "requestId" | "responseVersion" | "status" | "message" | "errorCode" | "candidates"
> & {
  debug?: Record<string, unknown>;
};

/** Slice 4 — fast road preview (single leg, no EV solver). Normative UX: ROUTING_UX_SPEC §3. */
export type RoutePreviewPolyline = NonNullable<ItineraryLeg["geometry"]>;

export type RoutePreviewHorizon = {
  /** Config used for this clip (minutes of driving time budget along the route). */
  maxMinutes: number;
  maneuvers: NonNullable<ItineraryLeg["maneuvers"]>;
  /** Sum of `timeSeconds` on horizon maneuvers when present; else 0. */
  cumulativeTimeSeconds: number;
};

export type RoutePreviewBody = {
  polyline: RoutePreviewPolyline;
  tripTimeMinutes: number;
  tripDistanceMiles: number;
  horizon: RoutePreviewHorizon;
  /**
   * Second time-budgeted clip from the same Valhalla maneuver list (after `horizon`).
   * Satisfies ROUTING_UX_SPEC §5 “next segment ready or in flight” without a second HTTP round-trip.
   * Omitted when the route ends within the first horizon or there are no remaining maneuvers.
   */
  nextHorizon?: RoutePreviewHorizon;
};

export type RoutePreviewApiResponse = {
  requestId: string;
  responseVersion: "v2-1-route-preview";
  status: "ok" | "error";
  message?: string;
  errorCode?: string;
  preview?: RoutePreviewBody;
  debug?: Record<string, unknown>;
};

