import type {
  ItineraryLeg,
  ItineraryStop,
  LatLng,
  PlanTripResponse,
  TripLegPlanningContext
} from "../types";
import type { CanonicalCharger, CanonicalPoiHotel } from "../corridor/providerContracts";
import {
  NoFeasibleItineraryError,
  planLeastTimeSegment,
  type PlannedSegment,
  type RangeLegFeasibilityDebug,
  type RangeLegOptimizerDebug
} from "./leastTimeSegment";
import { planTripOneLegLockedChargerChain } from "./planTripOneLegLocked";
import { haversineMiles } from "./geo";
import { resolvePlanProviders, sourceRoutingDebugFromMeta } from "../sourceRouter";
import { fetchCorridorChargersForLeg } from "./corridorCandidates";
import { computeRangeLegs, readRangeLegMetricsOptsFromEnv } from "./rangeLegs";
import { mergeSegmentPrefixIntoTripSnapshot } from "./refinementPrefixMerge";
import { appendPoiCorridorReviewLine } from "../services/poiReviewLog";
import type { PoiServicesPoi } from "../services/poiServicesTypes";
import { withTimeout } from "../planTimeout";
import { departSocFractionAfterSegmentForNextHop } from "./socReplay";

function filterHotelsNear(
  coords: LatLng,
  hotels: CanonicalPoiHotel[],
  radiusMeters: number
): CanonicalPoiHotel[] {
  return hotels.filter((h) => haversineMiles(coords, h.coords) * 1609.34 <= radiusMeters);
}

function reorderHotelsWithLockedFirst(
  hotels: CanonicalPoiHotel[],
  lockedHotelId: string | undefined
): CanonicalPoiHotel[] {
  if (!lockedHotelId) return hotels;
  const idx = hotels.findIndex((h) => h.id === lockedHotelId);
  if (idx <= 0) return hotels;
  return [hotels[idx], ...hotels.slice(0, idx), ...hotels.slice(idx + 1)];
}

function nearestChargerByHaversine(
  target: LatLng,
  chargers: Array<{ coords: LatLng }>
): { haversineMi: number } | null {
  let best: number | null = null;
  for (const ch of chargers) {
    const d = haversineMiles(target, ch.coords);
    if (best == null || d < best) best = d;
  }
  return best == null ? null : { haversineMi: best };
}

/** Fired when a `debug.segmentsAttempted` row is finalized (incremental trust / plan jobs). */
export type OnSolverAttempt = (ev: {
  legIndex: number;
  attempt: Record<string, unknown>;
}) => void;

export type PlanTripOneLegInput = {
  requestId: string;
  responseVersion: string;
  startCoords: LatLng;
  endCoords: LatLng;
  /** Segment end stop id passed to least-time solver (e.g. "end" or "via-0"). */
  endStopId: string;
  /** Start id for this leg (e.g. "start" or "via-0"). */
  segmentStartId: string;
  startQueryLabel?: string;
  endQueryLabel?: string;
  /** When true, response includes `candidates` for map layers (same ID universe as planning). */
  includeCandidates?: boolean;
  legIndex?: number;
  /** Ordered charger ids that must be visited on this leg (hard constraint; segmented chain). */
  lockedChargerIdsOrdered?: string[];
  /** Prefer this Overpass hotel id when inserting an overnight sleep stop. */
  lockedHotelId?: string;
  onSolverAttempt?: OnSolverAttempt;
} & TripLegPlanningContext;

export async function planTripOneLegFromCoords(
  input: PlanTripOneLegInput
): Promise<PlanTripResponse> {
  /** Wall time from start of this leg planner (for phase instrumentation). */
  const planLegWallT0 = Date.now();

  const notifySolverAttempt = (attempt: Record<string, unknown>) => {
    input.onSolverAttempt?.({
      legIndex: input.legIndex ?? 0,
      attempt: JSON.parse(JSON.stringify(attempt)) as Record<string, unknown>
    });
  };

  const debug: Record<string, unknown> = {
    segmentsAttempted: [],
    overnightAnchors: [] as Array<{
      chargerId: string;
      chargerName: string;
      hotelFound: boolean;
      chosen?: boolean;
    }>
  };

  let rangeLegOptimizerForDebug: RangeLegOptimizerDebug | undefined;
  let rangeLegFeasibilityForDebug: RangeLegFeasibilityDebug | undefined;
  const captureSegmentOptimizer = (seg: PlannedSegment) => {
    if (seg.segmentOptimizerDebug?.rangeLegOptimizer) {
      rangeLegOptimizerForDebug = seg.segmentOptimizerDebug.rangeLegOptimizer;
    }
    if (seg.segmentOptimizerDebug?.rangeLegFeasibility) {
      rangeLegFeasibilityForDebug = seg.segmentOptimizerDebug.rangeLegFeasibility;
    }
  };

  const enablePlanRequestLogging =
    (process.env.PLAN_LOG_REQUESTS ?? "true").toLowerCase() === "true";
  const deploymentEnv = (process.env.DEPLOYMENT_ENV ?? "dev-local").trim().toLowerCase();
  const logEvent = (
    event: string,
    data: Record<string, unknown> = {}
  ) => {
    if (!enablePlanRequestLogging) return;
    console.log(
      JSON.stringify({
        event,
        deploymentEnv,
        requestId: input.requestId,
        ...data
      })
    );
  };

  const phaseLog = (phase: string, data: Record<string, unknown> = {}) => {
    if (!enablePlanRequestLogging) return;
    console.log(
      JSON.stringify({
        event: "plan_leg_phase",
        deploymentEnv,
        requestId: input.requestId,
        legIndex: input.legIndex ?? 0,
        phase,
        legElapsedMs: Date.now() - planLegWallT0,
        ...data
      })
    );
  };

  try {
    phaseLog("try_begin");
    const providers = resolvePlanProviders({
      requestId: input.requestId
    });
    debug.sourceRouting = sourceRoutingDebugFromMeta(providers.meta);

    const rangeMiles = Number(process.env.EV_RANGE_MILES ?? "260");
    const bufferSoc = Number(process.env.CHARGE_BUFFER_SOC ?? "0");
    const rangeLegMetricsOpts = readRangeLegMetricsOptsFromEnv();
    const prefixRefinementEnabled =
      Boolean(input.onSolverAttempt) &&
      (process.env.PLAN_SEGMENT_PREFIX_REFINEMENT_CHECKPOINTS ?? "true").toLowerCase() !== "false";
    const batteryKwh = Number(process.env.BATTERY_KWH ?? "72");
    const overnightThresholdMinutes = Number(
      process.env.OVERNIGHT_THRESHOLD_MINUTES ?? "600"
    );
    const sleepMinutes = Number(process.env.SLEEP_MINUTES ?? "480");
    const maxOvernightStops = Number(process.env.MAX_OVERNIGHT_STOPS ?? "3");
    const hotelRadiusMeters = Number(process.env.HOTEL_RADIUS_METERS ?? "365.76");
    const hotelRadiusYards = Math.round(hotelRadiusMeters / 0.9144);
    const overnightHotelRadiusMeters = Number(
      process.env.OVERNIGHT_HOTEL_RADIUS_METERS ?? String(hotelRadiusMeters)
    );
    const overnightHotelRadiusYards = Math.round(
      overnightHotelRadiusMeters / 0.9144
    );
    const segmentTimeoutMs = Number(process.env.PLAN_SEGMENT_TIMEOUT_MS ?? "180000");
    const elapsedMinutesFromTripStart = Number.isFinite(input.elapsedMinutesFromTripStart)
      ? Math.max(0, Number(input.elapsedMinutesFromTripStart))
      : 0;
    const tripProgressMilesFromTripStart = Number.isFinite(input.tripProgressMilesFromTripStart)
      ? Math.max(0, Number(input.tripProgressMilesFromTripStart))
      : 0;
    const tripLegIndex = Number.isFinite(input.tripLegIndex) ? Number(input.tripLegIndex) : input.legIndex ?? 0;
    const tripLegCount = Number.isFinite(input.tripLegCount) ? Number(input.tripLegCount) : 1;
    const hotelCache = new Map<string, CanonicalPoiHotel[]>();

    const startCoords = input.startCoords;
    const endCoords = input.endCoords;
    logEvent("plan_leg_coords", {
      legIndex: input.legIndex ?? 0,
      segmentStartId: input.segmentStartId,
      endStopId: input.endStopId,
      startLabel: input.startQueryLabel,
      endLabel: input.endQueryLabel
    });

    const candidateChargersCap = Number(process.env.CANDIDATE_CHARGERS_CAP ?? "25");

    // 2) Fetch candidate DC fast chargers along corridor (shared with POST /candidates).
    const corridorFetchT0 = Date.now();
    logEvent("planner_corridor_fetch_start", {
      legIndex: input.legIndex ?? 0,
      segmentStartId: input.segmentStartId,
      endStopId: input.endStopId
    });
    const corridor = await fetchCorridorChargersForLeg({
      requestId: input.requestId,
      legIndex: input.legIndex ?? 0,
      startCoords,
      endCoords,
      includeCandidates: Boolean(input.includeCandidates),
      logEvent,
      overnightHotelRadiusMeters
    });
    logEvent("planner_corridor_fetch_end", {
      legIndex: input.legIndex ?? 0,
      segmentStartId: input.segmentStartId,
      endStopId: input.endStopId,
      durationMs: Date.now() - corridorFetchT0,
      ok: corridor.ok,
      ...(corridor.ok
        ? { chargersFoundTotal: corridor.chargers.length }
        : { message: corridor.message, errorCode: corridor.errorCode ?? null })
    });
    phaseLog("after_corridor_fetch", { ok: corridor.ok });

    if (!corridor.ok) {
      return {
        requestId: input.requestId,
        responseVersion: input.responseVersion,
        status: "error",
        message: corridor.message,
        ...(corridor.errorCode ? { errorCode: corridor.errorCode } : {}),
        debug: { ...debug, ...corridor.debug },
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

    debug.chargersFoundTotal = corridor.debug.chargersFoundTotal;
    debug.corridorSampling = corridor.debug.corridorSampling;

    const corridorUsedPoi = corridor.usedPoiServices === true;
    const poiHotelsForOvernight = corridor.poiCorridorHotels;
    const pairChargerByHotelId = corridor.pairChargerByHotelId ?? {};
    const poiCorridorHotelPois = corridor.poiCorridorHotelPois;
    const poiDcfcByPoiIntId = corridor.poiDcfcByPoiIntId;

    const chargers = corridor.chargers;
    const candidatesForResponse = corridor.candidatesForResponse;
    const precomputedEdgeTravelMinutes = corridor.precomputedEdgeTravelMinutes;
    const precomputedEdgeDistanceMiles = corridor.precomputedEdgeDistanceMiles;

    const usePoiConstrained = (process.env.USE_POI_CONSTRAINED_DIJKSTRA ?? "false").toLowerCase() === "true";
    const maxSleepMiles = 600;
    let constrainedGraphUsable = false;
    const edgeGraphChargers = new Set<string>();
    const sleepEligibleChargerIds = new Set<string>();
    if (
      usePoiConstrained &&
      corridorUsedPoi &&
      precomputedEdgeDistanceMiles &&
      precomputedEdgeDistanceMiles.size > 0
    ) {
      for (const c of Object.values(pairChargerByHotelId ?? {})) {
        sleepEligibleChargerIds.add(c.id);
      }

      // Build a lightweight POI edge adjacency to check graph usability + derive
      // which chargers participate in the POI edge graph.
      const chargerIdSet = new Set(chargers.map((c) => c.id));
      const adj = new Map<string, string[]>();
      const edgeGraphNodeIds = new Set<string>();
      for (const [key] of precomputedEdgeDistanceMiles.entries()) {
        const [fromId, toId] = key.split("|");
        if (!chargerIdSet.has(fromId) || !chargerIdSet.has(toId)) continue;
        edgeGraphNodeIds.add(fromId);
        edgeGraphNodeIds.add(toId);
        const arr = adj.get(fromId) ?? [];
        arr.push(toId);
        adj.set(fromId, arr);
      }
      const hasGraph =
        adj.size >= 2 && Array.from(adj.values()).some((neighbors) => neighbors.length > 0);
      if (hasGraph && sleepEligibleChargerIds.size > 0) {
        constrainedGraphUsable = true;
        for (const id of edgeGraphNodeIds) edgeGraphChargers.add(id);
      } else if (usePoiConstrained) {
        logEvent("poi_graph_unusable", {
          legIndex: input.legIndex ?? 0,
          hasGraph,
          edgeCount: precomputedEdgeDistanceMiles.size,
          sleepEligibleChargerCount: sleepEligibleChargerIds.size
        });
      }
    }

    // If POI was used but we didn't get a usable edges graph for constrained solving,
    // log once (the constrained attempt will just be skipped and we fall back to greedy).
    if (
      usePoiConstrained &&
      corridorUsedPoi &&
      (!precomputedEdgeDistanceMiles || precomputedEdgeDistanceMiles.size === 0)
    ) {
      const sleepEligibleChargerCount = Object.values(pairChargerByHotelId ?? {}).length;
      logEvent("poi_graph_unusable", {
        legIndex: input.legIndex ?? 0,
        hasGraph: false,
        edgeCount: precomputedEdgeDistanceMiles?.size ?? 0,
        sleepEligibleChargerCount
      });
    }

    logEvent("plan_leg_solver_config", {
      legIndex: input.legIndex ?? 0,
      tripLegIndex,
      tripLegCount,
      elapsedMinutesFromTripStart,
      tripProgressMilesFromTripStart,
      usePoiConstrainedEnv: usePoiConstrained,
      candidateChargersCap,
      corridorUsedPoi,
      constrainedGraphUsable,
      edgeGraphChargersCount: edgeGraphChargers.size,
      corridorChargersTotal: chargers.length
    });

    // Important: NREL results are not guaranteed to be sorted by distance.
    // We will pick the nearest candidates per segment below.
    const chargerCandidates = chargers;

    // Fast progressive checkpoint: emit a first analyzed hop (start -> next likely charger)
    // so the map can show piecewise planning early on long routes.
    if (input.onSolverAttempt && chargerCandidates.length) {
      try {
        const allUsable = chargerCandidates
          .filter((c: any) => Number.isFinite(c.coords?.lat) && Number.isFinite(c.coords?.lon))
        const reachable = allUsable.filter(
          (c: any) => haversineMiles(startCoords, c.coords) <= rangeMiles
        );
        const improving = allUsable.filter(
          (c: any) =>
            haversineMiles(c.coords, endCoords) + 1 < haversineMiles(startCoords, endCoords)
        );
        // Prefer chargers that improve end distance; if none, fall back to any corridor charger.
        const targetPool = improving.length ? improving : reachable.length ? reachable : allUsable;
        const firstTarget = [...targetPool].sort((a: any, b: any) => {
          const dEndA = haversineMiles(a.coords, endCoords);
          const dEndB = haversineMiles(b.coords, endCoords);
          if (dEndA !== dEndB) return dEndA - dEndB;
          return haversineMiles(startCoords, b.coords) - haversineMiles(startCoords, a.coords);
        })[0];

        if (firstTarget) {
          const avgSpeedMph = Number(process.env.AVG_SPEED_MPH ?? "62");
          const dMilesFirst = haversineMiles(startCoords, firstTarget.coords);
          const dMilesToEnd = haversineMiles(firstTarget.coords, endCoords);
          const travelTimeMinutesFirst = (dMilesFirst / Math.max(5, avgSpeedMph)) * 60;
          const travelTimeMinutesSecond = (dMilesToEnd / Math.max(5, avgSpeedMph)) * 60;
          const firstHopStops = [
            {
              id: input.segmentStartId,
              type: "start",
              name: input.startQueryLabel ?? "start",
              coords: startCoords,
              etaMinutesFromStart: 0
            },
            {
              id: String(firstTarget.id),
              type: "charge",
              name: firstTarget.name,
              coords: firstTarget.coords,
              etaMinutesFromStart: travelTimeMinutesFirst
            },
            {
              id: input.endStopId,
              type: "end",
              name: input.endQueryLabel ?? "end",
              coords: endCoords,
              etaMinutesFromStart: travelTimeMinutesFirst + travelTimeMinutesSecond
            }
          ];
          const firstHopLegs = [
            {
              fromStopId: input.segmentStartId,
              toStopId: String(firstTarget.id),
              travelTimeMinutes: travelTimeMinutesFirst
            },
            {
              fromStopId: String(firstTarget.id),
              toStopId: input.endStopId,
              travelTimeMinutes: travelTimeMinutesSecond
            }
          ];
          input.onSolverAttempt({
            legIndex: input.legIndex ?? 0,
            attempt: {
              kind: "partial_route",
              reason: "quick_first_segment_estimate",
              partialSnapshot: {
                stops: firstHopStops,
                legs: firstHopLegs,
                rangeLegs: computeRangeLegs({
                  stops: firstHopStops as any,
                  legs: firstHopLegs as any
                })
              }
            }
          });
        }
      } catch {
        // Best-effort only; normal solver flow continues.
      }
    }

    if (input.lockedChargerIdsOrdered?.length) {
      const finalEnd = { id: input.endStopId, type: "end" as const, coords: endCoords };
      const currentStart = { id: input.segmentStartId, coords: startCoords };
      const byId = new Map(chargerCandidates.map((c) => [String(c.id), c]));
      const orderedLocked: CanonicalCharger[] = [];
      for (const id of input.lockedChargerIdsOrdered) {
        const c = byId.get(String(id));
        if (!c) {
          return {
            requestId: input.requestId,
            responseVersion: input.responseVersion,
            status: "error",
            errorCode: "UNKNOWN_CHARGER_LOCK",
            message: `Locked charger id is not available on this corridor (re-run with includeCandidates or pick a charger from the map): ${id}`,
            stops: [],
            legs: [],
            totals: {
              travelTimeMinutes: 0,
              chargeTimeMinutes: 0,
              sleepTimeMinutes: 0,
              totalTimeMinutes: 0,
              overnightStopsCount: 0
            },
            debug: { ...debug, lockedChargerMiss: id, legIndex: input.legIndex ?? 0 }
          };
        }
        orderedLocked.push(c);
      }

      const chargersForSegment = chargerCandidates
        .filter((c: any) => Number.isFinite(c.coords?.lat) && Number.isFinite(c.coords?.lon))
        .slice();

      const endReachable = chargersForSegment.filter(
        (c: any) => haversineMiles(finalEnd.coords, c.coords) <= rangeMiles
      );

      const startSorted = chargersForSegment
        .map((c: any) => ({
          c,
          dMiles: haversineMiles(currentStart.coords, c.coords)
        }))
        .sort((a, b) => a.dMiles - b.dMiles)
        .map((x) => x.c);

      const seenCombine = new Set<string>();
      const combined: any[] = [];
      const pushUnique = (ch: any) => {
        const cid = String(ch.id ?? `${ch.coords.lat}:${ch.coords.lon}`);
        if (seenCombine.has(cid)) return;
        seenCombine.add(cid);
        combined.push(ch);
      };

      for (const c of endReachable) pushUnique(c);
      for (const c of startSorted) pushUnique(c);

      const progressSorted = combined
        .map((ch) => ({
          ch,
          dMiles: haversineMiles(currentStart.coords, ch.coords)
        }))
        .sort((a, b) => a.dMiles - b.dMiles)
        .map((x) => x.ch);

      const pickEvenlySpaced = (arr: any[], cap: number) => {
        if (arr.length <= cap) return arr;
        if (cap <= 1) return arr.slice(0, 1);

        const picked: any[] = [];
        const seen = new Set<string>();
        const lastIdx = arr.length - 1;

        for (let i = 0; i < cap; i++) {
          const idx = Math.round((i * lastIdx) / (cap - 1));
          const ch = arr[idx];
          const cid = String(ch.id ?? `${ch.coords.lat}:${ch.coords.lon}`);
          if (seen.has(cid)) continue;
          seen.add(cid);
          picked.push(ch);
        }

        if (picked.length < cap) {
          for (const ch of arr) {
            const cid = String(ch.id ?? `${ch.coords.lat}:${ch.coords.lon}`);
            if (seen.has(cid)) continue;
            seen.add(cid);
            picked.push(ch);
            if (picked.length >= cap) break;
          }
        }

        return picked;
      };

      let capped: any[] = [];
      if (constrainedGraphUsable) {
        // Keep all chargers that participate in the POI edge graph (so the constrained
        // solver doesn't get starved by downsampling), and downsample the rest.
        const edgePicked = progressSorted.filter((ch: any) => edgeGraphChargers.has(String(ch.id)));
        const nonEdgeSorted = progressSorted.filter(
          (ch: any) => !edgeGraphChargers.has(String(ch.id))
        );
        const remainingCap = Math.max(0, candidateChargersCap - edgePicked.length);
        const nonEdgePicked =
          remainingCap > 0 ? pickEvenlySpaced(nonEdgeSorted, remainingCap) : [];
        capped = [...edgePicked, ...nonEdgePicked];
      } else {
        capped = pickEvenlySpaced(progressSorted, candidateChargersCap);
      }

      if (endReachable.length) {
        const endReachableIds = new Set(
          endReachable.map((c: any) => String(c.id ?? `${c.coords.lat}:${c.coords.lon}`))
        );
        const cappedHasEndReachable = capped.some((c: any) =>
          endReachableIds.has(String(c.id ?? `${c.coords.lat}:${c.coords.lon}`))
        );

        if (!cappedHasEndReachable) {
          const bestEnd = [...endReachable].sort(
            (a: any, b: any) =>
              haversineMiles(finalEnd.coords, a.coords) - haversineMiles(finalEnd.coords, b.coords)
          )[0];
          if (bestEnd) {
            if (capped.length > 0) {
              capped[capped.length - 1] = bestEnd;
            } else {
              capped = [bestEnd];
            }
          }
        }
      }

      const seenPool = new Set<string>();
      const chargersPool: CanonicalCharger[] = [];
      for (const ch of capped) {
        const cid = String(ch.id);
        if (seenPool.has(cid)) continue;
        seenPool.add(cid);
        chargersPool.push(ch);
      }
      for (const ch of orderedLocked) {
        const cid = String(ch.id);
        if (seenPool.has(cid)) continue;
        seenPool.add(cid);
        chargersPool.push(ch);
      }

      return planTripOneLegLockedChargerChain({
        requestId: input.requestId,
        responseVersion: input.responseVersion,
        segmentStartId: input.segmentStartId,
        startCoords,
        endStopId: input.endStopId,
        endCoords,
        orderedLockedChargers: orderedLocked,
        chargersPool,
        rangeMiles,
        bufferSoc,
        batteryKwh,
        overnightThresholdMinutes,
        candidatesForResponse,
        legIndex: input.legIndex,
        onSolverAttempt: input.onSolverAttempt,
        precomputedEdgeTravelMinutes,
        precomputedEdgeDistanceMiles,
        sleepEligibleChargerIds: constrainedGraphUsable ? sleepEligibleChargerIds : undefined,
        maxSleepMiles: constrainedGraphUsable ? maxSleepMiles : undefined
      });
    }

    // 3) Build itinerary with up to N overnight insertions.
    const finalEnd = { id: input.endStopId, type: "end" as const, coords: endCoords };

    let overallStops: any[] = [];
    let overallLegs: any[] = [];
    let sleepTimeMinutesTotal = 0;
    let overnightStopsCount = 0;
    let lastHotelMessage: string | undefined;
    let elapsedMinutesAtCurrentStart = elapsedMinutesFromTripStart;

    /** Incremental trust: emit route + presentation `rangeLegs` for planJob poll / future streaming. */
    const emitPartialRouteSnapshot = (reason: string) => {
      if (!input.onSolverAttempt) return;
      if (overallStops.length < 2) return;
      if (overallLegs.length !== overallStops.length - 1) return;
      const rangeLegs = computeRangeLegs(
        { stops: overallStops, legs: overallLegs },
        rangeLegMetricsOpts
      );
      notifySolverAttempt({
        kind: "partial_route",
        reason,
        partialSnapshot: {
          stops: JSON.parse(JSON.stringify(overallStops)),
          legs: JSON.parse(JSON.stringify(overallLegs)),
          rangeLegs
        }
      });
    };

    const createSegmentPrefixHandler = (
      overIdx: number | null,
      elapsedTripOffset: number,
      baseStops: ItineraryStop[],
      baseLegs: ItineraryLeg[]
    ) => {
      return async (p: {
        hopIndex: number;
        stopsPrefix: ItineraryStop[];
        legsPrefix: ItineraryLeg[];
        totalLegsInPath: number;
      }) => {
        if (p.hopIndex === p.totalLegsInPath - 1) return;
        const merged = mergeSegmentPrefixIntoTripSnapshot(
          baseStops,
          baseLegs,
          p.stopsPrefix,
          p.legsPrefix,
          p.stopsPrefix.length,
          elapsedTripOffset
        );
        if (merged.stops.length < 2 || merged.legs.length !== merged.stops.length - 1) return;
        const rangeLegs = computeRangeLegs(
          { stops: merged.stops, legs: merged.legs },
          rangeLegMetricsOpts
        );
        notifySolverAttempt({
          kind: "partial_route",
          reason: `segment_refine_hop_${p.hopIndex}`,
          refinement: {
            kind: "segment_prefix",
            hopIndex: p.hopIndex,
            totalHopsInSegment: p.totalLegsInPath,
            ...(overIdx != null ? { overnightIndex: overIdx } : { segment: "remainder" })
          },
          partialSnapshot: {
            stops: JSON.parse(JSON.stringify(merged.stops)),
            legs: JSON.parse(JSON.stringify(merged.legs)),
            rangeLegs
          }
        });
      };
    };

    let currentStart = { id: input.segmentStartId, coords: startCoords };

    const socCarryOvernight =
      (process.env.PLAN_SOC_CARRY_OVERNIGHT_SEGMENTS ?? "true").toLowerCase() !== "false";
    const socCarryOvernightLog: Array<{
      kind: "overnight_iteration" | "remainder";
      overnightIndex?: number;
      initialDepartSocFraction: number;
    }> = [];

    for (let overnightIndex = 0; overnightIndex < maxOvernightStops; overnightIndex++) {
      const segmentAttempt: Record<string, unknown> = {
        overnightIndex,
        segmentStartId: currentStart.id
      };
      const chargersForSegment = chargerCandidates
        // Candidate selection must include chargers near both the start and the end.
        // Otherwise, the segment planner can’t reach the destination with the
        // SOC-buffer constraints.
        .filter((c: any) => Number.isFinite(c.coords?.lat) && Number.isFinite(c.coords?.lon))
        .slice(); // force evaluation

      const endReachable = chargersForSegment
        .filter((c: any) => haversineMiles(finalEnd.coords, c.coords) <= rangeMiles);

      const startSorted = chargersForSegment
        .map((c: any) => ({
          c,
          dMiles: haversineMiles(currentStart.coords, c.coords)
        }))
        .sort((a, b) => a.dMiles - b.dMiles)
        .map((x) => x.c);

      const seen = new Set<string>();
      const combined: any[] = [];
      const pushUnique = (ch: any) => {
        const id = String(ch.id ?? `${ch.coords.lat}:${ch.coords.lon}`);
        if (seen.has(id)) return;
        seen.add(id);
        combined.push(ch);
      };

      for (const c of endReachable) pushUnique(c);
      for (const c of startSorted) pushUnique(c);

      // Cap candidates in a way that preserves mid-corridor connectivity.
      // Instead of taking the first N by (start/end) bias, we:
      // 1) compute approximate "progress" from currentStart,
      // 2) sort by that progress,
      // 3) take evenly-spaced representatives across the sorted set.
      const progressSorted = combined
        .map((ch) => ({
          ch,
          dMiles: tripProgressMilesFromTripStart + haversineMiles(currentStart.coords, ch.coords)
        }))
        .sort((a, b) => a.dMiles - b.dMiles)
        .map((x) => x.ch);

      const pickEvenlySpaced = (arr: any[], cap: number) => {
        if (arr.length <= cap) return arr;
        if (cap <= 1) return arr.slice(0, 1);

        const picked: any[] = [];
        const seen = new Set<string>();
        const lastIdx = arr.length - 1;

        for (let i = 0; i < cap; i++) {
          const idx = Math.round((i * lastIdx) / (cap - 1));
          const ch = arr[idx];
          const id = String(ch.id ?? `${ch.coords.lat}:${ch.coords.lon}`);
          if (seen.has(id)) continue;
          seen.add(id);
          picked.push(ch);
        }

        // If rounding caused duplicates to reduce count, fill nearest from the left.
        if (picked.length < cap) {
          for (const ch of arr) {
            const id = String(ch.id ?? `${ch.coords.lat}:${ch.coords.lon}`);
            if (seen.has(id)) continue;
            seen.add(id);
            picked.push(ch);
            if (picked.length >= cap) break;
          }
        }

        return picked;
      };

      let capped: any[] = [];
      if (constrainedGraphUsable) {
        // Keep all chargers that participate in the POI edge graph (so the constrained
        // solver doesn't get starved by downsampling), and downsample the rest.
        const edgePicked = progressSorted.filter((ch: any) => edgeGraphChargers.has(String(ch.id)));
        const nonEdgeSorted = progressSorted.filter(
          (ch: any) => !edgeGraphChargers.has(String(ch.id))
        );
        const remainingCap = Math.max(0, candidateChargersCap - edgePicked.length);
        const nonEdgePicked =
          remainingCap > 0 ? pickEvenlySpaced(nonEdgeSorted, remainingCap) : [];
        capped = [...edgePicked, ...nonEdgePicked];
      } else {
        capped = pickEvenlySpaced(progressSorted, candidateChargersCap);
      }

      // Guardrail: if we computed any end-reachable chargers, ensure at least one
      // survives capping. Without this, the segment solver can never reach the end.
      if (endReachable.length) {
        const endReachableIds = new Set(
          endReachable.map((c: any) => String(c.id ?? `${c.coords.lat}:${c.coords.lon}`))
        );
        const cappedHasEndReachable = capped.some((c: any) =>
          endReachableIds.has(String(c.id ?? `${c.coords.lat}:${c.coords.lon}`))
        );

        if (!cappedHasEndReachable) {
          const bestEnd = [...endReachable].sort(
            (a: any, b: any) =>
              haversineMiles(finalEnd.coords, a.coords) - haversineMiles(finalEnd.coords, b.coords)
          )[0];
          if (bestEnd) {
            // Replace the last element (arbitrary but stable) and rely on the fact
            // we already force evaluation uniqueness earlier in the combined build.
            if (capped.length > 0) {
              capped[capped.length - 1] = bestEnd;
            } else {
              capped = [bestEnd];
            }
          }
        }
      }

      // Avoid re-adding the segment start charger as a charger stop.
      const chargersForSegmentCapped =
        currentStart.id === "start" ? capped : capped.filter((c: any) => c.id !== currentStart.id);

      segmentAttempt.chargersForSegmentCappedCount = chargersForSegmentCapped.length;
      segmentAttempt.endReachableCount = endReachable.length;
      segmentAttempt.usePoiConstrainedEnv = usePoiConstrained;
      segmentAttempt.constrainedGraphUsable = constrainedGraphUsable;
      segmentAttempt.edgeGraphChargersCount = edgeGraphChargers.size;
      segmentAttempt.candidateChargersCap = candidateChargersCap;
      segmentAttempt.corridorChargersTotal = chargerCandidates.length;
      segmentAttempt.chargersInSegmentFilter = chargersForSegment.length;
      if (constrainedGraphUsable) {
        const edgeNodesInProgressSorted = progressSorted.filter((ch: any) =>
          edgeGraphChargers.has(String(ch.id))
        ).length;
        segmentAttempt.edgeGraphNodesInProgressSorted = edgeNodesInProgressSorted;
        segmentAttempt.edgeGraphExceedsCap = edgeNodesInProgressSorted > candidateChargersCap;
        segmentAttempt.nonEdgeCapRemaining = Math.max(0, candidateChargersCap - edgeNodesInProgressSorted);
      }
      (debug.segmentsAttempted as Array<Record<string, unknown>>).push(segmentAttempt);

      let segment;
      let attemptedConstrained = false;
      let constrainedUsed = false;
      const fallbackCapAfterConstrainedNoPath = Number(
        process.env.FALLBACK_CAP_AFTER_CONSTRAINED_NO_PATH ?? "220"
      );
      try {
        let segmentInitialDepart: number | undefined;
        if (
          socCarryOvernight &&
          overnightIndex > 0 &&
          overallStops.length >= 2 &&
          overallLegs.length === overallStops.length - 1
        ) {
          segmentInitialDepart = departSocFractionAfterSegmentForNextHop(
            overallStops as ItineraryStop[],
            overallLegs as ItineraryLeg[],
            rangeMiles,
            bufferSoc,
            finalEnd.coords,
            "end"
          );
          socCarryOvernightLog.push({
            kind: "overnight_iteration",
            overnightIndex,
            initialDepartSocFraction: segmentInitialDepart
          });
          segmentAttempt.initialDepartSocFraction = segmentInitialDepart;
        }

        const greedyArgs = {
          requestId: input.requestId,
          segmentStart: { id: currentStart.id, type: "start" as const, coords: currentStart.coords },
          segmentEnd: finalEnd,
          chargers: chargersForSegmentCapped,
          rangeMiles,
          bufferSoc,
          batteryKwh,
          precomputedEdgeTravelMinutes,
          precomputedEdgeDistanceMiles,
          ...(segmentInitialDepart != null ? { initialDepartSocFraction: segmentInitialDepart } : {}),
          ...(prefixRefinementEnabled
            ? {
                onPrefixRefinement: createSegmentPrefixHandler(
                  overnightIndex,
                  elapsedMinutesAtCurrentStart,
                  overallStops as ItineraryStop[],
                  overallLegs as ItineraryLeg[]
                )
              }
            : {})
        };

        const startNearest = nearestChargerByHaversine(
          currentStart.coords,
          chargers.map((c) => ({ coords: c.coords }))
        );
        const endNearest = nearestChargerByHaversine(
          finalEnd.coords,
          chargers.map((c) => ({ coords: c.coords }))
        );

        const endpointGuardOk =
          startNearest &&
          endNearest &&
          startNearest.haversineMi <= rangeMiles &&
          endNearest.haversineMi <= rangeMiles;

        logEvent("plan_segment_solver_start", {
          legIndex: input.legIndex ?? 0,
          tripLegIndex,
          tripLegCount,
          overnightIndex,
          elapsedMinutesAtCurrentStart,
          usePoiConstrainedEnv: usePoiConstrained,
          constrainedGraphUsable,
          edgeGraphChargersCount: edgeGraphChargers.size,
          candidateChargersCap,
          corridorChargersTotal: chargerCandidates.length,
          chargersForSegmentCappedCount: chargersForSegmentCapped.length,
          endpointGuardOk,
          startNearestHaversineMi: startNearest?.haversineMi ?? null,
          endNearestHaversineMi: endNearest?.haversineMi ?? null,
          willAttemptConstrainedSolve: Boolean(constrainedGraphUsable && endpointGuardOk)
        });

        if (constrainedGraphUsable && endpointGuardOk) {
          attemptedConstrained = true;
          segmentAttempt.constrainedModeAttempted = true;
          segmentAttempt.constrainedEndpointGuardOk = true;

          try {
            segment = await withTimeout(
              planLeastTimeSegment({
                ...greedyArgs,
                sleepEligibleChargerIds,
                maxSleepMiles
              }),
              segmentTimeoutMs,
              `Constrained segment solve exceeded time limit (${segmentTimeoutMs}ms).`
            );
            constrainedUsed = true;
          } catch (e) {
            if (e instanceof NoFeasibleItineraryError) {
              // Constrained graph can fail fast with very large node sets; bound the fallback
              // pool to keep the non-constrained solve tractable on long cross-country legs.
              const fallbackCapped = pickEvenlySpaced(
                progressSorted,
                Math.max(40, fallbackCapAfterConstrainedNoPath)
              );
              let fallbackPool: CanonicalCharger[] = fallbackCapped;
              if (endReachable.length) {
                const endReachableIds = new Set(
                  endReachable.map((c: any) => String(c.id ?? `${c.coords.lat}:${c.coords.lon}`))
                );
                const hasEndReachable = fallbackPool.some((c: any) =>
                  endReachableIds.has(String(c.id ?? `${c.coords.lat}:${c.coords.lon}`))
                );
                if (!hasEndReachable) {
                  const bestEnd = [...endReachable].sort(
                    (a: any, b: any) =>
                      haversineMiles(finalEnd.coords, a.coords) - haversineMiles(finalEnd.coords, b.coords)
                  )[0];
                  if (bestEnd) {
                    fallbackPool =
                      fallbackPool.length > 0
                        ? [...fallbackPool.slice(0, fallbackPool.length - 1), bestEnd]
                        : [bestEnd];
                  }
                }
              }
              logEvent("constrained_dijkstra_no_path", {
                legIndex: input.legIndex ?? 0,
                overnightIndex,
                segmentStartId: currentStart.id,
                endStopId: finalEnd.id,
                fallbackCapAfterConstrainedNoPath,
                fallbackPoolCount: fallbackPool.length
              });
              segmentAttempt.fallbackCapAfterConstrainedNoPath = fallbackCapAfterConstrainedNoPath;
              segmentAttempt.fallbackPoolCount = fallbackPool.length;
              segment = await withTimeout(
                planLeastTimeSegment({
                  ...greedyArgs,
                  chargers: fallbackPool
                } as any),
                segmentTimeoutMs,
                `Segment solve exceeded time limit (${segmentTimeoutMs}ms).`
              );
              constrainedUsed = false;
            } else {
              throw e;
            }
          }
        } else if (constrainedGraphUsable && !endpointGuardOk) {
          logEvent("poi_endpoints_unreachable", {
            legIndex: input.legIndex ?? 0,
            overnightIndex,
            startDistMi: startNearest?.haversineMi ?? null,
            endDistMi: endNearest?.haversineMi ?? null,
            maxEndpointHaversineMi: rangeMiles
          });
          attemptedConstrained = true;
        }

        if (!segment) {
          segment = await withTimeout(
            planLeastTimeSegment(greedyArgs as any),
            segmentTimeoutMs,
            `Segment solve exceeded time limit (${segmentTimeoutMs}ms).`
          );
        }

        captureSegmentOptimizer(segment);

        segmentAttempt.constrainedModeAttempted = attemptedConstrained;
        segmentAttempt.constrainedUsed = constrainedUsed;

        logEvent("plan_segment_solver_complete", {
          legIndex: input.legIndex ?? 0,
          overnightIndex,
          constrainedModeAttempted: attemptedConstrained,
          constrainedUsed,
          chargersForSegmentCappedCount: chargersForSegmentCapped.length,
          outcome: "ok"
        });
        phaseLog("after_segment_solver", {
          overnightIndex,
          segmentTotalTimeMinutes: segment.totalTimeMinutes,
          stopsCount: segment.stops.length,
          legsCount: segment.legs.length
        });
      } catch (e) {
        segmentAttempt.solverStatus = "error";
        segmentAttempt.errorMessage = e instanceof Error ? e.message : String(e);
        if (e instanceof Error && /exceeded time limit|timed out/i.test(e.message)) {
          segmentAttempt.errorCode = "SEGMENT_TIMEOUT";
          segmentAttempt.outcome = "segment_timeout";
        }
        if (e instanceof NoFeasibleItineraryError) {
          segmentAttempt.solverDebug = e.debug;
        }
        logEvent("plan_segment_solver_error", {
          legIndex: input.legIndex ?? 0,
          overnightIndex,
          constrainedModeAttempted: attemptedConstrained,
          constrainedUsed,
          chargersForSegmentCappedCount: chargersForSegmentCapped.length,
          message: e instanceof Error ? e.message : String(e),
          errorCode: segmentAttempt.errorCode ?? null
        });
        notifySolverAttempt(segmentAttempt);
        throw e;
      }

      segmentAttempt.solverStatus = "ok";
      segmentAttempt.totalTimeMinutes = segment.totalTimeMinutes;
      segmentAttempt.tripElapsedMinutesAtSegmentStart = elapsedMinutesAtCurrentStart;
      segmentAttempt.tripElapsedMinutesAtSegmentEnd =
        elapsedMinutesAtCurrentStart + segment.totalTimeMinutes;
      segmentAttempt.stopsCount = segment.stops.length;
      segmentAttempt.chargeStopsCount = segment.stops.filter((s) => s.type === "charge").length;
      segmentAttempt.legsCount = segment.legs.length;

      // No overnight needed (trip-global check: carry elapsed time from previous legs/overnights).
      const tripSegmentEndMinutes = elapsedMinutesAtCurrentStart + segment.totalTimeMinutes;
      const targetMinutesFromCurrentStart = Math.max(
        0,
        overnightThresholdMinutes - elapsedMinutesAtCurrentStart
      );
      if (tripSegmentEndMinutes <= overnightThresholdMinutes) {
        phaseLog("branch_under_overnight_threshold", {
          overnightIndex,
          segmentTotalTimeMinutes: segment.totalTimeMinutes,
          overnightThresholdMinutes,
          tripElapsedMinutesAtSegmentStart: elapsedMinutesAtCurrentStart,
          tripElapsedMinutesAtSegmentEnd: tripSegmentEndMinutes
        });
        segmentAttempt.outcome = "complete_under_overnight_threshold";
        segmentAttempt.overnightDecisionBasis = "trip_global_under_threshold";
        notifySolverAttempt(segmentAttempt);
        const stopsToAppend = overallStops.length === 0 ? segment.stops : segment.stops.slice(1);
        overallStops = overallStops.concat(stopsToAppend);
        overallLegs = overallLegs.concat(segment.legs);
        emitPartialRouteSnapshot("segment_under_overnight_threshold");
        logEvent("overnight_check", {
          overnightNeeded: false,
          segmentTotalTimeMinutes: segment.totalTimeMinutes,
          overnightThresholdMinutes,
          tripElapsedMinutesAtSegmentStart: elapsedMinutesAtCurrentStart,
          tripElapsedMinutesAtSegmentEnd: tripSegmentEndMinutes,
          overnightDecisionBasis: "trip_global"
        });
        break;
      }

      segmentAttempt.outcome = "exceeds_overnight_threshold";
      segmentAttempt.overnightDecisionBasis = "trip_global_exceeds_threshold";
      notifySolverAttempt(segmentAttempt);
      phaseLog("branch_exceeds_overnight_threshold", {
        overnightIndex,
        segmentTotalTimeMinutes: segment.totalTimeMinutes,
        overnightThresholdMinutes,
        tripElapsedMinutesAtSegmentStart: elapsedMinutesAtCurrentStart,
        tripElapsedMinutesAtSegmentEnd: tripSegmentEndMinutes,
        chargeStopsCount: segment.stops.filter((s) => s.type === "charge").length
      });

      // Overnight needed: pick an anchor charger where cumulative time crosses the threshold.
      const chargeStops = segment.stops
        .map((s, idx) => ({ s, idx }))
        .filter(({ s }) => s.type === "charge");

      // Primary rule: anchor on a charge-stop whose ETA is already >= the overnight threshold.
      // This matches the “time crosses threshold during charging” model.
      const thresholdChargeCandidates = chargeStops.filter(
        ({ s }) => (s.etaMinutesFromStart ?? 0) >= targetMinutesFromCurrentStart
      );

      // Flakiness fix: if no charge-stop crosses the threshold (e.g. edge timing where the
      // threshold is exceeded by a later leg), fall back to the closest charge-stop by ETA.
      // This keeps the “sleep insertion” invariant from depending on brittle crossing points.
      const chargeCandidates =
        thresholdChargeCandidates.length > 0
          ? thresholdChargeCandidates
          : [...chargeStops].sort((a, b) => {
              const etaA = a.s.etaMinutesFromStart ?? 0;
              const etaB = b.s.etaMinutesFromStart ?? 0;
              const dA = Math.abs(etaA - targetMinutesFromCurrentStart);
              const dB = Math.abs(etaB - targetMinutesFromCurrentStart);
              if (dA !== dB) return dA - dB;
              return a.idx - b.idx;
            });

      (debug as Record<string, unknown>).overnightAnchorThresholdCrossing =
        thresholdChargeCandidates.length > 0;
      (debug as Record<string, unknown>).overnightDecisionBasis = "trip_global";
      (debug as Record<string, unknown>).tripElapsedMinutesAtSegmentStart =
        elapsedMinutesAtCurrentStart;
      (debug as Record<string, unknown>).targetMinutesFromCurrentStart =
        targetMinutesFromCurrentStart;

      const anchorCandidateLimit = Number(
        process.env.OVERNIGHT_ANCHOR_CANDIDATE_LIMIT ?? "3"
      );

      const overnightAnchorsBefore = (
        debug.overnightAnchors as Array<{
          chargerId: string;
          chargerName: string;
          hotelFound: boolean;
          chosen?: boolean;
        }>
      ).length;

      let anchorIndex = chargeCandidates.length ? chargeCandidates[0].idx : -1;
      let selectedHotel: CanonicalPoiHotel | null = null;
      let selectedBestD = Infinity;
      let firstHotelChoice: CanonicalPoiHotel | null = null;
      let firstHotelAnchorIndex = anchorIndex;
      let fallbackSleepWithoutCharger = false;
      const hotelSearchRadiusMeters = 40 * 1609.34; // 40 miles
      const maxHotelChecks = 10;
      const maxHotelDetourMinutes = 15;

      // Hotel-first overnight selection:
      // 1) collect nearby hotels around candidate anchor charger (40mi),
      // 2) evaluate hotel->DCFC distance <= 400yd,
      // 3) apply detour guardrail <= 15min (straight-line estimate),
      // 4) pick first passing candidate (lockedHotelId searched first).
      for (const cand of chargeCandidates.slice(0, anchorCandidateLimit)) {
        const cacheKey = String(cand.s.id);
        let hotels: CanonicalPoiHotel[] = poiHotelsForOvernight?.length
          ? filterHotelsNear(cand.s.coords, poiHotelsForOvernight, hotelSearchRadiusMeters)
          : [];
        hotelCache.set(cacheKey, hotels);
        hotels = reorderHotelsWithLockedFirst(hotels, input.lockedHotelId);
        (debug.overnightAnchors as Array<{
          chargerId: string;
          chargerName: string;
          hotelFound: boolean;
          chosen: boolean;
        }>).push({
          chargerId: cand.s.id,
          chargerName: cand.s.name,
          hotelFound: hotels.length > 0,
          chosen: false
        });

        if (!hotels.length) continue;

        if (!firstHotelChoice) {
          firstHotelChoice = hotels[0] ?? null;
          firstHotelAnchorIndex = cand.idx;
        }

        const toEvaluate = hotels.slice(0, maxHotelChecks);
        for (const h of toEvaluate) {
          // Approximate detour as charger->hotel->charger roundtrip at ~45 mph.
          const dToHotelMiles = haversineMiles(cand.s.coords, h.coords);
          const detourMinutes = ((dToHotelMiles * 2) / 45) * 60;
          if (detourMinutes > maxHotelDetourMinutes) continue;

          let hasCloseDcfc = false;
          if (h.id.startsWith("poi_services:hotel:")) {
            const hid = Number(h.id.replace("poi_services:hotel:", ""));
            const rawHotel =
              Number.isFinite(hid) && poiCorridorHotelPois?.length
                ? poiCorridorHotelPois.find((x) => x.id === hid)
                : undefined;
            const yd = rawHotel?.nearby_dcfc_distance_yd ?? 0;
            const dcfcId = rawHotel?.nearby_dcfc_id ?? 0;
            hasCloseDcfc = dcfcId > 0 && yd > 0 && yd <= 400;
          } else {
            hasCloseDcfc = Boolean(pairChargerByHotelId[h.id]);
          }

          if (!hasCloseDcfc) continue;
          if (!selectedHotel || detourMinutes < selectedBestD) {
            selectedHotel = h;
            anchorIndex = cand.idx;
            selectedBestD = detourMinutes;
          }
        }
      }

      if (!selectedHotel && firstHotelChoice) {
        // Product policy: if no hotel+charger candidate passes checks, fall back
        // to the first searched hotel and continue with sleep-without-charger.
        selectedHotel = firstHotelChoice;
        anchorIndex = firstHotelAnchorIndex;
        fallbackSleepWithoutCharger = true;
      }

      if (anchorIndex < 0 || !selectedHotel) {
        segmentAttempt.outcome = "complete_no_overnight_anchor";
        const stopsToAppend = overallStops.length === 0 ? segment.stops : segment.stops.slice(1);
        overallStops = overallStops.concat(stopsToAppend);
        overallLegs = overallLegs.concat(segment.legs);
        emitPartialRouteSnapshot("no_overnight_anchor");
        logEvent("overnight_anchor_not_found", {
          overnightIndex,
          chargeStopsCount: chargeStops.length,
          chargeCandidatesCount: chargeCandidates.length,
          thresholdChargeCandidatesCount: thresholdChargeCandidates.length
        });
        break;
      }

      // Default: truncate at the selected anchor charger stop on the least-time segment.
      let anchorStop = segment.stops[anchorIndex];
      let truncatedStops = segment.stops.slice(0, anchorIndex + 1);
      let truncatedLegs = segment.legs.slice(0, anchorIndex);
      let resolvedSelectedHotel = selectedHotel;

      // Fallback: if none of the least-time segment's anchor chargers had a hotel nearby,
      // try to anchor on a charger close to the trip end (which, in hotel tests, is often
      // your Holiday Inn Express coordinate). This reruns planning for the sub-segment
      // from `currentStart` to the fallback charger so we can still insert `sleep`.
      if (!resolvedSelectedHotel) {
        const fallbackLimit = Number(
          process.env.OVERNIGHT_HOTEL_ANCHOR_CANDIDATE_LIMIT ?? "5"
        );
        const endByProximity = [...chargersForSegmentCapped].sort(
          (a: any, b: any) =>
            haversineMiles(a.coords, finalEnd.coords) -
            haversineMiles(b.coords, finalEnd.coords)
        );

        for (const c of endByProximity.slice(0, fallbackLimit)) {
          const cacheKey = String(c.id ?? `${c.coords.lat}:${c.coords.lon}`);
          let hotels: CanonicalPoiHotel[] = poiHotelsForOvernight?.length
            ? filterHotelsNear(c.coords, poiHotelsForOvernight, hotelSearchRadiusMeters)
            : [];
          hotelCache.set(cacheKey, hotels);

          if (!hotels.length) continue;

          hotels = reorderHotelsWithLockedFirst(hotels, input.lockedHotelId);
          let best = hotels[0];
          let bestD = Infinity;
          // Pick closest hotel to this charger.
          for (const h of hotels.slice(0, maxHotelChecks)) {
            const dToHotelMiles = haversineMiles(c.coords, h.coords);
            const detourMinutes = ((dToHotelMiles * 2) / 45) * 60;
            if (detourMinutes > maxHotelDetourMinutes) continue;
            let hasCloseDcfc = false;
            if (h.id.startsWith("poi_services:hotel:")) {
              const hid = Number(h.id.replace("poi_services:hotel:", ""));
              const rawHotel =
                Number.isFinite(hid) && poiCorridorHotelPois?.length
                  ? poiCorridorHotelPois.find((x) => x.id === hid)
                  : undefined;
              const yd = rawHotel?.nearby_dcfc_distance_yd ?? 0;
              const dcfcId = rawHotel?.nearby_dcfc_id ?? 0;
              hasCloseDcfc = dcfcId > 0 && yd > 0 && yd <= 400;
            } else {
              hasCloseDcfc = Boolean(pairChargerByHotelId[h.id]);
            }
            if (!hasCloseDcfc) continue;
            if (detourMinutes < bestD) {
              bestD = detourMinutes;
              best = h;
            }
          }
          if (!Number.isFinite(bestD)) continue;

          // Replan from currentStart to this fallback charger location.
          let fallbackSegment: any = null;
          try {
            fallbackSegment = await withTimeout(
              planLeastTimeSegment({
                requestId: input.requestId,
                segmentStart: { id: currentStart.id, type: "start", coords: currentStart.coords },
                segmentEnd: { id: String(c.id), type: "end" as const, coords: c.coords },
                chargers: chargersForSegmentCapped,
                rangeMiles,
                bufferSoc,
                batteryKwh,
                precomputedEdgeTravelMinutes,
                precomputedEdgeDistanceMiles
              }),
              segmentTimeoutMs,
              `Fallback segment solve exceeded time limit (${segmentTimeoutMs}ms).`
            );
          } catch {
            fallbackSegment = null;
          }

          if (fallbackSegment?.stops?.length) {
            captureSegmentOptimizer(fallbackSegment);
            const last = fallbackSegment.stops[fallbackSegment.stops.length - 1];
            // Convert the fallback segment's "end" to a "charge" stop for UX consistency.
            last.type = "charge";
            last.name = c.name ?? last.name;
            anchorStop = last;
            truncatedStops = fallbackSegment.stops;
            truncatedLegs = fallbackSegment.legs;
            resolvedSelectedHotel = best;
            break;
          }
        }
      }

      logEvent("overnight_anchor_resolved", {
        overnightIndex,
        anchorStopId: anchorStop.id,
        anchorStopEtaMinutesFromStart: anchorStop.etaMinutesFromStart,
        hotelFound: Boolean(resolvedSelectedHotel),
        hotelName: resolvedSelectedHotel?.name
      });
      phaseLog("after_overnight_anchor_resolved", {
        overnightIndex,
        anchorStopId: anchorStop.id
      });

      overnightStopsCount++;

      if (overallStops.length === 0) {
        overallStops = truncatedStops;
        overallLegs = truncatedLegs;
      } else {
        overallStops = overallStops.concat(truncatedStops.slice(1));
        overallLegs = overallLegs.concat(truncatedLegs);
      }
      emitPartialRouteSnapshot("overnight_truncated");

      // Sleep block: find Holiday Inn Express within HOTEL_RADIUS_METERS of anchor charger.
      let sleepStop: { id: string; name: string; coords: LatLng; etaMinutesFromStart: number } | null = null;
      let sleepHotelForPairs: CanonicalPoiHotel | null = null;
      const anchorEta = anchorStop.etaMinutesFromStart ?? 0;
      if (resolvedSelectedHotel) {
        sleepStop = {
          id: `sleep-${anchorStop.id}`,
          name: resolvedSelectedHotel.name,
          coords: resolvedSelectedHotel.coords,
          etaMinutesFromStart: anchorEta
        };
        sleepHotelForPairs = resolvedSelectedHotel;
      } else {
        const cacheKey = String(anchorStop.id);
        const hotels: CanonicalPoiHotel[] = poiHotelsForOvernight?.length
          ? filterHotelsNear(anchorStop.coords, poiHotelsForOvernight, hotelSearchRadiusMeters)
          : [];
        hotelCache.set(cacheKey, hotels);
        if (hotels.length) {
          const reordered = reorderHotelsWithLockedFirst(hotels, input.lockedHotelId);
          let best = reordered[0];
          let bestD = Infinity;
          for (const h of reordered.slice(0, maxHotelChecks)) {
            const dToHotelMiles = haversineMiles(anchorStop.coords, h.coords);
            const detourMinutes = ((dToHotelMiles * 2) / 45) * 60;
            if (detourMinutes > maxHotelDetourMinutes) continue;
            if (detourMinutes < bestD) {
              bestD = detourMinutes;
              best = h;
            }
          }
          if (best) {
            sleepStop = {
              id: `sleep-${anchorStop.id}`,
              name: best.name,
              coords: best.coords,
              etaMinutesFromStart: anchorEta
            };
            sleepHotelForPairs = best;
          }
        }
      }

      logEvent(sleepStop ? "sleep_stop_created" : "sleep_stop_missing", {
        overnightIndex,
        anchorStopId: anchorStop.id,
        sleepName: sleepStop?.name
      });
      phaseLog("before_sleep_charger_resolve", {
        overnightIndex,
        hasSleepStop: Boolean(sleepStop),
        corridorUsedPoi
      });

      // Soft preference: if we found a Holiday Inn Express `sleep` stop,
      // also try to find a nearby EV charger so the same stop can
      // represent "charging + sleeping together".
      //
      // This is intentionally non-fatal: missing chargers should not
      // break the overnight/hotel insertion invariants.
      let sleepChargerMeta:
        | {
            chargerFound: boolean;
            chargerId?: string;
            chargerName?: string;
            chargerMaxPowerKw?: number;
            chargerLat?: number;
            chargerLon?: number;
            /** Optional UX/debug label for how the sleep stop got its “nearby DCFC”. */
            sleepChargerSource?: string;
          }
        | undefined = undefined;
      if (sleepStop && fallbackSleepWithoutCharger) {
        sleepChargerMeta = {
          chargerFound: false,
          sleepChargerSource: "none"
        };
      } else if (sleepStop) {
        const poiHotelPrefix = "poi_services:hotel:";

        if (
          typeof sleepHotelForPairs?.id === "string" &&
          sleepHotelForPairs.id.startsWith(poiHotelPrefix)
        ) {
          let resolvedVia: "poi_hotel_join" | "poi_pairs" | "none" = "none";

          const hotelPoiIdCandidate = Number(
            sleepHotelForPairs.id.slice(poiHotelPrefix.length)
          );
          const hotelPoiId = Number.isFinite(hotelPoiIdCandidate)
            ? hotelPoiIdCandidate
            : undefined;

          const hotelPoiRow: PoiServicesPoi | undefined =
            hotelPoiId != null ? poiCorridorHotelPois?.find((h) => h.id === hotelPoiId) : undefined;

          let nearbyDcfcId = hotelPoiRow?.nearby_dcfc_id ?? 0;
          let nearbyDcfcDistanceYd = hotelPoiRow?.nearby_dcfc_distance_yd ?? 0;

          // Join: resolve `nearby_dcfc_id` via corridor charger pool (dcfc int id -> canonical).
          if (hotelPoiRow) {
            if (nearbyDcfcId > 0) {
              const canon = poiDcfcByPoiIntId?.get(nearbyDcfcId);
              if (canon) {
                sleepChargerMeta = {
                  chargerFound: true,
                  chargerId: String(canon.id),
                  chargerName: canon.name,
                  chargerMaxPowerKw: canon.maxPowerKw,
                  chargerLat: canon.coords.lat,
                  chargerLon: canon.coords.lon,
                  sleepChargerSource: "poi_hotel_dcfc"
                };
                resolvedVia = "poi_hotel_join";
              } else {
                appendPoiCorridorReviewLine({
                  event: "sleep_dcfc_corridor_miss",
                  requestId: input.requestId,
                  legIndex: input.legIndex ?? 0,
                  hotelPoiId,
                  nearbyDcfcId,
                  nearbyDcfcDistanceYd,
                  note: "nearby_dcfc_id not in corridor charger pool"
                });
              }
            } else {
              appendPoiCorridorReviewLine({
                event: "sleep_hotel_no_poi_dcfc",
                requestId: input.requestId,
                legIndex: input.legIndex ?? 0,
                hotelPoiId,
                nearbyDcfcId,
                nearbyDcfcDistanceYd,
                note: "nearby_dcfc_id <= 0"
              });
            }
          }

          // When POI corridor: pairs layer only — no live NREL near-hotel fetch.
          if (!sleepChargerMeta?.chargerFound) {
            const paired =
              sleepHotelForPairs?.id && pairChargerByHotelId[sleepHotelForPairs.id]
                ? pairChargerByHotelId[sleepHotelForPairs.id]
                : undefined;

            if (paired) {
              sleepChargerMeta = {
                chargerFound: true,
                chargerId: String(paired.id),
                chargerName: paired.name,
                chargerMaxPowerKw: paired.maxPowerKw,
                chargerLat: paired.coords.lat,
                chargerLon: paired.coords.lon,
                sleepChargerSource: "poi_pairs"
              };
              resolvedVia = "poi_pairs";
            } else {
              sleepChargerMeta = {
                chargerFound: false,
                sleepChargerSource: "none"
              };
            }
          }

          // Single summary line per resolution outcome (for POI data QA).
          appendPoiCorridorReviewLine({
            event: "sleep_charger_resolution_summary",
            requestId: input.requestId,
            legIndex: input.legIndex ?? 0,
            hotelPoiId,
            nearbyDcfcId,
            nearbyDcfcDistanceYd,
            resolvedVia
          });
        } else {
          const paired =
            sleepHotelForPairs?.id && pairChargerByHotelId[sleepHotelForPairs.id]
              ? pairChargerByHotelId[sleepHotelForPairs.id]
              : undefined;

          if (paired) {
            sleepChargerMeta = {
              chargerFound: true,
              chargerId: String(paired.id),
              chargerName: paired.name,
              chargerMaxPowerKw: paired.maxPowerKw,
              chargerLat: paired.coords.lat,
              chargerLon: paired.coords.lon
            };
          } else {
            sleepChargerMeta = { chargerFound: false, sleepChargerSource: "none" };
          }
        }
      }

      if (sleepStop) {
        logEvent("sleep_charger_meta", {
          overnightIndex,
          anchorStopId: anchorStop.id,
          sleepName: sleepStop.name,
          chargerFound: Boolean(sleepChargerMeta?.chargerFound),
          chargerName: sleepChargerMeta?.chargerName
        });
      }
      phaseLog("after_sleep_charger_meta_block", { overnightIndex });

      sleepTimeMinutesTotal += sleepMinutes;

      if (sleepStop) {
        overallStops.push({
          id: sleepStop.id,
          type: "sleep",
          name: sleepStop.name,
          coords: sleepStop.coords,
          etaMinutesFromStart: sleepStop.etaMinutesFromStart,
          meta: sleepChargerMeta
        });

        // Connector leg for map continuity; real timing is modeled as fixed 8h sleep.
        overallLegs.push({
          fromStopId: anchorStop.id,
          toStopId: sleepStop.id,
          travelTimeMinutes: 0,
          chargeTimeMinutes: undefined
        });
        emitPartialRouteSnapshot("after_sleep_connector");

        currentStart = { id: sleepStop.id, coords: sleepStop.coords };
        lastHotelMessage = undefined;
        elapsedMinutesAtCurrentStart += anchorEta + sleepMinutes;
      } else {
        const anchors = debug.overnightAnchors as Array<{
          chargerId: string;
          chargerName: string;
          hotelFound: boolean;
        }>;
        const noHotelAnchors = anchors
          .slice(overnightAnchorsBefore)
          .filter((a) => !a.hotelFound);
        lastHotelMessage =
          noHotelAnchors.length > 1
            ? `Hotel not found within ${overnightHotelRadiusYards} yards for ${noHotelAnchors.length} overnight stop(s) (e.g. near "${anchorStop.name}"). Showing charging plan only.`
            : `Hotel not found within ${overnightHotelRadiusYards} yards of charger "${anchorStop.name}". Showing charging plan only for this overnight.`;
        currentStart = { id: anchorStop.id, coords: anchorStop.coords };
        elapsedMinutesAtCurrentStart += anchorEta;
      }

    }

    // If we hit the cap, append the final remainder segment from the current start.
    if (!overallStops.some((s) => s.type === "end")) {
      const chargersForRemainder =
        currentStart.id === "start"
          ? chargerCandidates
          : chargerCandidates.filter((c: any) => c.id !== currentStart.id);

      const remainderAttempt: Record<string, unknown> = {
        kind: "remainder",
        segmentStartId: currentStart.id,
        chargersPoolCount: chargersForRemainder.length
      };
      (debug.segmentsAttempted as Array<Record<string, unknown>>).push(remainderAttempt);

      const remainderT0 = Date.now();
      logEvent("plan_segment_remainder_start", {
        legIndex: input.legIndex ?? 0,
        segmentStartId: currentStart.id,
        chargersPoolCount: chargersForRemainder.length,
        constrainedGraphUsable,
        /** When true, remainder uses the same POI sleep+edges sync path as the main segment (no Valhalla in Dijkstra). */
        sleepConstraintPassedThrough: constrainedGraphUsable
      });
      phaseLog("before_remainder_solve", {
        segmentStartId: currentStart.id,
        chargersPoolCount: chargersForRemainder.length
      });

      let remainderInitialDepart: number | undefined;
      if (
        socCarryOvernight &&
        overallStops.length >= 2 &&
        overallLegs.length === overallStops.length - 1
      ) {
        remainderInitialDepart = departSocFractionAfterSegmentForNextHop(
          overallStops as ItineraryStop[],
          overallLegs as ItineraryLeg[],
          rangeMiles,
          bufferSoc,
          finalEnd.coords,
          "end"
        );
        socCarryOvernightLog.push({
          kind: "remainder",
          initialDepartSocFraction: remainderInitialDepart
        });
        remainderAttempt.initialDepartSocFraction = remainderInitialDepart;
      }

      let remainder;
      try {
        remainder = await withTimeout(
          planLeastTimeSegment({
            requestId: input.requestId,
            segmentStart: { id: currentStart.id, type: "start", coords: currentStart.coords },
            segmentEnd: finalEnd,
            chargers: chargersForRemainder,
            rangeMiles,
            bufferSoc,
            batteryKwh,
            precomputedEdgeTravelMinutes,
            precomputedEdgeDistanceMiles,
            ...(remainderInitialDepart != null ? { initialDepartSocFraction: remainderInitialDepart } : {}),
            ...(constrainedGraphUsable
              ? {
                  sleepEligibleChargerIds,
                  maxSleepMiles
                }
              : {}),
            ...(prefixRefinementEnabled
              ? {
                  onPrefixRefinement: createSegmentPrefixHandler(
                    null,
                    elapsedMinutesAtCurrentStart,
                    overallStops as ItineraryStop[],
                    overallLegs as ItineraryLeg[]
                  )
                }
              : {})
          }),
          segmentTimeoutMs,
          `Final segment solve exceeded time limit (${segmentTimeoutMs}ms).`
        );
      } catch (e) {
        remainderAttempt.solverStatus = "error";
        remainderAttempt.errorMessage = e instanceof Error ? e.message : String(e);
        if (e instanceof Error && /exceeded time limit|timed out/i.test(e.message)) {
          remainderAttempt.errorCode = "SEGMENT_TIMEOUT";
          remainderAttempt.outcome = "segment_timeout";
        }
        if (e instanceof NoFeasibleItineraryError) {
          remainderAttempt.solverDebug = e.debug;
        }
        notifySolverAttempt(remainderAttempt);
        throw e;
      }

      remainderAttempt.solverStatus = "ok";
      remainderAttempt.outcome = "remainder_to_end";
      remainderAttempt.totalTimeMinutes = remainder.totalTimeMinutes;
      remainderAttempt.stopsCount = remainder.stops.length;
      remainderAttempt.chargeStopsCount = remainder.stops.filter((s) => s.type === "charge").length;
      remainderAttempt.legsCount = remainder.legs.length;
      notifySolverAttempt(remainderAttempt);

      const stopsToAppend =
        overallStops.length === 0 ? remainder.stops : remainder.stops.slice(1);
      overallStops = overallStops.concat(stopsToAppend);
      overallLegs = overallLegs.concat(remainder.legs);
      emitPartialRouteSnapshot("remainder_to_end");
      captureSegmentOptimizer(remainder);
      phaseLog("after_remainder_solve", {
        remainderDurationMs: Date.now() - remainderT0,
        remainderStopsCount: remainder.stops.length
      });
    }

    const travelTimeMinutes = overallLegs.reduce(
      (sum, l) => sum + (l.travelTimeMinutes ?? 0),
      0
    );
    const chargeTimeMinutes = overallLegs.reduce(
      (sum, l) => sum + (l.chargeTimeMinutes ?? 0),
      0
    );
    const totalTimeMinutes = travelTimeMinutes + chargeTimeMinutes + sleepTimeMinutesTotal;

    phaseLog("plan_leg_ok_return", {
      overallStopsCount: overallStops.length,
      overnightStopsCount,
      totalTimeMinutes
    });

    if (rangeLegOptimizerForDebug) {
      debug.rangeLegOptimizer = rangeLegOptimizerForDebug;
    }
    if (rangeLegFeasibilityForDebug) {
      debug.rangeLegFeasibility = rangeLegFeasibilityForDebug;
    }
    if (socCarryOvernightLog.length > 0) {
      debug.socCarryOvernightSegments = socCarryOvernightLog;
    }

    return {
      requestId: input.requestId,
      responseVersion: input.responseVersion,
      status: "ok",
      message: lastHotelMessage,
      stops: overallStops,
      legs: overallLegs,
      totals: {
        travelTimeMinutes,
        chargeTimeMinutes,
        sleepTimeMinutes: sleepTimeMinutesTotal,
        totalTimeMinutes,
        overnightStopsCount
      },
      candidates: candidatesForResponse,
      debug
    };
  } catch (e) {
    let msg = e instanceof Error ? e.message : "Planner failed";
    let mergedDebug: Record<string, unknown> = debug;

    if (e instanceof NoFeasibleItineraryError) {
      const d = e.debug;
      mergedDebug = { ...debug, noFeasibleItinerary: d };
      const detail = typeof d.message === "string" ? d.message.trim() : "";
      if (detail) {
        msg = `${msg} — ${detail}`;
      }
    }

    return {
      requestId: input.requestId,
      responseVersion: input.responseVersion,
      status: "error",
      message: msg,
      debug: mergedDebug,
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
}

