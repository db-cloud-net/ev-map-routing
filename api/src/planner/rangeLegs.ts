import type { ItineraryLeg, ItineraryStop, PlanTripResponse, RangeLegSummary } from "../types";
import { haversineMiles } from "./geo";
import {
  computeSocReplay,
  readSocReplayOptsFromEnv,
  type RangeLegMetricsOpts
} from "./socReplay";

export type { RangeLegMetricsOpts };

/**
 * When set (default: on unless `PLAN_RANGE_LEG_METRICS=false`), each `RangeLegSummary` includes
 * max single-hop chord distance vs usable range — foundation for true range-window planning (ADR pillar 1).
 */

export function readRangeLegMetricsOptsFromEnv(): RangeLegMetricsOpts | undefined {
  if ((process.env.PLAN_RANGE_LEG_METRICS ?? "true").toLowerCase() === "false") {
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

/**
 * Indices of stops that begin a new **range leg** (departure anchor):
 * - always `0` (trip start)
 * - each **charge** stop index (arrival ends prior leg; departure starts next)
 * - final **`end`** stop if it is not already a charge (terminates last leg)
 */
function rangeLegBoundaryIndices(stops: ItineraryStop[]): number[] {
  if (stops.length === 0) return [];
  const out: number[] = [0];
  for (let i = 0; i < stops.length; i++) {
    if (stops[i].type === "charge") out.push(i);
  }
  const last = stops.length - 1;
  if (last >= 0 && stops[last].type !== "charge") {
    if (out[out.length - 1] !== last) out.push(last);
  }
  // Dedupe (e.g. single charge that is also last — unusual)
  const dedup: number[] = [];
  for (const idx of out) {
    if (dedup.length === 0 || dedup[dedup.length - 1] !== idx) dedup.push(idx);
  }
  return dedup;
}

function usableRangeMilesFromOpts(opts: RangeLegMetricsOpts): number {
  const b = Math.min(Math.max(opts.bufferSoc, 0), 0.999);
  return opts.rangeMiles * (1 - b);
}

/**
 * Build **presentation** range legs from a successful `POST /plan` body.
 * Assumes `legs[i]` connects `stops[i]` → `stops[i + 1]` (true for current planner output).
 */
export function computeRangeLegs(
  plan: Pick<PlanTripResponse, "stops" | "legs">,
  metricsOpts?: RangeLegMetricsOpts
): RangeLegSummary[] {
  const { stops, legs } = plan;
  if (stops.length < 2 || legs.length !== stops.length - 1) {
    return [];
  }

  const boundaries = rangeLegBoundaryIndices(stops);
  if (boundaries.length < 2) {
    return [];
  }

  const usableMi = metricsOpts ? usableRangeMilesFromOpts(metricsOpts) : null;

  const out: RangeLegSummary[] = [];

  for (let r = 0; r < boundaries.length - 1; r++) {
    const a = boundaries[r];
    const b = boundaries[r + 1];
    if (a >= b) continue;

    let travelTimeMinutes = 0;
    let chargeTimeMinutes = 0;
    for (let i = a; i < b; i++) {
      const leg = legs[i] as ItineraryLeg;
      travelTimeMinutes += typeof leg.travelTimeMinutes === "number" ? leg.travelTimeMinutes : 0;
      chargeTimeMinutes += typeof leg.chargeTimeMinutes === "number" ? leg.chargeTimeMinutes : 0;
    }

    let chordMilesApprox = 0;
    let maxHopChordMilesApprox = 0;
    for (let i = a; i < b; i++) {
      const d = haversineMiles(stops[i].coords, stops[i + 1].coords);
      chordMilesApprox += d;
      if (d > maxHopChordMilesApprox) maxHopChordMilesApprox = d;
    }

    const slice = stops.slice(a, b + 1);
    const row: RangeLegSummary = {
      index: out.length,
      fromStopId: stops[a].id,
      toStopId: stops[b].id,
      stopIds: slice.map((s) => s.id),
      travelTimeMinutes,
      chargeTimeMinutes,
      chordMilesApprox
    };

    if (usableMi != null) {
      row.usableRangeMiles = Math.round(usableMi * 1000) / 1000;
      row.maxHopChordMilesApprox = Math.round(maxHopChordMilesApprox * 1000) / 1000;
      row.maxHopExceedsRangeBudget = maxHopChordMilesApprox > usableMi;
    }

    out.push(row);
  }

  return out;
}

/** Attach `rangeLegs` (and mirror into `debug`) for successful plans. */
export function attachRangeLegsToOkPlan(
  res: PlanTripResponse,
  metricsOpts?: RangeLegMetricsOpts
): PlanTripResponse {
  if (res.status !== "ok" || res.stops.length < 2) {
    return res;
  }
  const opts = metricsOpts ?? readRangeLegMetricsOptsFromEnv();
  const rangeLegs = computeRangeLegs(res, opts);
  if (rangeLegs.length === 0) {
    return res;
  }
  const debugExtra: Record<string, unknown> = {};
  if (opts) {
    debugExtra.rangeLegMetrics = {
      model: "max_hop_chord_vs_usable_range",
      rangeMiles: opts.rangeMiles,
      bufferSoc: opts.bufferSoc,
      usableRangeMiles: Math.round(usableRangeMilesFromOpts(opts) * 1000) / 1000
    };
  }
  const socOpts = readSocReplayOptsFromEnv();
  if (socOpts) {
    const socReplay = computeSocReplay(res, socOpts);
    if (socReplay) {
      debugExtra.socReplay = socReplay;
    }
  }
  return {
    ...res,
    rangeLegs,
    debug: {
      ...(res.debug ?? {}),
      ...debugExtra,
      rangeLegs
    }
  };
}
