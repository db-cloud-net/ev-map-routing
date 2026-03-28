import type { ItineraryLeg, ItineraryStop, LatLng, PlanTripResponse } from "../types";
import { haversineMiles } from "./geo";

/** Shared with `rangeLegs` metrics + SOC replay (`EV_RANGE_MILES` / `CHARGE_BUFFER_SOC`). */
export type RangeLegMetricsOpts = {
  rangeMiles: number;
  bufferSoc: number;
};

/**
 * Linear SOC replay along a fixed itinerary (same energy units as `leastTimeSegment`):
 * - one full pack = 1.0 fraction of `EV_RANGE_MILES` usable distance
 * - each hop consumes `distanceMiles / rangeMiles` SOC
 * - hop to a non-end stop assumes arriving with `bufferSoc` remaining at the charger (solver-style), i.e.
 *   required departure SOC from the previous stop = `d/r + bufferSoc`
 * - hop to **end** requires departure SOC = `d/r` only
 *
 * Distances: sum of `maneuvers[].distanceMeters` on the leg when present, else haversine chord.
 */

export type SocReplayStop = {
  stopId: string;
  stopType: ItineraryStop["type"];
  /** SOC fraction **after** any charge at this stop, when leaving toward the next stop (undefined at terminal end). */
  socDepart?: number;
  /** SOC fraction **after** driving the incoming leg (before charge at this stop when applicable). */
  socArrive?: number;
  /** Required SOC fraction to **leave** this stop for the **next** leg (backward model). Undefined at end. */
  legDepartNeed?: number;
  /** Miles used on the **incoming** leg (undefined at start). */
  incomingLegMiles?: number;
  /** At charge/sleep: `true` when arrival SOC is below what the next leg requires (linear infeasibility). */
  chargeShortfall?: boolean;
};

export type SocReplayResult = {
  model: "linear_range_fraction";
  rangeMiles: number;
  bufferSoc: number;
  stops: SocReplayStop[];
  /** SOC fraction arriving at the final stop when type `end`. */
  socArriveEnd?: number;
  /** Any violation of the linear model (negative arrival, shortfall at waypoint, or charge shortfall). */
  linearInfeasible: boolean;
};

function legDistanceMiles(stops: ItineraryStop[], legs: ItineraryLeg[], legIndex: number): number {
  const leg = legs[legIndex];
  if (!leg) return 0;
  const m = leg.maneuvers;
  if (m && m.length > 0) {
    let sumM = 0;
    for (const x of m) {
      if (typeof x.distanceMeters === "number" && Number.isFinite(x.distanceMeters) && x.distanceMeters > 0) {
        sumM += x.distanceMeters;
      }
    }
    if (sumM > 0) return sumM / 1609.34;
  }
  const a = stops[legIndex];
  const b = stops[legIndex + 1];
  if (!a || !b) return 0;
  return haversineMiles(a.coords, b.coords);
}

/** Required SOC fraction **leaving** stop `legIndex` toward `legIndex + 1` (matches least-time hop bookkeeping). */
function legDepartSocFraction(
  stops: ItineraryStop[],
  legs: ItineraryLeg[],
  legIndex: number,
  rangeMiles: number,
  bufferSoc: number
): number {
  const d = legDistanceMiles(stops, legs, legIndex);
  const dest = stops[legIndex + 1];
  if (!dest) return 0;
  if (dest.type === "end") {
    return d / rangeMiles;
  }
  return d / rangeMiles + bufferSoc;
}

function isChargeStop(t: ItineraryStop["type"]): boolean {
  return t === "charge" || t === "sleep";
}

export function computeSocReplay(
  plan: Pick<PlanTripResponse, "stops" | "legs">,
  opts: RangeLegMetricsOpts
): SocReplayResult | null {
  const { stops, legs } = plan;
  if (stops.length < 2 || legs.length !== stops.length - 1) return null;

  const rangeMiles = opts.rangeMiles;
  const bufferSoc = opts.bufferSoc;
  if (!Number.isFinite(rangeMiles) || rangeMiles <= 0) return null;

  const n = stops.length;
  const legDepartNeed: number[] = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    legDepartNeed[i] = legDepartSocFraction(stops, legs, i, rangeMiles, bufferSoc);
  }

  const out: SocReplayStop[] = stops.map((s) => ({
    stopId: s.id,
    stopType: s.type
  }));

  let linearInfeasible = false;
  let socDepart = 1.0;

  out[0] = {
    ...out[0],
    socDepart,
    legDepartNeed: legDepartNeed[0]
  };

  for (let i = 0; i < n - 1; i++) {
    const d = legDistanceMiles(stops, legs, i);
    const rawArrive = socDepart - d / rangeMiles;
    if (rawArrive < -1e-6) linearInfeasible = true;
    const socArriveClamped = Math.max(0, Math.round(rawArrive * 10000) / 10000);

    const nextIdx = i + 1;
    const nextStop = stops[nextIdx];
    out[nextIdx] = {
      ...out[nextIdx],
      incomingLegMiles: Math.round(d * 1000) / 1000,
      socArrive: socArriveClamped
    };

    if (nextStop.type === "end") {
      out[nextIdx].legDepartNeed = undefined;
      return {
        model: "linear_range_fraction",
        rangeMiles,
        bufferSoc,
        stops: out,
        socArriveEnd: Math.round(rawArrive * 10000) / 10000,
        linearInfeasible
      };
    }

    const needLeaveNext = legDepartNeed[nextIdx];
    if (needLeaveNext === undefined) {
      linearInfeasible = true;
      return {
        model: "linear_range_fraction",
        rangeMiles,
        bufferSoc,
        stops: out,
        linearInfeasible: true
      };
    }

    if (nextStop.type === "waypoint") {
      socDepart = socArriveClamped;
      if (socArriveClamped < needLeaveNext - 1e-6) linearInfeasible = true;
      out[nextIdx] = {
        ...out[nextIdx],
        socDepart: Math.round(socDepart * 10000) / 10000,
        legDepartNeed: needLeaveNext
      };
    } else if (isChargeStop(nextStop.type)) {
      const afterCharge = Math.min(1, Math.max(rawArrive, needLeaveNext));
      const chargeShortfall = rawArrive < needLeaveNext - 1e-6;
      if (chargeShortfall) linearInfeasible = true;
      socDepart = afterCharge;
      out[nextIdx] = {
        ...out[nextIdx],
        socDepart: Math.round(socDepart * 10000) / 10000,
        legDepartNeed: needLeaveNext,
        chargeShortfall
      };
    } else {
      // `start` should not appear as a leg destination; treat like waypoint (no charging).
      socDepart = socArriveClamped;
      if (socArriveClamped < needLeaveNext - 1e-6) linearInfeasible = true;
      out[nextIdx] = {
        ...out[nextIdx],
        socDepart: Math.round(socDepart * 10000) / 10000,
        legDepartNeed: needLeaveNext
      };
    }
  }

  return {
    model: "linear_range_fraction",
    rangeMiles,
    bufferSoc,
    stops: out,
    linearInfeasible
  };
}

/**
 * Linear SOC fraction available when **leaving** the last stop of `stops`/`legs`, if the next hop is
 * to `nextStopCoords` (charger or end). Matches `computeSocReplay` charge-stop departure rule:
 * `min(1, max(arrive, needToContinue))`. Used to chain `planLeastTimeSegment` without assuming a full pack.
 */
export function departSocFractionAfterSegmentForNextHop(
  stops: ItineraryStop[],
  legs: ItineraryLeg[],
  rangeMiles: number,
  bufferSoc: number,
  nextStopCoords: LatLng,
  nextKind: "charge" | "end"
): number {
  if (stops.length < 2 || legs.length !== stops.length - 1) return 1;
  if (!Number.isFinite(rangeMiles) || rangeMiles <= 0) return 1;
  const buf = Math.min(Math.max(bufferSoc, 0), 0.999);

  let socDepart = 1.0;
  for (let i = 0; i < legs.length; i++) {
    const d = legDistanceMiles(stops, legs, i);
    const toStop = stops[i + 1];
    if (!toStop) return 1;
    const rawArrive = socDepart - d / rangeMiles;
    const socArrive = Math.max(0, rawArrive);

    if (i === legs.length - 1) {
      const needToContinue =
        haversineMiles(toStop.coords, nextStopCoords) / rangeMiles +
        (nextKind === "end" ? 0 : buf);
      return Math.min(1, Math.max(socArrive, needToContinue));
    }

    const needLeave = legDepartSocFraction(stops, legs, i, rangeMiles, buf);
    if (toStop.type === "charge" || toStop.type === "sleep") {
      socDepart = Math.min(1, Math.max(rawArrive, needLeave));
    } else {
      socDepart = socArrive;
    }
  }
  return 1;
}

export function readSocReplayOptsFromEnv(): RangeLegMetricsOpts | undefined {
  if ((process.env.PLAN_SOC_REPLAY ?? "true").toLowerCase() === "false") {
    return undefined;
  }
  const rangeMiles = Number(process.env.EV_RANGE_MILES ?? "260");
  const bufferSoc = Number(process.env.CHARGE_BUFFER_SOC ?? "0");
  if (!Number.isFinite(rangeMiles) || rangeMiles <= 0) return undefined;
  if (!Number.isFinite(bufferSoc) || bufferSoc < 0) return undefined;
  const usable = rangeMiles * (1 - Math.min(bufferSoc, 0.999));
  if (!Number.isFinite(usable) || usable <= 0) return undefined;
  return { rangeMiles, bufferSoc };
}
