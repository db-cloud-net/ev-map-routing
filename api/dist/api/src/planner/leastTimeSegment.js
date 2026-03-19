"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NoFeasibleItineraryError = void 0;
exports.planLeastTimeSegment = planLeastTimeSegment;
const chargingTimeModel_1 = require("./chargingTimeModel");
const geo_1 = require("./geo");
const valhallaClient_1 = require("../services/valhallaClient");
function stateKey(nodeId, mode) {
    return `${nodeId}|${mode}`;
}
function parseStateKey(key) {
    const [nodeId, mode] = key.split("|");
    return { nodeId, mode: mode };
}
function priorityQueuePop(q) {
    if (!q.length)
        return null;
    q.sort((a, b) => a.cost - b.cost);
    return q.shift() ?? null;
}
class NoFeasibleItineraryError extends Error {
    debug;
    constructor(message, debug) {
        super(message);
        this.name = "NoFeasibleItineraryError";
        this.debug = debug;
    }
}
exports.NoFeasibleItineraryError = NoFeasibleItineraryError;
async function planLeastTimeSegment(input) {
    const bufferSoc = input.bufferSoc;
    const rangeMiles = input.rangeMiles;
    const avgSpeedMph = Number(process.env.AVG_SPEED_MPH ?? "60");
    const useValhallaDistanceFeasibility = (process.env.USE_VALHALLA_DISTANCE_FEASIBILITY ?? "true").toLowerCase() ===
        "true";
    const disableValhallaLegTiming = (process.env.DISABLE_VALHALLA_LEG_TIME ?? "false").toLowerCase() === "true";
    // Edge pruning: for MVP we limit which chargers are considered, and rely on Dijkstra.
    const chargerNodes = input.chargers.map((c) => ({
        id: c.id,
        name: c.name,
        coords: c.coords,
        maxPowerKw: c.maxPowerKw ?? Number(process.env.DEFAULT_MAX_POWER_KW ?? "100")
    }));
    const valhallaCache = new Map();
    const valhallaDistanceCache = new Map();
    const travelTimeCached = async (from, to) => {
        if (disableValhallaLegTiming) {
            // During debugging we may want to avoid many Valhalla calls for long stop sequences.
            return estimateTravelTimeMinutes(from, to);
        }
        const key = `${from.lat.toFixed(4)},${from.lon.toFixed(4)}->${to.lat.toFixed(4)},${to.lon.toFixed(4)}`;
        const cached = valhallaCache.get(key);
        if (cached != null)
            return cached;
        const t = await (0, valhallaClient_1.getTravelTimeMinutes)(from, to);
        valhallaCache.set(key, t);
        return t;
    };
    const distanceCached = async (from, to) => {
        const key = `${from.lat.toFixed(4)},${from.lon.toFixed(4)}->${to.lat.toFixed(4)},${to.lon.toFixed(4)}`;
        const cached = valhallaDistanceCache.get(key);
        if (cached != null)
            return cached;
        const d = await (0, valhallaClient_1.getTravelDistanceMiles)(from, to);
        valhallaDistanceCache.set(key, d);
        return d;
    };
    function estimateTravelTimeMinutes(from, to) {
        // MVP speed approximation (used during optimization for performance).
        // We still compute exact Valhalla travel times for the final legs below.
        const d = (0, geo_1.haversineMiles)(from, to); // miles
        const hours = d / Math.max(1, avgSpeedMph);
        return hours * 60;
    }
    // Precompute distances for reachability + SOC targets.
    const distMilesStartTo = new Map();
    for (const ch of chargerNodes) {
        distMilesStartTo.set(ch.id, (0, geo_1.haversineMiles)(input.segmentStart.coords, ch.coords));
    }
    const distMilesFromTo = new Map();
    const distMiles = (fromId, toId, fromCoords, toCoords) => {
        const key = `${fromId}->${toId}`;
        const cached = distMilesFromTo.get(key);
        if (cached != null)
            return cached;
        const d = (0, geo_1.haversineMiles)(fromCoords, toCoords);
        distMilesFromTo.set(key, d);
        return d;
    };
    const chargerById = new Map(chargerNodes.map((c) => [c.id, c]));
    // Precompute which charger-to-charger hops are feasible under the SOC constraint.
    // Feasibility check in this solver:
    //   departureSocRequired = distance / rangeMiles + bufferSoc <= 1
    // => distance <= rangeMiles * (1 - bufferSoc)
    const maxChargerHopMiles = rangeMiles * (1 - bufferSoc);
    const reachableChargerTargetsByFromId = new Map();
    for (const from of chargerNodes) {
        const targets = [];
        for (const to of chargerNodes) {
            if (to.id === from.id)
                continue;
            // Use a fast haversine pre-prune; exact road distance feasibility is checked during expansion
            // if `useValhallaDistanceFeasibility` is enabled.
            const d = (0, geo_1.haversineMiles)(from.coords, to.coords);
            if (d <= maxChargerHopMiles)
                targets.push(to.id);
        }
        reachableChargerTargetsByFromId.set(from.id, targets);
    }
    // Initialize Dijkstra with states representing being at charger with arrival mode from start.
    // State stores cost = total time minutes to reach that charger (including charging at the charger when applicable).
    const directStates = chargerNodes.map((ch) => {
        const dist = distMilesStartTo.get(ch.id) ?? Infinity;
        const reachable = dist <= rangeMiles; // can reach charger with full start SOC, no charging at start
        return { ch, dist, reachable };
    });
    let bestEndCost = Infinity;
    let bestEndPrevStateKey = null;
    const dist = new Map();
    const prev = new Map();
    const q = [];
    // Start to end direct (no chargers).
    {
        const dStartEnd = (0, geo_1.haversineMiles)(input.segmentStart.coords, input.segmentEnd.coords);
        if (dStartEnd <= rangeMiles) {
            // No charging at start assumed. Use fast estimate during optimization.
            const travelTime = estimateTravelTimeMinutes(input.segmentStart.coords, input.segmentEnd.coords);
            bestEndCost = Math.min(bestEndCost, travelTime);
        }
    }
    for (const st of directStates) {
        if (!st.reachable)
            continue;
        const travelTime = estimateTravelTimeMinutes(input.segmentStart.coords, st.ch.coords);
        const key = stateKey(st.ch.id, "direct");
        dist.set(key, travelTime);
        prev.set(key, null);
        q.push({ key, cost: travelTime });
    }
    // If we have no reachable chargers, fail.
    if (!q.length && bestEndCost === Infinity) {
        throw new Error("No reachable chargers for segment");
    }
    while (true) {
        const item = priorityQueuePop(q);
        if (!item)
            break;
        const { key } = item;
        const known = dist.get(key);
        if (known == null || item.cost !== known)
            continue;
        const { nodeId, mode } = parseStateKey(key);
        const currentNode = nodeId === input.segmentStart.id ? null : chargerById.get(nodeId);
        const fromCoords = currentNode ? currentNode.coords : input.segmentStart.coords;
        const fromIsCharger = currentNode != null;
        const fromMaxPowerKw = currentNode?.maxPowerKw ?? 0;
        // 1) Try going directly to end (no buffer requirement).
        {
            const distanceToEnd = useValhallaDistanceFeasibility
                ? await distanceCached(fromCoords, input.segmentEnd.coords)
                : (0, geo_1.haversineMiles)(fromCoords, input.segmentEnd.coords);
            const departureSocRequired = distanceToEnd / rangeMiles; // end => no buffer term
            if (departureSocRequired <= 1) {
                const arrivalSoc = mode === "direct"
                    ? modeArrivalSoc(nodeId, distMilesStartTo, input.segmentStart.coords, rangeMiles)
                    : bufferSoc;
                const chargeTime = fromIsCharger
                    ? (0, chargingTimeModel_1.estimateChargeTimeMinutes)({
                        arrivalSoc,
                        departureSoc: departureSocRequired,
                        maxPowerKw: fromMaxPowerKw,
                        batteryKwh: input.batteryKwh
                    })
                    : 0;
                const travelTime = estimateTravelTimeMinutes(fromCoords, input.segmentEnd.coords);
                const nextCost = item.cost + chargeTime + travelTime;
                if (nextCost < bestEndCost) {
                    bestEndCost = nextCost;
                    bestEndPrevStateKey = key;
                }
            }
        }
        // 2) Try going to feasible charger targets only.
        const nextChargerIds = reachableChargerTargetsByFromId.get(nodeId) ?? [];
        for (const nextChargerId of nextChargerIds) {
            if (nextChargerId === nodeId)
                continue;
            const nextCharger = chargerById.get(nextChargerId);
            if (!nextCharger)
                continue;
            const distance = useValhallaDistanceFeasibility
                ? await distanceCached(fromCoords, nextCharger.coords)
                : (0, geo_1.haversineMiles)(fromCoords, nextCharger.coords);
            const departureSocRequired = distance / rangeMiles + bufferSoc; // buffer required to keep going
            if (departureSocRequired > 1)
                continue; // safety check; should be implied by reachable list
            const arrivalSoc = mode === "direct"
                ? modeArrivalSoc(nodeId, distMilesStartTo, input.segmentStart.coords, rangeMiles)
                : bufferSoc;
            const chargeTime = fromIsCharger
                ? (0, chargingTimeModel_1.estimateChargeTimeMinutes)({
                    arrivalSoc,
                    departureSoc: departureSocRequired,
                    maxPowerKw: fromMaxPowerKw,
                    batteryKwh: input.batteryKwh
                })
                : 0;
            const travelTime = estimateTravelTimeMinutes(fromCoords, nextCharger.coords);
            const nextCost = item.cost + chargeTime + travelTime;
            const nextMode = "buffer";
            const nextKey = stateKey(nextChargerId, nextMode);
            const prevBest = dist.get(nextKey);
            if (prevBest == null || nextCost < prevBest) {
                dist.set(nextKey, nextCost);
                prev.set(nextKey, key);
                q.push({ key: nextKey, cost: nextCost });
            }
        }
    }
    // If end is reachable directly (start -> end), bestEndCost can be finite while
    // bestEndPrevStateKey remains null (no charger state to reconstruct).
    // In that case, reconstruction naturally yields an empty charger sequence,
    // and we should return a direct-only segment instead of failing.
    if (!Number.isFinite(bestEndCost)) {
        // Compute solver debug payload to explain *why* we failed.
        const directReachableIds = directStates
            .filter((s) => s.reachable)
            .map((s) => s.ch.id);
        const endWithinRangeCount = chargerNodes.filter((c) => (0, geo_1.haversineMiles)(c.coords, input.segmentEnd.coords) <= rangeMiles).length;
        const reachableEdgeCount = Array.from(reachableChargerTargetsByFromId.values()).reduce((sum, arr) => sum + arr.length, 0);
        const visited = new Set();
        const q2 = [...directReachableIds];
        let reachableEndWithConstraints = false;
        while (q2.length) {
            const id = q2.shift();
            if (visited.has(id))
                continue;
            visited.add(id);
            const node = chargerById.get(id);
            if (node) {
                if ((0, geo_1.haversineMiles)(node.coords, input.segmentEnd.coords) <= rangeMiles) {
                    reachableEndWithConstraints = true;
                    break;
                }
            }
            const nextIds = reachableChargerTargetsByFromId.get(id) ?? [];
            for (const nb of nextIds) {
                if (!visited.has(nb))
                    q2.push(nb);
            }
        }
        throw new NoFeasibleItineraryError("No feasible itinerary for segment", {
            solver: "leastTimeSegment",
            message: useValhallaDistanceFeasibility
                ? "No path exists under the current Valhalla road-distance SOC feasibility constraint."
                : "No path exists under the current haversine-based SOC feasibility constraint.",
            chargingFeasibilityModel: useValhallaDistanceFeasibility
                ? "valhalla-road-distance hop constraint"
                : "haversine-distance hop constraint",
            bufferSoc,
            rangeMiles,
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
    // Reconstruct charger sequence for bestEndPrevStateKey.
    const chargerSequence = [];
    let curKey = bestEndPrevStateKey;
    while (curKey) {
        const { nodeId, mode } = parseStateKey(curKey);
        if (nodeId === input.segmentEnd.id)
            break;
        chargerSequence.unshift(nodeId);
        curKey = prev.get(curKey) ?? null;
        // When prev is null, we've reached the first charger state from start.
        if (curKey == null)
            break;
    }
    // Build stops.
    const stops = [];
    stops.push({
        id: input.segmentStart.id,
        type: "start",
        name: input.segmentStart.id,
        coords: input.segmentStart.coords,
        etaMinutesFromStart: 0
    });
    for (const chId of chargerSequence) {
        const ch = chargerById.get(chId);
        if (!ch)
            continue;
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
    // Build legs with timing:
    // - compute exact-ish Valhalla travel times for the chosen stop sequence
    // - compute charging time using charging-time approximation
    const legs = [];
    let running = 0;
    for (let i = 0; i < stops.length - 1; i++) {
        const from = stops[i];
        const to = stops[i + 1];
        const travelTimeMinutes = await travelTimeCached(from.coords, to.coords);
        let chargeTimeMinutes = undefined;
        if (from.type === "charge") {
            const fromArrivalSoc = i === 1 ? (0, geo_1.clamp)(1 - distanceMiles(input.segmentStart.coords, from.coords, rangeMiles), 0, 1) : bufferSoc;
            // Target departure SOC based on next being a charger.
            const isNextCharger = to.type === "charge";
            const distanceTo = (0, geo_1.haversineMiles)(from.coords, to.coords);
            const departureSocRequired = distanceTo / rangeMiles + (isNextCharger ? bufferSoc : 0);
            chargeTimeMinutes = (0, chargingTimeModel_1.estimateChargeTimeMinutes)({
                arrivalSoc: fromArrivalSoc,
                departureSoc: departureSocRequired,
                maxPowerKw: chargerById.get(from.id)?.maxPowerKw ?? Number(process.env.DEFAULT_MAX_POWER_KW ?? "100"),
                batteryKwh: input.batteryKwh
            });
        }
        const leg = {
            fromStopId: from.id,
            toStopId: to.id,
            travelTimeMinutes,
            chargeTimeMinutes
        };
        legs.push(leg);
        running += travelTimeMinutes + (chargeTimeMinutes ?? 0);
        to.etaMinutesFromStart = running;
    }
    // Total time should be consistent with the chosen legs.
    return { stops, legs, totalTimeMinutes: running };
}
function distanceMiles(a, b, rangeMiles) {
    return (0, geo_1.haversineMiles)(a, b) / rangeMiles;
}
function modeArrivalSoc(nodeId, distMilesStartTo, startCoord, rangeMiles) {
    const d = distMilesStartTo.get(nodeId) ?? Infinity;
    const soc = 1 - d / rangeMiles;
    return (0, geo_1.clamp)(soc, 0, 1);
}
