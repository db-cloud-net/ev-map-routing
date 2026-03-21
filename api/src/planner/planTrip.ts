import { geocodeTextToLatLng } from "../services/geocode";
import type { PlanTripResponse } from "../types";
import { planTripOneLegFromCoords } from "./planTripOneLeg";
import { validateLockedChargersByLeg } from "./lockValidation";

export type PlanTripPlannerInput = {
  requestId: string;
  start: string;
  end: string;
  responseVersion: string;
  waypoints?: string[];
  includeCandidates?: boolean;
  lockedChargersByLeg?: string[][];
  lockedHotelId?: string;
};

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

async function planTripMultiLeg(
  input: PlanTripPlannerInput & { waypoints: string[] }
): Promise<PlanTripResponse> {
  const startCoords = await geocodeTextToLatLng(input.start);
  const wpCoords = await Promise.all(input.waypoints.map((w) => geocodeTextToLatLng(w)));
  const endCoords = await geocodeTextToLatLng(input.end);

  const points = [startCoords, ...wpCoords, endCoords];
  const labels = [input.start, ...input.waypoints, input.end];

  const allChargers: NonNullable<PlanTripResponse["candidates"]>["chargers"] = [];
  const allHotels: NonNullable<PlanTripResponse["candidates"]>["hotels"] = [];

  let mergedStops = [] as PlanTripResponse["stops"];
  let mergedLegs = [] as PlanTripResponse["legs"];
  let totalTravel = 0;
  let totalCharge = 0;
  let totalSleep = 0;
  let overnightCount = 0;
  let timeOffset = 0;
  let lastMessage: string | undefined;
  const legDebugs: Array<Record<string, unknown> | undefined> = [];

  for (let i = 0; i < points.length - 1; i++) {
    const isLast = i === points.length - 2;
    const segStartId = i === 0 ? "start" : `via-${i - 1}`;
    const endId = isLast ? "end" : `via-${i}`;

    const leg = await planTripOneLegFromCoords({
      requestId: input.requestId,
      responseVersion: input.responseVersion,
      startCoords: points[i],
      endCoords: points[i + 1],
      endStopId: endId,
      segmentStartId: segStartId,
      startQueryLabel: labels[i],
      endQueryLabel: labels[i + 1],
      includeCandidates: input.includeCandidates,
      legIndex: i,
      lockedChargerIdsOrdered: input.lockedChargersByLeg?.[i],
      lockedHotelId: input.lockedHotelId
    });

    if (leg.status !== "ok") return leg;

    if (leg.message) lastMessage = leg.message;
    legDebugs.push(leg.debug as Record<string, unknown> | undefined);

    if (leg.candidates) {
      allChargers.push(...leg.candidates.chargers);
      allHotels.push(...leg.candidates.hotels);
    }

    let stops = leg.stops.map((s) => ({
      ...s,
      etaMinutesFromStart: (s.etaMinutesFromStart ?? 0) + timeOffset
    }));

    if (i > 0) stops = stops.slice(1);

    if (!isLast) {
      const last = stops[stops.length - 1];
      if (last.type === "end") {
        last.type = "waypoint";
        last.name = labels[i + 1] ?? last.name;
      }
    }

    mergedStops = mergedStops.concat(stops);
    mergedLegs = mergedLegs.concat(leg.legs);

    const t = leg.totals;
    if (t) {
      totalTravel += t.travelTimeMinutes;
      totalCharge += t.chargeTimeMinutes;
      totalSleep += t.sleepTimeMinutes;
      overnightCount += t.overnightStopsCount;
      timeOffset += t.totalTimeMinutes;
    }
  }

  const candidates =
    input.includeCandidates && (allChargers.length || allHotels.length)
      ? {
          chargers: dedupeById(allChargers),
          hotels: dedupeById(allHotels),
          legIndex: 0
        }
      : undefined;

  return {
    requestId: input.requestId,
    responseVersion: input.responseVersion,
    status: "ok",
    message: lastMessage,
    stops: mergedStops,
    legs: mergedLegs,
    totals: {
      travelTimeMinutes: totalTravel,
      chargeTimeMinutes: totalCharge,
      sleepTimeMinutes: totalSleep,
      totalTimeMinutes: totalTravel + totalCharge + totalSleep,
      overnightStopsCount: overnightCount
    },
    candidates,
    debug: {
      multiLeg: true,
      legCount: points.length - 1,
      legs: legDebugs
    }
  };
}

export async function planTrip(input: PlanTripPlannerInput): Promise<PlanTripResponse> {
  const maxWaypoints = Number(process.env.V2_MAX_WAYPOINTS ?? "8");
  const wps = (input.waypoints ?? []).map((w) => w.trim()).filter(Boolean);

  if (wps.length > maxWaypoints) {
    return {
      requestId: input.requestId,
      responseVersion: input.responseVersion || "v2-1",
      status: "error",
      message: `Too many waypoints (max ${maxWaypoints}).`,
      stops: [],
      legs: [],
      totals: {
        travelTimeMinutes: 0,
        chargeTimeMinutes: 0,
        sleepTimeMinutes: 0,
        totalTimeMinutes: 0,
        overnightStopsCount: 0
      }
    };
  }

  if (!wps.length) {
    const startCoords = await geocodeTextToLatLng(input.start);
    const endCoords = await geocodeTextToLatLng(input.end);
    return planTripOneLegFromCoords({
      requestId: input.requestId,
      responseVersion: input.responseVersion,
      startCoords,
      endCoords,
      endStopId: "end",
      segmentStartId: "start",
      startQueryLabel: input.start,
      endQueryLabel: input.end,
      includeCandidates: input.includeCandidates,
      legIndex: 0,
      lockedChargerIdsOrdered: input.lockedChargersByLeg?.[0],
      lockedHotelId: input.lockedHotelId
    });
  }

  return planTripMultiLeg({ ...input, waypoints: wps });
}
