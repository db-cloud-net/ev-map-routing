import type { LatLng, ItineraryLeg, ItineraryStop, PlanTripResponse } from "../types";
import type { CanonicalCharger } from "../corridor/providerContracts";
import {
  NoFeasibleItineraryError,
  planLeastTimeSegment,
  type PlannedSegment,
  type RangeLegFeasibilityDebug,
  type RangeLegOptimizerDebug
} from "./leastTimeSegment";
import { mergeSegmentPrefixIntoTripSnapshot } from "./refinementPrefixMerge";
import { computeRangeLegs, readRangeLegMetricsOptsFromEnv } from "./rangeLegs";
import { departSocFractionAfterSegmentForNextHop } from "./socReplay";
import type { OnSolverAttempt } from "./planTripOneLeg";

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
  onSolverAttempt?: OnSolverAttempt;
  precomputedEdgeTravelMinutes?: Map<string, number>;
  precomputedEdgeDistanceMiles?: Map<string, number>;

  // Optional POI-backed sleep feasibility constraint (used by constrained Dijkstra).
  sleepEligibleChargerIds?: Set<string>;
  maxSleepMiles?: number;
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

  const segmentsAttempted: Array<Record<string, unknown>> = [];
  let rangeLegOptimizerForDebug: RangeLegOptimizerDebug | undefined;
  let rangeLegFeasibilityForDebug: RangeLegFeasibilityDebug | undefined;
  const rangeLegMetricsOpts = readRangeLegMetricsOptsFromEnv();
  const prefixRefinementEnabled =
    Boolean(input.onSolverAttempt) &&
    (process.env.PLAN_SEGMENT_PREFIX_REFINEMENT_CHECKPOINTS ?? "true").toLowerCase() !== "false";

  const socCarryChained =
    (process.env.PLAN_SOC_CARRY_CHAINED_SEGMENTS ?? "true").toLowerCase() !== "false";
  let lastSeg: PlannedSegment | null = null;
  const socCarryChain: Array<{ chainIndex: number; initialDepartSocFraction: number }> = [];

  try {
    for (let i = 0; i < points.length; i++) {
      const b = points[i];
      const segAttempt: Record<string, unknown> = {
        chainIndex: i,
        segmentStartId,
        toId: b.id,
        toKind: b.kind,
        chargersPoolCount: chargersPool.length
      };
      segmentsAttempted.push(segAttempt);

      let initialDepartSocFraction: number | undefined;
      if (i > 0 && socCarryChained && lastSeg) {
        initialDepartSocFraction = departSocFractionAfterSegmentForNextHop(
          lastSeg.stops,
          lastSeg.legs,
          rangeMiles,
          bufferSoc,
          b.coords,
          b.kind === "end" ? "end" : "charge"
        );
        socCarryChain.push({ chainIndex: i, initialDepartSocFraction });
        segAttempt.initialDepartSocFraction = initialDepartSocFraction;
      }

      const onPrefixRefinement = prefixRefinementEnabled
        ? async (p: {
            hopIndex: number;
            stopsPrefix: ItineraryStop[];
            legsPrefix: ItineraryLeg[];
            totalLegsInPath: number;
          }) => {
            if (p.hopIndex === p.totalLegsInPath - 1) return;
            const merged = mergeSegmentPrefixIntoTripSnapshot(
              overallStops,
              overallLegs,
              p.stopsPrefix,
              p.legsPrefix,
              p.stopsPrefix.length,
              timeOffset
            );
            if (merged.stops.length < 2 || merged.legs.length !== merged.stops.length - 1) return;
            const rangeLegs = computeRangeLegs(
              { stops: merged.stops, legs: merged.legs },
              rangeLegMetricsOpts
            );
            input.onSolverAttempt?.({
              legIndex: input.legIndex ?? 0,
              attempt: {
                kind: "partial_route",
                reason: `segment_refine_hop_${p.hopIndex}`,
                refinement: {
                  kind: "segment_prefix",
                  hopIndex: p.hopIndex,
                  totalHopsInSegment: p.totalLegsInPath,
                  lockedChainIndex: i
                },
                partialSnapshot: {
                  stops: JSON.parse(JSON.stringify(merged.stops)),
                  legs: JSON.parse(JSON.stringify(merged.legs)),
                  rangeLegs
                }
              }
            });
          }
        : undefined;

      const segmentCommon = {
        requestId: input.requestId,
        segmentStart: { id: segmentStartId, type: "start" as const, coords: segmentStartCoords },
        segmentEnd: { id: b.id, type: "end" as const, coords: b.coords },
        chargers: chargersPool,
        rangeMiles,
        bufferSoc,
        batteryKwh,
        precomputedEdgeTravelMinutes: input.precomputedEdgeTravelMinutes,
        precomputedEdgeDistanceMiles: input.precomputedEdgeDistanceMiles,
        ...(initialDepartSocFraction != null ? { initialDepartSocFraction } : {}),
        ...(onPrefixRefinement ? { onPrefixRefinement } : {})
      };

      let seg;
      try {
        seg = await planLeastTimeSegment({
          ...segmentCommon,
          sleepEligibleChargerIds: input.sleepEligibleChargerIds,
          maxSleepMiles: input.maxSleepMiles
        });
      } catch (e) {
        if (
          e instanceof NoFeasibleItineraryError &&
          input.sleepEligibleChargerIds != null &&
          input.maxSleepMiles != null
        ) {
          // Constrained Dijkstra had no feasible path; fall back to greedy/least-time.
          segAttempt.constrainedFallbackNoPath = true;
          segAttempt.solverDebug = e.debug;
          seg = await planLeastTimeSegment(segmentCommon);
        } else {
          segAttempt.solverStatus = "error";
          segAttempt.errorMessage = e instanceof Error ? e.message : String(e);
          if (e instanceof NoFeasibleItineraryError) {
            segAttempt.solverDebug = e.debug;
          }
          input.onSolverAttempt?.({
            legIndex: input.legIndex ?? 0,
            attempt: JSON.parse(JSON.stringify(segAttempt)) as Record<string, unknown>
          });
          throw e;
        }
      }

      segAttempt.solverStatus = "ok";
      segAttempt.totalTimeMinutes = seg.totalTimeMinutes;
      segAttempt.stopsCount = seg.stops.length;
      segAttempt.chargeStopsCount = seg.stops.filter((s) => s.type === "charge").length;
      segAttempt.legsCount = seg.legs.length;

      input.onSolverAttempt?.({
        legIndex: input.legIndex ?? 0,
        attempt: JSON.parse(JSON.stringify(segAttempt)) as Record<string, unknown>
      });

      if (seg.segmentOptimizerDebug?.rangeLegOptimizer) {
        rangeLegOptimizerForDebug = seg.segmentOptimizerDebug.rangeLegOptimizer;
      }
      if (seg.segmentOptimizerDebug?.rangeLegFeasibility) {
        rangeLegFeasibilityForDebug = seg.segmentOptimizerDebug.rangeLegFeasibility;
      }

      lastSeg = seg;

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
    let msg = e instanceof Error ? e.message : "No feasible itinerary with locked chargers";
    const code = "INFEASIBLE_CHARGER_LOCK";
    if (e instanceof NoFeasibleItineraryError) {
      const d = e.debug;
      const detail = typeof d.message === "string" ? d.message.trim() : "";
      if (detail) {
        msg = `${msg} — ${detail}`;
      }
    }
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
          ? {
              lockedChargerChain: true,
              segmentsAttempted,
              solverDebug: e.debug,
              noFeasibleItinerary: e.debug
            }
          : { lockedChargerChain: true, segmentsAttempted }
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
        overnightThresholdMinutes,
        segmentsAttempted
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

  const okDebug: Record<string, unknown> = {
    lockedChargerChain: true,
    legIndex: input.legIndex ?? 0,
    segmentsAttempted
  };
  if (rangeLegOptimizerForDebug) {
    okDebug.rangeLegOptimizer = rangeLegOptimizerForDebug;
  }
  if (rangeLegFeasibilityForDebug) {
    okDebug.rangeLegFeasibility = rangeLegFeasibilityForDebug;
  }
  if (socCarryChain.length > 0) {
    okDebug.socCarryChainedSegments = socCarryChain;
  }

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
    debug: okDebug
  };
}
