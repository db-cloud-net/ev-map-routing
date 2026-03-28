import { estimateChargeTimeMinutes } from "./chargingTimeModel";
import type { ItineraryLeg, ItineraryStop, LatLng } from "../types";
import type { CanonicalCharger } from "../corridor/providerContracts";
import { haversineMiles, clamp } from "./geo";
import { getTravelDistanceMiles, getTravelTimeMinutes } from "../services/valhallaClient";

type SegmentInput = {
  requestId: string;
  segmentStart: { id: string; type: "start"; coords: LatLng };
  segmentEnd: { id: string; type: "end"; coords: LatLng };
  chargers: CanonicalCharger[];
  // Start departure SOC defaults to a full pack unless `initialDepartSocFraction` is set (chained segments).
  // Charging happens at charger stops only.
  rangeMiles: number;
  bufferSoc: number; // e.g. 0.1 means arrive at next charger with 10% SOC remaining
  batteryKwh: number;
  /**
   * Optional POI Services `edges` layer: canonical charger id pairs -> road travel minutes.
   * Missing pairs fall back to Valhalla (or haversine when disabled).
   */
  precomputedEdgeTravelMinutes?: Map<string, number>;
  /** Same keys as travel minutes; values in **road** miles (from POI `distance_m`). */
  precomputedEdgeDistanceMiles?: Map<string, number>;

  /**
   * Optional POI-backed feasibility constraint:
   * - reset `milesSinceLastSleep` when the path visits any charger that appears in POI `pairs`
   *   as the `nearby_dcfc` endpoint (precomputed by caller into this set).
   * - prune any path where `milesSinceLastSleep` would exceed `maxSleepMiles`.
   */
  sleepEligibleChargerIds?: Set<string>;
  maxSleepMiles?: number; // e.g. 600

  /**
   * Fraction of a full pack (0–1] available when leaving `segmentStart` (before any charge there).
   * Default is **1**. Set **< 1** when chaining segment solves so the next solve does not assume a full battery
   * (e.g. locked charger legs after a minimum charge on the previous segment).
   */
  initialDepartSocFraction?: number;

  /**
   * ROUTING_UX §4: after each hop is fully timed (Valhalla / POI edge), optional incremental
   * `partial_route` checkpoints for `planJob` (refinement toward next charge or end).
   */
  onPrefixRefinement?: (p: {
    hopIndex: number;
    stopsPrefix: ItineraryStop[];
    legsPrefix: ItineraryLeg[];
    /** Total legs in the final segment path (`stops.length - 1`). */
    totalLegsInPath: number;
  }) => void | Promise<void>;
};

/** Pillar 1 soft preference — exposed on `POST /plan` `debug.rangeLegOptimizer` when active. */
export type RangeLegOptimizerDebug = {
  mode: "soft_penalty_charge_stop";
  chargeStopPenaltyMinutes: number;
};

/** Pillar 1 harder feasibility — exposed on `POST /plan` `debug.rangeLegFeasibility` when active. */
export type RangeLegFeasibilityDebug = {
  mode: "margin_frac";
  /** Same as env `PLAN_RANGE_LEG_FEASIBILITY_MARGIN_FRAC` (after clamp). */
  marginFrac: number;
  /** `1 - marginFrac` — multiplier on linear SOC distance budgets. */
  feasibilityScale: number;
};

export type PlannedSegment = {
  stops: ItineraryStop[];
  legs: ItineraryLeg[];
  totalTimeMinutes: number;
  segmentOptimizerDebug?: {
    rangeLegOptimizer?: RangeLegOptimizerDebug;
    rangeLegFeasibility?: RangeLegFeasibilityDebug;
  };
  /** Present when initial depart SOC fraction is below a full pack. */
  segmentSocCarryDebug?: { initialDepartSocFraction: number };
};

/** Arrival at a charger: full SOC from start leg ("direct") vs buffer SOC after a charge ("buffer"). */
type StateMode = "direct" | "buffer";
type StateKey = string;

function stateKey(nodeId: string, mode: StateMode, sleepBucket?: number) {
  return sleepBucket == null ? `${nodeId}|${mode}` : `${nodeId}|${mode}|${sleepBucket}`;
}

function parseStateKey(key: string): { nodeId: string; mode: StateMode; sleepBucket?: number } {
  const parts = key.split("|");
  const nodeId = parts[0] ?? "";
  const mode = parts[1] as StateMode;
  const sleepBucket =
    parts.length >= 3 && parts[2] != null && String(parts[2]).length > 0
      ? Number(parts[2])
      : undefined;
  return {
    nodeId,
    mode,
    sleepBucket: sleepBucket == null || Number.isNaN(sleepBucket) ? undefined : sleepBucket
  };
}

type QueueItem = { key: StateKey; cost: number; sleepMiles: number };

/** Min-heap by `cost` — O(log n) push/pop (replaces sort-on-every-pop which was O(n log n) per pop). */
function heapPush(heap: QueueItem[], item: QueueItem): void {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heap[p]!.cost <= item.cost) break;
    heap[i] = heap[p]!;
    i = p;
  }
  heap[i] = item;
}

function heapPop(heap: QueueItem[]): QueueItem | null {
  if (heap.length === 0) return null;
  const min = heap[0]!;
  const last = heap.pop()!;
  if (heap.length === 0) return min;
  heap[0] = last;
  let i = 0;
  const n = heap.length;
  while (true) {
    const l = i * 2 + 1;
    const r = l + 1;
    let smallest = i;
    if (l < n && heap[l]!.cost < heap[smallest]!.cost) smallest = l;
    if (r < n && heap[r]!.cost < heap[smallest]!.cost) smallest = r;
    if (smallest === i) break;
    const tmp = heap[i]!;
    heap[i] = heap[smallest]!;
    heap[smallest] = tmp;
    i = smallest;
  }
  return min;
}

export class NoFeasibleItineraryError extends Error {
  debug: Record<string, unknown>;

  constructor(message: string, debug: Record<string, unknown>) {
    super(message);
    this.name = "NoFeasibleItineraryError";
    this.debug = debug;
  }
}

export async function planLeastTimeSegment(input: SegmentInput): Promise<PlannedSegment> {
  const deploymentEnv = (process.env.DEPLOYMENT_ENV ?? "dev-local").trim().toLowerCase();
  const bufferSoc = input.bufferSoc;
  const rangeMiles = input.rangeMiles;
  const chargeStopPenaltyMinutesRaw = Number(
    process.env.PLAN_RANGE_LEG_CHARGE_STOP_PENALTY_MINUTES ?? "0"
  );
  const chargeStopPenaltyMinutes =
    Number.isFinite(chargeStopPenaltyMinutesRaw) && chargeStopPenaltyMinutesRaw > 0
      ? chargeStopPenaltyMinutesRaw
      : 0;
  /** Added to Dijkstra cost when leaving a charger (after charging) toward the next stop — biases toward fewer charge stops. */
  const chargeStopPenaltyAdd = (fromCharger: boolean) =>
    fromCharger && chargeStopPenaltyMinutes > 0 ? chargeStopPenaltyMinutes : 0;

  const feasibilityMarginRaw = Number(
    process.env.PLAN_RANGE_LEG_FEASIBILITY_MARGIN_FRAC ?? "0"
  );
  let feasibilityMarginFrac = 0;
  if (Number.isFinite(feasibilityMarginRaw) && feasibilityMarginRaw > 0) {
    feasibilityMarginFrac = Math.min(Math.max(feasibilityMarginRaw, 0), 0.999);
  }
  const feasibilityScale = 1 - feasibilityMarginFrac;
  /** Full-pack single-leg distance cap (post-charge hops, charger→end). */
  const maxFullPackLegMiles = rangeMiles * feasibilityScale;
  const initialDepartRaw = input.initialDepartSocFraction;
  let initialDepartSocFraction = 1;
  if (typeof initialDepartRaw === "number" && Number.isFinite(initialDepartRaw)) {
    initialDepartSocFraction = Math.min(Math.max(initialDepartRaw, 0.001), 1);
  }
  /** From trip/segment start with `initialDepartSocFraction` pack (start→charger, start→end). */
  const maxStartPackLegMiles = rangeMiles * initialDepartSocFraction * feasibilityScale;

  const avgSpeedMph = Number(process.env.AVG_SPEED_MPH ?? "60");
  const useValhallaDistanceFeasibility =
    (process.env.USE_VALHALLA_DISTANCE_FEASIBILITY ?? "true").toLowerCase() ===
    "true";
  const disableValhallaLegTiming =
    (process.env.DISABLE_VALHALLA_LEG_TIME ?? "false").toLowerCase() === "true";

  const enableSleepConstraint =
    input.sleepEligibleChargerIds != null && Number.isFinite(input.maxSleepMiles as number);
  const maxSleepMiles = enableSleepConstraint ? (input.maxSleepMiles as number) : 0;
  const sleepEligibleChargerIds = input.sleepEligibleChargerIds ?? new Set<string>();
  /** POI `edges` graph only: no Valhalla during Dijkstra; charger hops use precomputed road miles. */
  const syncConstrainedGraph =
    enableSleepConstraint &&
    Boolean(input.precomputedEdgeDistanceMiles && input.precomputedEdgeDistanceMiles.size > 0);
  const SLEEP_BUCKET_MILES = 10;
  const sleepBucket = (sleepMiles: number) => Math.floor(sleepMiles / SLEEP_BUCKET_MILES);
  const bestSleepMilesByKey: Map<StateKey, number> | null = enableSleepConstraint
    ? new Map<StateKey, number>()
    : null;

  // Edge pruning: for MVP we limit which chargers are considered, and rely on Dijkstra.
  const chargerNodes = input.chargers.map((c) => ({
    id: c.id,
    name: c.name,
    coords: c.coords,
    maxPowerKw: c.maxPowerKw ?? Number(process.env.DEFAULT_MAX_POWER_KW ?? "100")
  }));

  const valhallaCache = new Map<string, number>();
  const valhallaDistanceCache = new Map<string, number>();

  const edgeTravelMin = (fromId: string, toId: string): number | undefined =>
    input.precomputedEdgeTravelMinutes?.get(`${fromId}|${toId}`);
  const edgeDistMi = (fromId: string, toId: string): number | undefined =>
    input.precomputedEdgeDistanceMiles?.get(`${fromId}|${toId}`);

  const travelTimeCached = async (
    from: LatLng,
    to: LatLng,
    fromId?: string,
    toId?: string
  ): Promise<number> => {
    if (fromId && toId) {
      const e = edgeTravelMin(fromId, toId);
      if (e != null) return e;
    }
    if (disableValhallaLegTiming) {
      // During debugging we may want to avoid many Valhalla calls for long stop sequences.
      return estimateTravelTimeMinutes(from, to);
    }
    const key = `${from.lat.toFixed(4)},${from.lon.toFixed(4)}->${to.lat.toFixed(4)},${to.lon.toFixed(4)}`;
    const cached = valhallaCache.get(key);
    if (cached != null) return cached;
    const t = await getTravelTimeMinutes(from, to);
    valhallaCache.set(key, t);
    return t;
  };

  const distanceCached = async (
    from: LatLng,
    to: LatLng,
    fromId?: string,
    toId?: string
  ): Promise<number> => {
    if (fromId && toId) {
      const e = edgeDistMi(fromId, toId);
      if (e != null) return e;
    }
    const key = `${from.lat.toFixed(4)},${from.lon.toFixed(4)}->${to.lat.toFixed(4)},${to.lon.toFixed(4)}`;
    const cached = valhallaDistanceCache.get(key);
    if (cached != null) return cached;
    const d = await getTravelDistanceMiles(from, to);
    valhallaDistanceCache.set(key, d);
    return d;
  };

  function estimateTravelTimeMinutes(from: LatLng, to: LatLng): number {
    // MVP speed approximation (used during optimization for performance).
    // We still compute exact Valhalla travel times for the final legs below.
    const d = haversineMiles(from, to); // miles
    const hours = d / Math.max(1, avgSpeedMph);
    return hours * 60;
  }

  // Precompute distances for reachability + SOC targets.
  const distMilesStartTo = new Map<string, number>();
  for (const ch of chargerNodes) {
    distMilesStartTo.set(ch.id, haversineMiles(input.segmentStart.coords, ch.coords));
  }

  const distMilesFromTo = new Map<string, number>();
  const distMiles = (fromId: string, toId: string, fromCoords: LatLng, toCoords: LatLng) => {
    const key = `${fromId}->${toId}`;
    const cached = distMilesFromTo.get(key);
    if (cached != null) return cached;
    const d = haversineMiles(fromCoords, toCoords);
    distMilesFromTo.set(key, d);
    return d;
  };

  const chargerById = new Map(chargerNodes.map((c) => [c.id, c]));

  // Precompute which charger-to-charger hops are feasible under the SOC constraint.
  // Feasibility check in this solver:
  //   departureSocRequired = distance / rangeMiles + bufferSoc <= 1
  // => distance <= rangeMiles * (1 - bufferSoc)
  // Optional `PLAN_RANGE_LEG_FEASIBILITY_MARGIN_FRAC`: multiply all distance caps by `feasibilityScale`
  // to require slack vs the linear model (road vs chord, taper, weather).
  const maxChargerHopMiles = rangeMiles * (1 - bufferSoc) * feasibilityScale;
  const reachableChargerTargetsByFromId = new Map<string, string[]>();
  if (enableSleepConstraint && input.precomputedEdgeDistanceMiles && input.precomputedEdgeDistanceMiles.size > 0) {
    // Constrained mode: restrict transitions to POI `edges` graph edges only.
    // This ensures sleep constraint updates use the same road-miles source as the adjacency.
    const chargerIdSet = new Set(chargerNodes.map((c) => c.id));
    for (const from of chargerNodes) {
      reachableChargerTargetsByFromId.set(from.id, []);
    }
    for (const [key, dMi] of input.precomputedEdgeDistanceMiles.entries()) {
      const [fromId, toId] = key.split("|");
      if (!chargerIdSet.has(fromId) || !chargerIdSet.has(toId)) continue;
      if (!Number.isFinite(dMi)) continue;
      if (dMi > maxChargerHopMiles) continue;
      const arr = reachableChargerTargetsByFromId.get(fromId) ?? [];
      arr.push(toId);
      reachableChargerTargetsByFromId.set(fromId, arr);
    }
  } else {
    // Default mode: use haversine pre-prune to limit Dijkstra branching, then
    // check exact/edge road distances during expansion.
    for (const from of chargerNodes) {
      const targets: string[] = [];
      for (const to of chargerNodes) {
        if (to.id === from.id) continue;
        // Use a fast haversine pre-prune; exact road distance feasibility is checked during expansion
        // if `useValhallaDistanceFeasibility` is enabled.
        const d = haversineMiles(from.coords, to.coords);
        if (d <= maxChargerHopMiles) targets.push(to.id);
      }
      reachableChargerTargetsByFromId.set(from.id, targets);
    }
  }

  // Initialize Dijkstra with states representing being at charger with arrival mode from start.
  // State stores cost = total time minutes to reach that charger (including charging at the charger when applicable).
  const directStates = chargerNodes.map((ch) => {
    const dist = distMilesStartTo.get(ch.id) ?? Infinity;
    const reachable = dist <= maxStartPackLegMiles;
    return { ch, dist, reachable };
  });

  let bestEndCost = Infinity;
  let bestEndPrevStateKey: string | null = null;

  const dist = new Map<StateKey, number>();
  const prev = new Map<StateKey, StateKey | null>();

  const q: QueueItem[] = [];

  // Start to end direct (no chargers).
  {
    const dStartEnd = haversineMiles(input.segmentStart.coords, input.segmentEnd.coords);
    if (dStartEnd <= maxStartPackLegMiles) {
      // No charging at start assumed. Use fast estimate during optimization.
      const travelTime = estimateTravelTimeMinutes(
        input.segmentStart.coords,
        input.segmentEnd.coords
      );
      if (enableSleepConstraint) {
        if (dStartEnd <= maxSleepMiles) {
          bestEndCost = Math.min(bestEndCost, travelTime);
        }
      } else {
        bestEndCost = Math.min(bestEndCost, travelTime);
      }
    }
  }

  for (const st of directStates) {
    if (!st.reachable) continue;
    const travelTime = estimateTravelTimeMinutes(
      input.segmentStart.coords,
      st.ch.coords
    );
    const sleepMilesBeforeReset = st.dist;
    if (enableSleepConstraint && sleepMilesBeforeReset > maxSleepMiles) {
      continue;
    }
    const isEligible = enableSleepConstraint ? sleepEligibleChargerIds.has(st.ch.id) : false;
    const sleepMilesAfterReset = enableSleepConstraint && isEligible ? 0 : sleepMilesBeforeReset;
    const key = stateKey(
      st.ch.id,
      "direct",
      enableSleepConstraint ? sleepBucket(sleepMilesAfterReset) : undefined
    );
    dist.set(key, travelTime);
    prev.set(key, null);
    if (bestSleepMilesByKey) bestSleepMilesByKey.set(key, sleepMilesAfterReset);
    heapPush(q, { key, cost: travelTime, sleepMiles: sleepMilesAfterReset });
  }

  // If we have no reachable chargers, fail.
  if (!q.length && bestEndCost === Infinity) {
    throw new Error("No reachable chargers for segment");
  }

  // Unconstrained / no POI edges: may await Valhalla per hop (`distanceCached`). `syncConstrainedGraph` path is sync-only.
  let dijkstraStatesProcessed = 0;
  const dijkstraT0 = Date.now();

  while (true) {
    const item = heapPop(q);
    if (!item) break;
    const { key, sleepMiles } = item;
    const known = dist.get(key);
    if (known == null || item.cost !== known) continue;

    dijkstraStatesProcessed++;
    const logDijkstraProgress =
      dijkstraStatesProcessed % 100000 === 0 ||
      dijkstraStatesProcessed === 1000 ||
      dijkstraStatesProcessed === 5000 ||
      dijkstraStatesProcessed === 10000;
    if (logDijkstraProgress) {
      console.log(
        JSON.stringify({
          event: "least_time_segment_dijkstra_progress",
          deploymentEnv,
          requestId: input.requestId,
          statesProcessed: dijkstraStatesProcessed,
          queueSize: q.length,
          elapsedMs: Date.now() - dijkstraT0,
          enableSleepConstraint,
          syncConstrainedGraph
        })
      );
    }

    const { nodeId, mode } = parseStateKey(key);
    const currentNode = nodeId === input.segmentStart.id ? null : chargerById.get(nodeId);

    const fromCoords = currentNode ? currentNode.coords : input.segmentStart.coords;
    const fromIsCharger = currentNode != null;
    const fromMaxPowerKw = currentNode?.maxPowerKw ?? 0;

    // 1) Try going directly to end (no buffer requirement).
    {
      const fromIdForEdge = fromIsCharger
        ? nodeId
        : nodeId === input.segmentStart.id
          ? input.segmentStart.id
          : undefined;
      const distanceToEnd = syncConstrainedGraph
        ? haversineMiles(fromCoords, input.segmentEnd.coords)
        : useValhallaDistanceFeasibility
          ? await distanceCached(
              fromCoords,
              input.segmentEnd.coords,
              fromIdForEdge,
              input.segmentEnd.id
            )
          : haversineMiles(fromCoords, input.segmentEnd.coords);
      const departureSocRequired = distanceToEnd / rangeMiles; // end => no buffer term

      if (departureSocRequired <= feasibilityScale) {
        if (enableSleepConstraint) {
          const sleepMilesToEnd = sleepMiles + distanceToEnd;
          if (sleepMilesToEnd > maxSleepMiles) {
            // Sleep feasibility constraint violated while traveling to end.
            // No reset point exists at the end node.
            continue;
          }
        }

        const arrivalSoc =
          mode === "direct"
            ? modeArrivalSoc(
                nodeId,
                distMilesStartTo,
                input.segmentStart.coords,
                rangeMiles,
                initialDepartSocFraction
              )
            : bufferSoc;

        const chargeTime = fromIsCharger
          ? estimateChargeTimeMinutes({
              arrivalSoc,
              departureSoc: departureSocRequired,
              maxPowerKw: fromMaxPowerKw,
              batteryKwh: input.batteryKwh
            })
          : 0;

        let travelTime = estimateTravelTimeMinutes(fromCoords, input.segmentEnd.coords);
        if (fromIdForEdge) {
          const e = edgeTravelMin(fromIdForEdge, input.segmentEnd.id);
          if (e != null) travelTime = e;
        }
        const nextCost =
          item.cost + chargeTime + travelTime + chargeStopPenaltyAdd(fromIsCharger);
        if (nextCost < bestEndCost) {
          bestEndCost = nextCost;
          bestEndPrevStateKey = key;
        }
      }
    }

    // 2) Try going to feasible charger targets only.
    const nextChargerIds = reachableChargerTargetsByFromId.get(nodeId) ?? [];
    for (const nextChargerId of nextChargerIds) {
      if (nextChargerId === nodeId) continue;
      const nextCharger = chargerById.get(nextChargerId);
      if (!nextCharger) continue;

      let distance: number;
      if (syncConstrainedGraph) {
        const d = edgeDistMi(nodeId, nextChargerId);
        if (d == null || !Number.isFinite(d)) continue;
        distance = d;
      } else if (useValhallaDistanceFeasibility) {
        distance = await distanceCached(fromCoords, nextCharger.coords, nodeId, nextChargerId);
      } else {
        distance =
          edgeDistMi(nodeId, nextChargerId) ?? haversineMiles(fromCoords, nextCharger.coords);
      }
      const departureSocRequired = distance / rangeMiles + bufferSoc; // buffer required to keep going
      if (departureSocRequired > 1) continue; // safety check; should be implied by reachable list

      const arrivalSoc =
        mode === "direct"
          ? modeArrivalSoc(
              nodeId,
              distMilesStartTo,
              input.segmentStart.coords,
              rangeMiles,
              initialDepartSocFraction
            )
          : bufferSoc;

      let nextSleepMiles = sleepMiles;
      if (enableSleepConstraint) {
        const sleepMilesBeforeReset = sleepMiles + distance;
        if (sleepMilesBeforeReset > maxSleepMiles) continue;

        // Reset sleep accumulator only when landing on a hotel-adjacent charger.
        nextSleepMiles = sleepEligibleChargerIds.has(nextChargerId) ? 0 : sleepMilesBeforeReset;
      }

      const chargeTime = fromIsCharger
        ? estimateChargeTimeMinutes({
            arrivalSoc,
            departureSoc: departureSocRequired,
            maxPowerKw: fromMaxPowerKw,
            batteryKwh: input.batteryKwh
          })
        : 0;

      let travelTime = estimateTravelTimeMinutes(fromCoords, nextCharger.coords);
      const eMin = edgeTravelMin(nodeId, nextChargerId);
      if (eMin != null) travelTime = eMin;
      const nextCost = item.cost + chargeTime + travelTime;

      const nextMode: StateMode = "buffer";
      const nextKey = stateKey(
        nextChargerId,
        nextMode,
        enableSleepConstraint ? sleepBucket(nextSleepMiles) : undefined
      );

      const prevBest = dist.get(nextKey);
      const prevSleep = bestSleepMilesByKey?.get(nextKey);
      const costImproves = prevBest == null || nextCost < prevBest;
      const sleepImprovesAtSameCost =
        enableSleepConstraint &&
        prevBest != null &&
        nextCost === prevBest &&
        prevSleep != null &&
        nextSleepMiles < prevSleep;
      const shouldUpdate = costImproves || sleepImprovesAtSameCost;

      if (shouldUpdate) {
        dist.set(nextKey, nextCost);
        // Only record a new predecessor on strict cost improvement (or first visit).
        // Tie-breaking on sleep at *equal* cost must not overwrite `prev`: that can create
        // cycles when backtracking (same state key, different parents on equal-cost paths).
        if (costImproves) {
          prev.set(nextKey, key);
        }
        if (bestSleepMilesByKey) bestSleepMilesByKey.set(nextKey, nextSleepMiles);
        heapPush(q, { key: nextKey, cost: nextCost, sleepMiles: nextSleepMiles });
      }
    }
  }

  if (enableSleepConstraint || dijkstraStatesProcessed >= 1000) {
    console.log(
      JSON.stringify({
        event: "least_time_segment_dijkstra_done",
        deploymentEnv,
        requestId: input.requestId,
        statesProcessed: dijkstraStatesProcessed,
        elapsedMs: Date.now() - dijkstraT0,
        enableSleepConstraint,
        syncConstrainedGraph
      })
    );
  }

  console.log(
    JSON.stringify({
      event: "least_time_segment_checkpoint_after_dijkstra",
      deploymentEnv,
      requestId: input.requestId,
      segmentEndId: input.segmentEnd.id,
      bestEndCostFinite: Number.isFinite(bestEndCost),
      bestEndPrevStateKeyPresent: bestEndPrevStateKey != null
    })
  );

  // If end is reachable directly (start -> end), bestEndCost can be finite while
  // bestEndPrevStateKey remains null (no charger state to reconstruct).
  // In that case, reconstruction naturally yields an empty charger sequence,
  // and we should return a direct-only segment instead of failing.
  if (!Number.isFinite(bestEndCost)) {
    // Compute solver debug payload to explain *why* we failed.
    const directReachableIds = directStates
      .filter((s) => s.reachable)
      .map((s) => s.ch.id);

    const endWithinRangeCount = chargerNodes.filter(
      (c) => haversineMiles(c.coords, input.segmentEnd.coords) <= maxFullPackLegMiles
    ).length;

    const reachableEdgeCount = Array.from(reachableChargerTargetsByFromId.values()).reduce(
      (sum, arr) => sum + arr.length,
      0
    );

    const visited = new Set<string>();
    const q2 = [...directReachableIds];
    let reachableEndWithConstraints = false;

    while (q2.length) {
      const id = q2.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);

      const node = chargerById.get(id);
      if (node) {
        if (haversineMiles(node.coords, input.segmentEnd.coords) <= maxFullPackLegMiles) {
          reachableEndWithConstraints = true;
          break;
        }
      }

      const nextIds = reachableChargerTargetsByFromId.get(id) ?? [];
      for (const nb of nextIds) {
        if (!visited.has(nb)) q2.push(nb);
      }
    }

    throw new NoFeasibleItineraryError("No feasible itinerary for segment", {
      solver: "leastTimeSegment",
      dijkstraStatesProcessed,
      dijkstraElapsedMs: Date.now() - dijkstraT0,
      syncConstrainedGraph,
      message: useValhallaDistanceFeasibility
        ? "No path exists under the current Valhalla road-distance SOC feasibility constraint."
        : "No path exists under the current haversine-based SOC feasibility constraint.",
      chargingFeasibilityModel: useValhallaDistanceFeasibility
        ? "valhalla-road-distance hop constraint"
        : "haversine-distance hop constraint",
      bufferSoc,
      rangeMiles,
      feasibilityMarginFrac,
      feasibilityScale,
      maxFullPackLegMiles,
      maxStartPackLegMiles,
      initialDepartSocFraction,
      ...(enableSleepConstraint
        ? {
            sleepConstraint: true,
            maxSleepMiles,
            hotelAdjacentChargersCount: sleepEligibleChargerIds.size
          }
        : {}),
      maxChargerHopMiles,
      chargerNodesCount: chargerNodes.length,
      reachableEdgeCount,
      directReachableCount: directReachableIds.length,
      endWithinRangeCount,
      reachableEndWithConstraints,
      visitedChargerCount: visited.size,
      bestEndCost: Number.isFinite(bestEndCost) ? bestEndCost : null
    });
  }

  console.log(
    JSON.stringify({
      event: "least_time_segment_enter_tail",
      deploymentEnv,
      requestId: input.requestId,
      segmentEndId: input.segmentEnd.id
    })
  );

  const tailT0 = Date.now();

  // Reconstruct charger sequence for bestEndPrevStateKey.
  const chargerSequence: string[] = [];
  let curKey: StateKey | null = bestEndPrevStateKey;
  const reconSeen = new Set<StateKey>();
  let reconSteps = 0;
  const RECONSTRUCTION_MAX_STEPS = 25000;

  while (curKey) {
    reconSteps++;
    if (reconSteps > RECONSTRUCTION_MAX_STEPS) {
      console.log(
        JSON.stringify({
          event: "least_time_segment_reconstruction_abort",
          deploymentEnv,
          requestId: input.requestId,
          reconSteps,
          curKey
        })
      );
      throw new Error(
        `leastTimeSegment: reconstruction exceeded ${RECONSTRUCTION_MAX_STEPS} steps (prev chain too long or cycle)`
      );
    }
    if (reconSeen.has(curKey)) {
      console.log(
        JSON.stringify({
          event: "least_time_segment_reconstruction_cycle",
          deploymentEnv,
          requestId: input.requestId,
          curKey
        })
      );
      throw new Error("leastTimeSegment: reconstruction detected a cycle in prev chain");
    }
    reconSeen.add(curKey);

    const { nodeId, mode } = parseStateKey(curKey);
    if (nodeId === input.segmentEnd.id) break;
    chargerSequence.unshift(nodeId);
    curKey = prev.get(curKey) ?? null;
    // When prev is null, we've reached the first charger state from start.
    if (curKey == null) break;
  }

  console.log(
    JSON.stringify({
      event: "least_time_segment_reconstruction_done",
      deploymentEnv,
      requestId: input.requestId,
      reconSteps,
      chargerSequenceLength: chargerSequence.length
    })
  );

  // Build stops.
  const stops: ItineraryStop[] = [];
  stops.push({
    id: input.segmentStart.id,
    type: "start",
    name: input.segmentStart.id,
    coords: input.segmentStart.coords,
    etaMinutesFromStart: 0
  });

  for (const chId of chargerSequence) {
    const ch = chargerById.get(chId);
    if (!ch) continue;
    stops.push({
      id: ch.id,
      type: "charge",
      name: ch.name,
      coords: ch.coords
    });
  }

  stops.push({
    id: input.segmentEnd.id,
    type: "end",
    name: input.segmentEnd.id,
    coords: input.segmentEnd.coords
  });

  if (syncConstrainedGraph) {
    console.log(
      JSON.stringify({
        event: "least_time_segment_reconstruction",
        deploymentEnv,
        requestId: input.requestId,
        chargerSequenceLength: chargerSequence.length,
        stopsCount: stops.length,
        legsToBuild: stops.length - 1
      })
    );
  }

  // Build legs with timing:
  // - compute exact-ish Valhalla travel times for the chosen stop sequence
  // - compute charging time using charging-time approximation
  // - sync constrained graph: POI edge minutes only (no Valhalla flood on long chains)
  const legs: ItineraryLeg[] = [];
  let running = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    const from = stops[i];
    const to = stops[i + 1];

    const travelTimeMinutes = syncConstrainedGraph
      ? (() => {
          const e = edgeTravelMin(from.id, to.id);
          if (e != null && Number.isFinite(e)) return e;
          return estimateTravelTimeMinutes(from.coords, to.coords);
        })()
      : await travelTimeCached(from.coords, to.coords, from.id, to.id);
    let chargeTimeMinutes: number | undefined = undefined;

    if (from.type === "charge") {
      const fromArrivalSoc =
        i === 1
          ? clamp(
              initialDepartSocFraction - distanceMiles(input.segmentStart.coords, from.coords, rangeMiles),
              0,
              1
            )
          : bufferSoc;
      // Target departure SOC based on next being a charger.
      const isNextCharger = to.type === "charge";
      const distanceTo = haversineMiles(from.coords, to.coords);
      const departureSocRequired = distanceTo / rangeMiles + (isNextCharger ? bufferSoc : 0);
      chargeTimeMinutes = estimateChargeTimeMinutes({
        arrivalSoc: fromArrivalSoc,
        departureSoc: departureSocRequired,
        maxPowerKw: chargerById.get(from.id)?.maxPowerKw ?? Number(process.env.DEFAULT_MAX_POWER_KW ?? "100"),
        batteryKwh: input.batteryKwh
      });
    }

    const leg: ItineraryLeg = {
      fromStopId: from.id,
      toStopId: to.id,
      travelTimeMinutes,
      chargeTimeMinutes
    };
    legs.push(leg);
    running += travelTimeMinutes + (chargeTimeMinutes ?? 0);
    to.etaMinutesFromStart = running;

    if (input.onPrefixRefinement) {
      await input.onPrefixRefinement({
        hopIndex: i,
        stopsPrefix: stops.slice(0, i + 2),
        legsPrefix: legs.slice(),
        totalLegsInPath: stops.length - 1
      });
    }
  }

  const tailMs = Date.now() - tailT0;
  console.log(
    JSON.stringify({
      event: "least_time_segment_tail_done",
      deploymentEnv,
      requestId: input.requestId,
      tailMs,
      stopsCount: stops.length,
      legsCount: legs.length,
      syncConstrainedGraph
    })
  );

  const out: PlannedSegment = { stops, legs, totalTimeMinutes: running };
  const segOpt: NonNullable<PlannedSegment["segmentOptimizerDebug"]> = {};
  if (chargeStopPenaltyMinutes > 0) {
    segOpt.rangeLegOptimizer = {
      mode: "soft_penalty_charge_stop",
      chargeStopPenaltyMinutes
    };
  }
  if (feasibilityMarginFrac > 0) {
    segOpt.rangeLegFeasibility = {
      mode: "margin_frac",
      marginFrac: feasibilityMarginFrac,
      feasibilityScale
    };
  }
  if (Object.keys(segOpt).length > 0) {
    out.segmentOptimizerDebug = segOpt;
  }
  if (initialDepartSocFraction < 1 - 1e-9) {
    out.segmentSocCarryDebug = { initialDepartSocFraction };
  }
  return out;
}

function distanceMiles(a: LatLng, b: LatLng, rangeMiles: number) {
  return haversineMiles(a, b) / rangeMiles;
}

function modeArrivalSoc(
  nodeId: string,
  distMilesStartTo: Map<string, number>,
  startCoord: LatLng,
  rangeMiles: number,
  initialPackFraction: number
) {
  const d = distMilesStartTo.get(nodeId) ?? Infinity;
  const soc = initialPackFraction - d / rangeMiles;
  return clamp(soc, 0, 1);
}

