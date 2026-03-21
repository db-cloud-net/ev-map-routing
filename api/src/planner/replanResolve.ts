import { geocodeTextToLatLng } from "../services/geocode";
import type { ItineraryStop, LatLng, PlanTripResponse } from "../types";

function emptyTotals(): NonNullable<PlanTripResponse["totals"]> {
  return {
    travelTimeMinutes: 0,
    chargeTimeMinutes: 0,
    sleepTimeMinutes: 0,
    totalTimeMinutes: 0,
    overnightStopsCount: 0
  };
}

export type ReplanFromInput =
  | { coords: LatLng }
  | { stopId: string };

export type PlanStartResolution =
  | { ok: true; startCoords: LatLng; startLabel: string; midJourneyReplan: boolean }
  | { ok: false; response: PlanTripResponse };

/**
 * Resolves the physical start of a plan: geocoded `start` string, `replanFrom.coords`, or
 * `replanFrom.stopId` + `previousStops` (stateless stop lookup).
 */
export async function resolvePlanStart(params: {
  requestId: string;
  responseVersion: string;
  start?: string;
  replanFrom?: ReplanFromInput;
  previousStops?: ItineraryStop[];
}): Promise<PlanStartResolution> {
  const { requestId, responseVersion } = params;
  const baseError = (
    message: string,
    errorCode: string
  ): PlanTripResponse => ({
    requestId,
    responseVersion,
    status: "error",
    message,
    errorCode,
    stops: [],
    legs: [],
    totals: emptyTotals()
  });

  if (params.replanFrom) {
    if ("coords" in params.replanFrom) {
      return {
        ok: true,
        startCoords: params.replanFrom.coords,
        startLabel: "Current location",
        midJourneyReplan: true
      };
    }
    const sid = params.replanFrom.stopId;
    const prev = params.previousStops;
    if (!prev?.length) {
      return {
        ok: false,
        response: baseError(
          "previousStops is required when using replanFrom.stopId.",
          "MISSING_PREVIOUS_STOPS"
        )
      };
    }
    const found = prev.find((s) => s.id === sid);
    if (!found) {
      return {
        ok: false,
        response: baseError(
          `No stop with id "${sid}" in previousStops.`,
          "UNKNOWN_REPLAN_STOP"
        )
      };
    }
    return {
      ok: true,
      startCoords: found.coords,
      startLabel: found.name,
      midJourneyReplan: true
    };
  }

  const startText = params.start?.trim() ?? "";
  if (!startText) {
    return {
      ok: false,
      response: baseError(
        "start is required when replanFrom is omitted.",
        "MISSING_START"
      )
    };
  }

  const startCoords = await geocodeTextToLatLng(startText);
  return {
    ok: true,
    startCoords,
    startLabel: startText,
    midJourneyReplan: false
  };
}

/** True when the request used explicit mid-journey replan (not plain geocoded start). */
export function isMidJourneyReplan(replanFrom: ReplanFromInput | undefined): boolean {
  return replanFrom != null;
}
