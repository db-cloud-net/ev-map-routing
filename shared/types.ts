export type LatLng = { lat: number; lon: number };

export type StopType = "start" | "charge" | "sleep" | "end";

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

export type PlanTripRequest = {
  start: string; // user-provided place/address text (geocode later)
  end: string;
};

export type PlanTripResponse = {
  requestId: string;
  responseVersion: string;
  status: "ok" | "error";
  message?: string;
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
};

