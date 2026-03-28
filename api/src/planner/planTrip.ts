import { geocodeTextToLatLng } from "../services/geocode";
import type {
  CandidatesApiResponse,
  ItineraryStop,
  PlanTripResponse,
  TripLegPlanningContext
} from "../types";
import { planTripOneLegFromCoords, type OnSolverAttempt } from "./planTripOneLeg";
import { validateLockedChargersByLeg } from "./lockValidation";
import { resolvePlanStart, type ReplanFromInput } from "./replanResolve";
import { fetchCorridorChargersForLeg } from "./corridorCandidates";
import { resolvePlanProviders, sourceRoutingDebugFromMeta } from "../sourceRouter";
import {
  attachRangeLegsToOkPlan,
  computeRangeLegs,
  readRangeLegMetricsOptsFromEnv
} from "./rangeLegs";
import { haversineMiles } from "./geo";
import { getRoutePolyline } from "../services/valhallaClient";
import { pickBestWaypointOrderHaversine } from "./waypointOrder";

export type { OnSolverAttempt } from "./planTripOneLeg";

export type PlanTripPlannerInput = {
  requestId: string;
  /** Geocoded start text; omit when `replanFrom` is set. */
  start?: string;
  end: string;
  responseVersion: string;
  waypoints?: string[];
  includeCandidates?: boolean;
  lockedChargersByLeg?: string[][];
  lockedHotelId?: string;
  /** Mid-journey replan: replaces `start`. */
  replanFrom?: ReplanFromInput;
  /** Stops from the previous `POST /plan` — required for `replanFrom.stopId`. */
  previousStops?: ItineraryStop[];
  /** Optional: incremental checkpoints (async `planJob` / future streaming). */
  onSolverAttempt?: OnSolverAttempt;
  /**
   * When true, ≥2 intermediate waypoints, and no locks / replan: reorder waypoints by
   * minimizing haversine leg-sum (time-budgeted) before multi-leg EV planning.
   */
  optimizeWaypointOrder?: boolean;
};

/** `POST /candidates` — same trip inputs as `/plan` without lock fields or `includeCandidates`. */
export type PlanTripCandidatesOnlyInput = Omit<
  PlanTripPlannerInput,
  "lockedChargersByLeg" | "lockedHotelId" | "includeCandidates"
>;

function interpolateLatLng(a: { lat: number; lon: number }, b: { lat: number; lon: number }, t: number) {
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t
  };
}

function buildAutoWaypointPoints(
  start: { lat: number; lon: number },
  end: { lat: number; lon: number },
  thresholdMiles: number
): Array<{ lat: number; lon: number }> {
  const d = haversineMiles(start, end);
  if (!Number.isFinite(d) || !Number.isFinite(thresholdMiles) || thresholdMiles <= 0) return [];
  if (d <= thresholdMiles) return [];
  const segments = Math.max(2, Math.ceil(d / thresholdMiles));
  const out: Array<{ lat: number; lon: number }> = [];
  for (let i = 1; i < segments; i++) {
    out.push(interpolateLatLng(start, end, i / segments));
  }
  return out;
}

function splitPolylineEvenly(
  points: Array<{ lat: number; lon: number }>,
  segments: number
): Array<{ lat: number; lon: number }> {
  if (segments <= 1 || points.length < 2) return [];
  const cumulative: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1]! + haversineMiles(points[i - 1]!, points[i]!));
  }
  const total = cumulative[cumulative.length - 1] ?? 0;
  if (!Number.isFinite(total) || total <= 0) return [];
  const out: Array<{ lat: number; lon: number }> = [];
  let idx = 1;
  for (let s = 1; s < segments; s++) {
    const target = (total * s) / segments;
    while (idx < cumulative.length && (cumulative[idx] ?? 0) < target) idx++;
    const r = Math.min(cumulative.length - 1, Math.max(1, idx));
    const l = Math.max(0, r - 1);
    const d0 = cumulative[l] ?? 0;
    const d1 = cumulative[r] ?? d0;
    const t = d1 > d0 ? (target - d0) / (d1 - d0) : 0;
    out.push(interpolateLatLng(points[l]!, points[r]!, t));
  }
  return out;
}

function makeCandidatesLogEvent(requestId: string) {
  const enable = (process.env.PLAN_LOG_REQUESTS ?? "true").toLowerCase() === "true";
  const deploymentEnv = (process.env.DEPLOYMENT_ENV ?? "dev-local").trim().toLowerCase();
  return (event: string, data: Record<string, unknown> = {}) => {
    if (!enable) return;
    console.log(JSON.stringify({ event, deploymentEnv, requestId, ...data }));
  };
}

/**
 * Corridor charger + hotel candidates only (Slice 3). Same geographic inputs as
 * `POST /plan` without running the least-time itinerary solver.
 */
export async function planTripCandidatesOnly(
  input: PlanTripCandidatesOnlyInput
): Promise<CandidatesApiResponse> {
  const responseVersion = input.responseVersion || "v2-1";
  const maxWaypoints = Number(process.env.V2_MAX_WAYPOINTS ?? "12");
  const wps = (input.waypoints ?? []).map((w) => w.trim()).filter(Boolean);

  if (wps.length > maxWaypoints) {
    return {
      requestId: input.requestId,
      responseVersion,
      status: "error",
      message: `Too many waypoints (max ${maxWaypoints}).`
    };
  }

  const resolved = await resolvePlanStart({
    requestId: input.requestId,
    responseVersion,
    start: input.start,
    replanFrom: input.replanFrom,
    previousStops: input.previousStops
  });
  if (!resolved.ok) {
    const r = resolved.response;
    return {
      requestId: r.requestId,
      responseVersion: r.responseVersion || responseVersion,
      status: "error",
      message: r.message,
      errorCode: r.errorCode,
      debug: r.debug
    };
  }

  const { startCoords } = resolved;
  const logEvent = makeCandidatesLogEvent(input.requestId);
  const providers = resolvePlanProviders({ requestId: input.requestId });
  const sourceRouting = sourceRoutingDebugFromMeta(providers.meta);
  const overnightHotelRadiusMeters = Number(
    process.env.OVERNIGHT_HOTEL_RADIUS_METERS ??
      String(Number(process.env.HOTEL_RADIUS_METERS ?? "365.76"))
  );

  if (!wps.length) {
    const endCoords = await geocodeTextToLatLng(input.end);
    const corridor = await fetchCorridorChargersForLeg({
      requestId: input.requestId,
      legIndex: 0,
      startCoords,
      endCoords,
      includeCandidates: true,
      logEvent,
      overnightHotelRadiusMeters
    });
    if (!corridor.ok) {
      return {
        requestId: input.requestId,
        responseVersion,
        status: "error",
        message: corridor.message,
        ...(corridor.errorCode ? { errorCode: corridor.errorCode } : {}),
        debug: corridor.debug
      };
    }
    return {
      requestId: input.requestId,
      responseVersion,
      status: "ok",
      candidates: corridor.candidatesForResponse,
      debug: { corridor: corridor.debug, sourceRouting }
    };
  }

  const wpCoords = await Promise.all(wps.map((w) => geocodeTextToLatLng(w)));
  const endCoords = await geocodeTextToLatLng(input.end);

  const points = [startCoords, ...wpCoords, endCoords];

  const allChargers: NonNullable<PlanTripResponse["candidates"]>["chargers"] = [];
  const allHotels: NonNullable<PlanTripResponse["candidates"]>["hotels"] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const corridor = await fetchCorridorChargersForLeg({
      requestId: input.requestId,
      legIndex: i,
      startCoords: points[i],
      endCoords: points[i + 1],
      includeCandidates: true,
      logEvent,
      overnightHotelRadiusMeters
    });
    if (!corridor.ok) {
      return {
        requestId: input.requestId,
        responseVersion,
        status: "error",
        message: corridor.message,
        ...(corridor.errorCode ? { errorCode: corridor.errorCode } : {}),
        debug: corridor.debug
      };
    }
    if (corridor.candidatesForResponse) {
      allChargers.push(...corridor.candidatesForResponse.chargers);
      allHotels.push(...corridor.candidatesForResponse.hotels);
    }
  }

  const candidates =
    allChargers.length || allHotels.length
      ? {
          chargers: dedupeById(allChargers),
          hotels: dedupeById(allHotels),
          legIndex: 0
        }
      : undefined;

  return {
    requestId: input.requestId,
    responseVersion,
    status: "ok",
    candidates,
    debug: { multiLeg: true, legCount: points.length - 1, sourceRouting }
  };
}

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

function lockErrorResponse(
  input: PlanTripPlannerInput,
  message: string,
  errorCode: string
): PlanTripResponse {
  return {
    requestId: input.requestId,
    responseVersion: input.responseVersion || "v2-1",
    status: "error",
    message,
    errorCode,
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

async function planTripMultiLeg(
  input: PlanTripPlannerInput & { waypoints: string[] },
  resolved: { startCoords: { lat: number; lon: number }; startLabel: string }
): Promise<PlanTripResponse> {
  const wpCoords = await Promise.all(input.waypoints.map((w) => geocodeTextToLatLng(w)));
  const endCoords = await geocodeTextToLatLng(input.end);

  const hasLocks =
    Boolean(input.lockedHotelId) ||
    Boolean(input.lockedChargersByLeg?.some((row) => row && row.length > 0));

  const canOptimizeOrder =
    input.optimizeWaypointOrder === true &&
    input.waypoints.length >= 2 &&
    input.replanFrom == null &&
    !hasLocks;

  let orderedWpStrings = input.waypoints;
  let orderedCoords = wpCoords;
  let waypointOrderDebug: Record<string, unknown> | undefined;

  if (canOptimizeOrder) {
    const budget = Number(process.env.PLAN_WAYPOINT_REORDER_BUDGET_MS ?? "4000");
    const picked = pickBestWaypointOrderHaversine(
      resolved.startCoords,
      endCoords,
      wpCoords,
      input.waypoints,
      Number.isFinite(budget) && budget > 0 ? budget : 4000
    );
    orderedWpStrings = picked.orderedLabels;
    orderedCoords = picked.orderedCoords;
    waypointOrderDebug = {
      applied: picked.changed,
      mode: "haversine_leg_sum",
      userOrder: picked.userLabels,
      chosenOrder: picked.orderedLabels,
      userScoreMiles: Math.round(picked.userScoreMiles * 100) / 100,
      chosenScoreMiles: Math.round(picked.bestScoreMiles * 100) / 100,
      candidatesEvaluated: picked.evaluated,
      elapsedMs: picked.elapsedMs
    };
  }

  const points = [resolved.startCoords, ...orderedCoords, endCoords];
  const labels = [resolved.startLabel, ...orderedWpStrings, input.end];
  const planned = await planTripByPointChain(input, points, labels, { autoWaypointsUsed: false });
  if (planned.status === "ok" && waypointOrderDebug) {
    return {
      ...planned,
      debug: {
        ...(planned.debug ?? {}),
        waypointOrderOptimization: waypointOrderDebug
      }
    };
  }
  return planned;
}

async function planTripByPointChain(
  input: PlanTripPlannerInput,
  points: Array<{ lat: number; lon: number }>,
  labels: string[],
  opts?: { autoWaypointsUsed?: boolean; autoWaypointCount?: number; autoWaypointThresholdMi?: number }
): Promise<PlanTripResponse> {
  const autoWaypointsUsed = Boolean(opts?.autoWaypointsUsed);
  const rangeLegMetricsOpts = readRangeLegMetricsOptsFromEnv();

  const allChargers: NonNullable<PlanTripResponse["candidates"]>["chargers"] = [];
  const allHotels: NonNullable<PlanTripResponse["candidates"]>["hotels"] = [];

  let mergedStops = [] as PlanTripResponse["stops"];
  let mergedLegs = [] as PlanTripResponse["legs"];
  let totalTravel = 0;
  let totalCharge = 0;
  let totalSleep = 0;
  let overnightCount = 0;
  let timeOffset = 0;
  let milesOffset = 0;
  let lastMessage: string | undefined;
  const legDebugs: Array<Record<string, unknown> | undefined> = [];
  const logMulti = makeCandidatesLogEvent(input.requestId);
  const planMultiLegT0 = Date.now();

  for (let i = 0; i < points.length - 1; i++) {
    logMulti("plan_multi_leg_leg_start", {
      legIndex: i,
      legCount: points.length - 1,
      multiLegElapsedMs: Date.now() - planMultiLegT0,
      startLabel: labels[i],
      endLabel: labels[i + 1],
      elapsedMinutesFromTripStart: timeOffset,
      tripProgressMilesFromTripStart: Math.round(milesOffset * 100) / 100
    });
    const isLast = i === points.length - 2;
    const segStartId = i === 0 ? "start" : `via-${i - 1}`;
    const endId = isLast ? "end" : `via-${i}`;

    const tripContext: TripLegPlanningContext = {
      elapsedMinutesFromTripStart: timeOffset,
      tripLegIndex: i,
      tripLegCount: points.length - 1,
      tripProgressMilesFromTripStart: milesOffset
    };

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
      ...tripContext,
      lockedChargerIdsOrdered: input.lockedChargersByLeg?.[i],
      lockedHotelId: input.lockedHotelId,
      onSolverAttempt: input.onSolverAttempt
    });

    if (leg.status !== "ok") return leg;

    logMulti("plan_multi_leg_leg_done", {
      legIndex: i,
      multiLegElapsedMs: Date.now() - planMultiLegT0,
      status: leg.status,
      stopsCount: leg.stops?.length ?? 0
    });

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

    if (
      input.onSolverAttempt &&
      mergedStops.length >= 2 &&
      mergedLegs.length === mergedStops.length - 1
    ) {
      const rangeLegs = computeRangeLegs(
        { stops: mergedStops, legs: mergedLegs },
        rangeLegMetricsOpts
      );
      input.onSolverAttempt({
        legIndex: i,
        attempt: {
          kind: "partial_route",
          reason: `multi_leg_merged_${i}`,
          partialSnapshot: {
            stops: JSON.parse(JSON.stringify(mergedStops)),
            legs: JSON.parse(JSON.stringify(mergedLegs)),
            rangeLegs
          }
        }
      });
    }

    const t = leg.totals;
    if (t) {
      totalTravel += t.travelTimeMinutes;
      totalCharge += t.chargeTimeMinutes;
      totalSleep += t.sleepTimeMinutes;
      overnightCount += t.overnightStopsCount;
      timeOffset += t.totalTimeMinutes;
    }
    const nextLegMiles = haversineMiles(points[i]!, points[i + 1]!);
    if (Number.isFinite(nextLegMiles) && nextLegMiles > 0) {
      milesOffset += nextLegMiles;
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

  const firstLegDbg = legDebugs[0];
  const topSourceRouting =
    firstLegDbg && typeof firstLegDbg === "object" && firstLegDbg !== null && "sourceRouting" in firstLegDbg
      ? (firstLegDbg as Record<string, unknown>).sourceRouting
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
      ...(autoWaypointsUsed
        ? {
            autoWaypoints: {
              used: true,
              count: opts?.autoWaypointCount ?? Math.max(0, points.length - 2),
              thresholdMi: opts?.autoWaypointThresholdMi
            }
          }
        : {}),
      legs: legDebugs,
      ...(topSourceRouting !== undefined ? { sourceRouting: topSourceRouting } : {})
    }
  };
}

export async function planTrip(input: PlanTripPlannerInput): Promise<PlanTripResponse> {
  const logEvent = makeCandidatesLogEvent(input.requestId);
  const maxWaypoints = Number(process.env.V2_MAX_WAYPOINTS ?? "12");
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

  const lockCheck = validateLockedChargersByLeg(wps, input.lockedChargersByLeg);
  if (!lockCheck.ok) {
    return lockErrorResponse(input, lockCheck.message, lockCheck.errorCode);
  }

  const resolved = await resolvePlanStart({
    requestId: input.requestId,
    responseVersion: input.responseVersion,
    start: input.start,
    replanFrom: input.replanFrom,
    previousStops: input.previousStops
  });
  if (!resolved.ok) {
    return resolved.response;
  }

  const { startCoords, startLabel, midJourneyReplan } = resolved;

  if (!wps.length) {
    const endCoords = await geocodeTextToLatLng(input.end);
    const autoWaypointsEnabled =
      (process.env.ENABLE_AUTO_WAYPOINTS ?? "false").toLowerCase() === "true";
    const autoWaypointThresholdMi = Number(process.env.AUTO_WAYPOINT_THRESHOLD_MI ?? "500");
    const hasLocks = Boolean(input.lockedHotelId) || Boolean(input.lockedChargersByLeg?.[0]?.length);
    const canAutoWaypoint =
      autoWaypointsEnabled &&
      !hasLocks &&
      input.replanFrom == null &&
      Number.isFinite(autoWaypointThresholdMi) &&
      autoWaypointThresholdMi > 0;
    logEvent("auto_waypoints_decision", {
      enabled: autoWaypointsEnabled,
      hasLocks,
      hasReplanFrom: input.replanFrom != null,
      thresholdMi: autoWaypointThresholdMi,
      canAutoWaypoint
    });
    if (canAutoWaypoint) {
      // IMPORTANT: auto-waypoints must be derived from the Valhalla road polyline (route geometry),
      // not straight-line interpolation between start/end. Straight-line splits can place segment
      // endpoints far off-corridor and break per-segment charger selection.
      // Only fall back to straight-line points when route polyline generation fails.
      let autoPoints: Array<{ lat: number; lon: number }> = [];
      try {
        const route = await getRoutePolyline(startCoords, endCoords);
        const routeCoords = Array.isArray(route?.coordinates)
          ? route.coordinates
              .filter((c) => Array.isArray(c) && c.length >= 2)
              .map((c) => ({ lon: Number(c[0]), lat: Number(c[1]) }))
              .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
          : [];
        const routeMiles =
          routeCoords.length >= 2
            ? routeCoords
                .slice(1)
                .reduce((sum, p, i) => sum + haversineMiles(routeCoords[i]!, p), 0)
            : haversineMiles(startCoords, endCoords);
        const segments = Math.max(2, Math.ceil(routeMiles / autoWaypointThresholdMi));
        autoPoints = splitPolylineEvenly(routeCoords, segments);
        logEvent("auto_waypoints_route_based", {
          thresholdMi: autoWaypointThresholdMi,
          routeMiles: Math.round(routeMiles * 10) / 10,
          routeVertices: routeCoords.length,
          segments,
          generatedCount: autoPoints.length
        });
      } catch (e) {
        autoPoints = buildAutoWaypointPoints(startCoords, endCoords, autoWaypointThresholdMi);
        logEvent("auto_waypoints_route_based_fallback", {
          thresholdMi: autoWaypointThresholdMi,
          generatedCount: autoPoints.length,
          reason: e instanceof Error ? e.message : String(e)
        });
      }
      logEvent("auto_waypoints_points", {
        enabled: autoWaypointsEnabled,
        thresholdMi: autoWaypointThresholdMi,
        generatedCount: autoPoints.length
      });
      if (autoPoints.length > 0) {
        const points = [startCoords, ...autoPoints, endCoords];
        const labels = [
          startLabel,
          ...autoPoints.map((_p, i) => `Auto waypoint ${i + 1}`),
          input.end
        ];
        logEvent("auto_waypoints_applied", {
          count: autoPoints.length,
          thresholdMi: autoWaypointThresholdMi
        });
        const autoPlanned = await planTripByPointChain(input, points, labels, {
          autoWaypointsUsed: true,
          autoWaypointCount: autoPoints.length,
          autoWaypointThresholdMi
        });
        if (autoPlanned.status === "ok" && midJourneyReplan) {
          return attachRangeLegsToOkPlan({
            ...autoPlanned,
            debug: {
              ...(autoPlanned.debug ?? {}),
              replan: true
            }
          });
        }
        return attachRangeLegsToOkPlan(autoPlanned);
      }
    }
    const one = await planTripOneLegFromCoords({
      requestId: input.requestId,
      responseVersion: input.responseVersion,
      startCoords,
      endCoords,
      endStopId: "end",
      segmentStartId: "start",
      startQueryLabel: startLabel,
      endQueryLabel: input.end,
      includeCandidates: input.includeCandidates,
      legIndex: 0,
      lockedChargerIdsOrdered: input.lockedChargersByLeg?.[0],
      lockedHotelId: input.lockedHotelId,
      onSolverAttempt: input.onSolverAttempt
    });
    if (one.status === "ok" && midJourneyReplan) {
      return attachRangeLegsToOkPlan({
        ...one,
        debug: {
          ...(one.debug ?? {}),
          replan: true
        }
      });
    }
    return attachRangeLegsToOkPlan(one);
  }

  const multi = await planTripMultiLeg(
    { ...input, waypoints: wps },
    { startCoords, startLabel }
  );
  if (multi.status === "ok" && midJourneyReplan) {
    return attachRangeLegsToOkPlan({
      ...multi,
      debug: {
        ...(multi.debug ?? {}),
        replan: true
      }
    });
  }
  return attachRangeLegsToOkPlan(multi);
}
