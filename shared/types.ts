export type LatLng = { lat: number; lon: number };

/**
 * Internal multi-leg planner carry context.
 * Optional so existing single-leg flows remain backward-compatible.
 */
export type TripLegPlanningContext = {
  elapsedMinutesFromTripStart?: number;
  tripLegIndex?: number;
  tripLegCount?: number;
  tripProgressMilesFromTripStart?: number;
};

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
  /**
   * When an overnight stop is inserted, prefer this hotel id if it appears near the anchor.
   * Use Overpass ids from `candidates.hotels`, or **`poi_services:hotel:<numeric>`** when corridor hotels come from POI Services.
   */
  lockedHotelId?: string;
  /**
   * **Slice 2:** New plan start — device coords or a stop from the prior plan.
   * Requires `end` (and optional remainder `waypoints`). With `stopId`, send **`previousStops`** from the last `POST /plan` response.
   */
  replanFrom?: ReplanFrom;
  /** Stops array from the immediately previous successful `POST /plan` — required for `replanFrom.stopId`. */
  previousStops?: ItineraryStop[];
  /**
   * When true with ≥2 waypoints (and no per-leg locks / hotel lock / replan), the planner may reorder
   * intermediate stops to minimize a haversine leg-sum proxy before EV planning. See `debug.waypointOrderOptimization`.
   */
  optimizeWaypointOrder?: boolean;
};

export type CandidateCharger = {
  id: string;
  name: string;
  coords: LatLng;
  maxPowerKw?: number;
  source: "nrel" | "poi_services";
};

export type CandidateHotel = {
  id: string;
  name: string;
  coords: LatLng;
  source: "overpass" | "poi_services";
};

export type PlanTripCandidates = {
  chargers: CandidateCharger[];
  hotels: CandidateHotel[];
  /** Which leg these candidates belong to when `waypoints` are used (0-based). */
  legIndex: number;
};

/**
 * **Presentation-only** range leg: driving chunk from trip start or a **charge** departure to the next **charge**
 * arrival or **end**. Derived from the least-time itinerary (not a separate optimizer). Same grouping will back
 * future per-leg road display — see `docs/designs/range-based-segments-intent.md`.
 */
export type RangeLegSummary = {
  index: number;
  fromStopId: string;
  toStopId: string;
  /** Ordered stops along this leg (start → … → end of chunk), ids only */
  stopIds: string[];
  travelTimeMinutes: number;
  chargeTimeMinutes: number;
  /** Sum of straight-line miles between consecutive stops in this leg (approximation, not road distance) */
  chordMilesApprox: number;
  /**
   * Pillar 1 prep — max straight-line miles of any **single** driving sub-hop inside this chunk
   * (compare to `usableRangeMiles`). Omitted when `PLAN_RANGE_LEG_METRICS=false` or metrics disabled.
   */
  maxHopChordMilesApprox?: number;
  /** `EV_RANGE_MILES * (1 - CHARGE_BUFFER_SOC)` used for the comparison (same for all legs in the plan). */
  usableRangeMiles?: number;
  /** True when `maxHopChordMilesApprox > usableRangeMiles` (chord sanity vs one-charge budget). */
  maxHopExceedsRangeBudget?: boolean;
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
  /**
   * **Presentation layer:** trip sliced at **charge** boundaries (rolling origin after each charge).
   * Omitted on error or when the itinerary cannot be grouped. Also mirrored under **`debug.rangeLegs`**.
   */
  rangeLegs?: RangeLegSummary[];
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
  /**
   * Web-only: merged multi-hop preview while some hops are still loading (`fetchMergedRoutePreview` partials).
   */
  partialPreviewMeta?: { loadedSegments: number; totalSegments: number };
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

