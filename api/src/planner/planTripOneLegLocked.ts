import type { LatLng, ItineraryLeg, ItineraryStop, PlanTripResponse } from "../types";
import type { CanonicalCharger } from "../mirror/providerContracts";
import { NoFeasibleItineraryError, planLeastTimeSegment } from "./leastTimeSegment";

export type BuildLockedLegPlanParams = {
  requestId: string;
  responseVersion: string;
  segmentStartId: string;
  startCoords: LatLng;
  endStopId: string;
  endCoords: LatLng;
  /** Ordered charger stops that must be visited along this leg (hard constraint). */
  orderedLockedChargers: CanonicalCharger[];
  /** Candidate pool for the least-time segment solver (must include every locked charger). */
  chargersPool: CanonicalCharger[];
  rangeMiles: number;
  bufferSoc: number;
  batteryKwh: number;
  overnightThresholdMinutes: number;
  includeCandidates?: boolean;
  candidatesForResponse: PlanTripResponse["candidates"];
  legIndex?: number;
};

/**
 * Chains multiple `planLeastTimeSegment` calls: start → lock₁ → … → lockₙ → end.
 * Does not run overnight splitting; fails if total driving+charge time exceeds the overnight threshold.
 */
export async function planTripOneLegLockedChargerChain(
  input: BuildLockedLegPlanParams
): Promise<PlanTripResponse> {
  const {
    orderedLockedChargers,
    chargersPool,
    rangeMiles,
    bufferSoc,
    batteryKwh,
    overnightThresholdMinutes
  } = input;

  const locks = orderedLockedChargers;
  const points: Array<{ id: string; coords: LatLng; kind: "lock" | "end" }> = [
    ...locks.map((c) => ({
      id: String(c.id),
      coords: c.coords,
      kind: "lock" as const
    })),
    { id: input.endStopId, coords: input.endCoords, kind: "end" }
  ];

  let overallStops: ItineraryStop[] = [];
  let overallLegs: ItineraryLeg[] = [];
  let timeOffset = 0;

  let segmentStartId = input.segmentStartId;
  let segmentStartCoords = input.startCoords;

  try {
    for (let i = 0; i < points.length; i++) {
      const b = points[i];
      const seg = await planLeastTimeSegment({
        requestId: input.requestId,
        segmentStart: { id: segmentStartId, type: "start", coords: segmentStartCoords },
        segmentEnd: { id: b.id, type: "end", coords: b.coords },
        chargers: chargersPool,
        rangeMiles,
        bufferSoc,
        batteryKwh
      });

      let stops = seg.stops.map((s) => ({
        ...s,
        etaMinutesFromStart: (s.etaMinutesFromStart ?? 0) + timeOffset
      }));

      if (overallStops.length > 0) {
        stops = stops.slice(1);
      }

      if (b.kind === "lock") {
        const last = stops[stops.length - 1];
        if (last && last.type === "end") {
          const ch = locks[i];
          last.type = "charge";
          last.name = ch.name;
          last.id = String(ch.id);
        }
      }

      overallStops = overallStops.concat(stops);
      overallLegs = overallLegs.concat(seg.legs);
      timeOffset += seg.totalTimeMinutes;

      segmentStartId = b.id;
      segmentStartCoords = b.coords;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "No feasible itinerary with locked chargers";
    const code = "INFEASIBLE_CHARGER_LOCK";
    return {
      requestId: input.requestId,
      responseVersion: input.responseVersion,
      status: "error",
      errorCode: code,
      message: msg,
      stops: [],
      legs: [],
      totals: {
        travelTimeMinutes: 0,
        chargeTimeMinutes: 0,
        sleepTimeMinutes: 0,
        totalTimeMinutes: 0,
        overnightStopsCount: 0
      },
      debug:
        e instanceof NoFeasibleItineraryError
          ? { lockedChargerChain: true, solverDebug: e.debug }
          : { lockedChargerChain: true }
    };
  }

  if (timeOffset > overnightThresholdMinutes) {
    return {
      requestId: input.requestId,
      responseVersion: input.responseVersion,
      status: "error",
      errorCode: "LOCKED_ROUTE_TOO_LONG",
      message:
        "This route with locked chargers exceeds the single-day driving threshold. Remove locks, shorten the trip, or split into multiple days (not yet supported for locks).",
      stops: [],
      legs: [],
      totals: {
        travelTimeMinutes: 0,
        chargeTimeMinutes: 0,
        sleepTimeMinutes: 0,
        totalTimeMinutes: 0,
        overnightStopsCount: 0
      },
      debug: {
        lockedChargerChain: true,
        totalTimeMinutes: timeOffset,
        overnightThresholdMinutes
      }
    };
  }

  const travelTimeMinutes = overallLegs.reduce(
    (sum, l) => sum + (l.travelTimeMinutes ?? 0),
    0
  );
  const chargeTimeMinutes = overallLegs.reduce(
    (sum, l) => sum + (l.chargeTimeMinutes ?? 0),
    0
  );

  return {
    requestId: input.requestId,
    responseVersion: input.responseVersion,
    status: "ok",
    stops: overallStops,
    legs: overallLegs,
    totals: {
      travelTimeMinutes,
      chargeTimeMinutes,
      sleepTimeMinutes: 0,
      totalTimeMinutes: travelTimeMinutes + chargeTimeMinutes,
      overnightStopsCount: 0
    },
    candidates: input.candidatesForResponse,
    debug: {
      lockedChargerChain: true,
      legIndex: input.legIndex ?? 0
    }
  };
}
