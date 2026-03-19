"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planTrip = planTrip;
const geocode_1 = require("../services/geocode");
const overpassClient_1 = require("../services/overpassClient");
const nrelClient_1 = require("../services/nrelClient");
const leastTimeSegment_1 = require("./leastTimeSegment");
const geo_1 = require("./geo");
const valhallaClient_1 = require("../services/valhallaClient");
const roadSampling_1 = require("./roadSampling");
function interpolateLatLng(a, b, t) {
    return {
        lat: a.lat + (b.lat - a.lat) * t,
        lon: a.lon + (b.lon - a.lon) * t
    };
}
async function planTrip(input) {
    const debug = {
        segmentsAttempted: [],
        overnightAnchors: []
    };
    try {
        const rangeMiles = Number(process.env.EV_RANGE_MILES ?? "260");
        const bufferSoc = Number(process.env.CHARGE_BUFFER_SOC ?? "0");
        const batteryKwh = Number(process.env.BATTERY_KWH ?? "72");
        const overnightThresholdMinutes = Number(process.env.OVERNIGHT_THRESHOLD_MINUTES ?? "600");
        const sleepMinutes = Number(process.env.SLEEP_MINUTES ?? "480");
        const maxOvernightStops = Number(process.env.MAX_OVERNIGHT_STOPS ?? "3");
        const hotelRadiusMeters = Number(process.env.HOTEL_RADIUS_METERS ?? "365.76");
        const hotelRadiusYards = Math.round(hotelRadiusMeters / 0.9144);
        const overnightHotelRadiusMeters = Number(process.env.OVERNIGHT_HOTEL_RADIUS_METERS ?? String(hotelRadiusMeters));
        const overnightHotelRadiusYards = Math.round(overnightHotelRadiusMeters / 0.9144);
        const hotelCache = new Map();
        const hotelChargerCache = new Map();
        // 1) Geocode.
        const startCoords = await (0, geocode_1.geocodeTextToLatLng)(input.start);
        const endCoords = await (0, geocode_1.geocodeTextToLatLng)(input.end);
        // 2) Fetch candidate DC fast chargers along corridor.
        // MVP "A": sample points along the Valhalla route polyline (road-based), but keep
        // feasibility checks inside the segment planner using straight-line (haversine).
        const radiusMiles = Number(process.env.NREL_RADIUS_MILES ?? "30");
        const stepMiles = Number(process.env.CORRIDOR_STEP_MILES ?? "30");
        const maxCorridorSamples = Number(process.env.CORRIDOR_MAX_SAMPLE_POINTS ?? "80");
        const candidateChargersCap = Number(process.env.CANDIDATE_CHARGERS_CAP ?? "25");
        const includeAllElectricChargers = (process.env.NREL_INCLUDE_ALL_ELECTRIC_CHARGERS ?? "false").toLowerCase() ===
            "true";
        const useNearbyRoute = (process.env.USE_NREL_NEARBY_ROUTE ?? "false").toLowerCase() === "true";
        let samplePoints = [];
        try {
            const poly = await (0, valhallaClient_1.getRoutePolyline)(startCoords, endCoords);
            samplePoints = (0, roadSampling_1.samplePointsAlongPolyline)(poly, stepMiles, maxCorridorSamples);
        }
        catch {
            // Fallback to straight-line sampling if Valhalla geometry isn't available yet.
            const approxMiles = (0, geo_1.haversineMiles)(startCoords, endCoords);
            // Ensure we still respect CORRIDOR_MAX_SAMPLE_POINTS in fallback mode,
            // otherwise charger sampling can explode into too many NREL requests.
            const rawSampleCount = Math.max(5, Math.ceil(approxMiles / stepMiles));
            const approxSampleCount = Math.min(rawSampleCount, maxCorridorSamples);
            for (let i = 0; i < approxSampleCount; i++) {
                const t = approxSampleCount <= 1 ? 0 : i / (approxSampleCount - 1);
                samplePoints.push(interpolateLatLng(startCoords, endCoords, t));
            }
        }
        // Ensure NREL route corridor actually includes the exact endpoints.
        // `samplePointsAlongPolyline()` may dedupe points near the ends, which can
        // accidentally exclude the final `endCoords` from the WKT line string.
        if (samplePoints.length > 0) {
            const startD = (0, geo_1.haversineMiles)(samplePoints[0], startCoords);
            if (startD > 0.05)
                samplePoints.unshift(startCoords);
            const endD = (0, geo_1.haversineMiles)(samplePoints[samplePoints.length - 1], endCoords);
            if (endD > 0.05)
                samplePoints.push(endCoords);
        }
        let chargers = [];
        if (useNearbyRoute && samplePoints.length >= 2) {
            chargers = await (0, nrelClient_1.fetchDcFastChargersNearRoute)(samplePoints, radiusMiles);
        }
        else {
            // Default MVP behavior: query NREL around multiple points along the corridor.
            const chargersById = new Map();
            for (const p of samplePoints) {
                const chargersNearPoint = includeAllElectricChargers
                    ? await (0, nrelClient_1.fetchElectricChargersNearPoint)(p, radiusMiles)
                    : await (0, nrelClient_1.fetchDcFastChargersNearPoint)(p, radiusMiles);
                for (const c of chargersNearPoint)
                    chargersById.set(c.id, c);
            }
            chargers = Array.from(chargersById.values());
        }
        debug.chargersFoundTotal = chargers.length;
        debug.corridorSampling = {
            stepMiles,
            nrelRadiusMiles: radiusMiles,
            corridorSamplesUsed: samplePoints.length,
            corridorMaxSamples: maxCorridorSamples,
            chargersCandidateCap: candidateChargersCap,
            mode: useNearbyRoute ? "nearby-route" : "nearby-point"
        };
        if (!chargers.length) {
            return {
                requestId: input.requestId,
                responseVersion: input.responseVersion,
                status: "error",
                message: "No EV charging stops found for the trip.",
                debug,
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
        // Important: NREL results are not guaranteed to be sorted by distance.
        // We will pick the nearest candidates per segment below.
        const chargerCandidates = chargers;
        // 3) Build itinerary with up to N overnight insertions.
        const finalEnd = { id: "end", type: "end", coords: endCoords };
        let overallStops = [];
        let overallLegs = [];
        let sleepTimeMinutesTotal = 0;
        let overnightStopsCount = 0;
        let lastHotelMessage;
        let currentStart = { id: "start", coords: startCoords };
        for (let overnightIndex = 0; overnightIndex < maxOvernightStops; overnightIndex++) {
            const segmentAttempt = {
                overnightIndex,
                segmentStartId: currentStart.id
            };
            const chargersForSegment = chargerCandidates
                // Candidate selection must include chargers near both the start and the end.
                // Otherwise, the segment planner can’t reach the destination with the
                // SOC-buffer constraints.
                .filter((c) => Number.isFinite(c.coords?.lat) && Number.isFinite(c.coords?.lon))
                .slice(); // force evaluation
            const endReachable = chargersForSegment
                .filter((c) => (0, geo_1.haversineMiles)(finalEnd.coords, c.coords) <= rangeMiles);
            const startSorted = chargersForSegment
                .map((c) => ({
                c,
                dMiles: (0, geo_1.haversineMiles)(currentStart.coords, c.coords)
            }))
                .sort((a, b) => a.dMiles - b.dMiles)
                .map((x) => x.c);
            const seen = new Set();
            const combined = [];
            const pushUnique = (ch) => {
                const id = String(ch.id ?? `${ch.coords.lat}:${ch.coords.lon}`);
                if (seen.has(id))
                    return;
                seen.add(id);
                combined.push(ch);
            };
            for (const c of endReachable)
                pushUnique(c);
            for (const c of startSorted)
                pushUnique(c);
            // Cap candidates in a way that preserves mid-corridor connectivity.
            // Instead of taking the first N by (start/end) bias, we:
            // 1) compute approximate "progress" from currentStart,
            // 2) sort by that progress,
            // 3) take evenly-spaced representatives across the sorted set.
            const progressSorted = combined
                .map((ch) => ({
                ch,
                dMiles: (0, geo_1.haversineMiles)(currentStart.coords, ch.coords)
            }))
                .sort((a, b) => a.dMiles - b.dMiles)
                .map((x) => x.ch);
            const pickEvenlySpaced = (arr, cap) => {
                if (arr.length <= cap)
                    return arr;
                if (cap <= 1)
                    return arr.slice(0, 1);
                const picked = [];
                const seen = new Set();
                const lastIdx = arr.length - 1;
                for (let i = 0; i < cap; i++) {
                    const idx = Math.round((i * lastIdx) / (cap - 1));
                    const ch = arr[idx];
                    const id = String(ch.id ?? `${ch.coords.lat}:${ch.coords.lon}`);
                    if (seen.has(id))
                        continue;
                    seen.add(id);
                    picked.push(ch);
                }
                // If rounding caused duplicates to reduce count, fill nearest from the left.
                if (picked.length < cap) {
                    for (const ch of arr) {
                        const id = String(ch.id ?? `${ch.coords.lat}:${ch.coords.lon}`);
                        if (seen.has(id))
                            continue;
                        seen.add(id);
                        picked.push(ch);
                        if (picked.length >= cap)
                            break;
                    }
                }
                return picked;
            };
            const capped = pickEvenlySpaced(progressSorted, candidateChargersCap);
            // Guardrail: if we computed any end-reachable chargers, ensure at least one
            // survives capping. Without this, the segment solver can never reach the end.
            if (endReachable.length) {
                const endReachableIds = new Set(endReachable.map((c) => String(c.id ?? `${c.coords.lat}:${c.coords.lon}`)));
                const cappedHasEndReachable = capped.some((c) => endReachableIds.has(String(c.id ?? `${c.coords.lat}:${c.coords.lon}`)));
                if (!cappedHasEndReachable) {
                    const bestEnd = [...endReachable].sort((a, b) => (0, geo_1.haversineMiles)(finalEnd.coords, a.coords) - (0, geo_1.haversineMiles)(finalEnd.coords, b.coords))[0];
                    if (bestEnd) {
                        // Replace the last element (arbitrary but stable) and rely on the fact
                        // we already force evaluation uniqueness earlier in the combined build.
                        capped[capped.length - 1] = bestEnd;
                    }
                }
            }
            // Avoid re-adding the segment start charger as a charger stop.
            const chargersForSegmentCapped = currentStart.id === "start" ? capped : capped.filter((c) => c.id !== currentStart.id);
            segmentAttempt.chargersForSegmentCappedCount = chargersForSegmentCapped.length;
            segmentAttempt.endReachableCount = endReachable.length;
            debug.segmentsAttempted.push(segmentAttempt);
            let segment;
            try {
                segment = await (0, leastTimeSegment_1.planLeastTimeSegment)({
                    requestId: input.requestId,
                    segmentStart: { id: currentStart.id, type: "start", coords: currentStart.coords },
                    segmentEnd: finalEnd,
                    chargers: chargersForSegmentCapped,
                    rangeMiles,
                    bufferSoc,
                    batteryKwh
                });
            }
            catch (e) {
                segmentAttempt.errorMessage = e instanceof Error ? e.message : String(e);
                if (e instanceof leastTimeSegment_1.NoFeasibleItineraryError) {
                    segmentAttempt.solverDebug = e.debug;
                }
                throw e;
            }
            // No overnight needed.
            if (segment.totalTimeMinutes <= overnightThresholdMinutes) {
                const stopsToAppend = overallStops.length === 0 ? segment.stops : segment.stops.slice(1);
                overallStops = overallStops.concat(stopsToAppend);
                overallLegs = overallLegs.concat(segment.legs);
                break;
            }
            // Overnight needed: pick an anchor charger where cumulative time crosses the threshold.
            const chargeCandidates = segment.stops
                .map((s, idx) => ({ s, idx }))
                .filter(({ s }) => s.type === "charge" && (s.etaMinutesFromStart ?? 0) >= overnightThresholdMinutes);
            const anchorCandidateLimit = Number(process.env.OVERNIGHT_ANCHOR_CANDIDATE_LIMIT ?? "3");
            const overnightAnchorsBefore = debug.overnightAnchors.length;
            let anchorIndex = chargeCandidates.length ? chargeCandidates[0].idx : -1;
            let selectedHotel = null;
            let selectedBestD = Infinity;
            // Prefer an overnight anchor charger that has a Holiday Inn Express within the
            // MVP convenience radius. This makes the "charger -> near hotel" behavior more reliable.
            for (const cand of chargeCandidates.slice(0, anchorCandidateLimit)) {
                const cacheKey = String(cand.s.id);
                let hotels = [];
                if (hotelCache.has(cacheKey)) {
                    hotels = hotelCache.get(cacheKey) ?? [];
                }
                else {
                    try {
                        hotels = await (0, overpassClient_1.findHolidayInnExpressNearby)(cand.s.coords, overnightHotelRadiusMeters);
                    }
                    catch {
                        hotels = [];
                    }
                    hotelCache.set(cacheKey, hotels);
                }
                debug.overnightAnchors.push({
                    chargerId: cand.s.id,
                    chargerName: cand.s.name,
                    hotelFound: hotels.length > 0,
                    chosen: false
                });
                if (!hotels.length)
                    continue;
                // Choose the closest hotel to this anchor charger.
                let best = hotels[0];
                let bestD = Infinity;
                for (const h of hotels) {
                    const d = Math.sqrt((h.coords.lat - cand.s.coords.lat) ** 2 +
                        (h.coords.lon - cand.s.coords.lon) ** 2);
                    if (d < bestD) {
                        bestD = d;
                        best = h;
                    }
                }
                if (!selectedHotel) {
                    selectedHotel = best;
                    anchorIndex = cand.idx;
                    selectedBestD = bestD;
                }
                else {
                    if (bestD < selectedBestD) {
                        selectedHotel = best;
                        anchorIndex = cand.idx;
                        selectedBestD = bestD;
                    }
                }
            }
            if (anchorIndex < 0) {
                const stopsToAppend = overallStops.length === 0 ? segment.stops : segment.stops.slice(1);
                overallStops = overallStops.concat(stopsToAppend);
                overallLegs = overallLegs.concat(segment.legs);
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
                const fallbackLimit = Number(process.env.OVERNIGHT_HOTEL_ANCHOR_CANDIDATE_LIMIT ?? "5");
                const endByProximity = [...chargersForSegmentCapped].sort((a, b) => (0, geo_1.haversineMiles)(a.coords, finalEnd.coords) -
                    (0, geo_1.haversineMiles)(b.coords, finalEnd.coords));
                for (const c of endByProximity.slice(0, fallbackLimit)) {
                    const cacheKey = String(c.id ?? `${c.coords.lat}:${c.coords.lon}`);
                    let hotels = [];
                    if (hotelCache.has(cacheKey)) {
                        hotels = hotelCache.get(cacheKey) ?? [];
                    }
                    else {
                        try {
                            hotels = await (0, overpassClient_1.findHolidayInnExpressNearby)(c.coords, overnightHotelRadiusMeters);
                        }
                        catch {
                            hotels = [];
                        }
                        hotelCache.set(cacheKey, hotels);
                    }
                    if (!hotels.length)
                        continue;
                    // Pick closest hotel to this charger.
                    let best = hotels[0];
                    let bestD = Infinity;
                    for (const h of hotels) {
                        const d = Math.sqrt((h.coords.lat - c.coords.lat) ** 2 +
                            (h.coords.lon - c.coords.lon) ** 2);
                        if (d < bestD) {
                            bestD = d;
                            best = h;
                        }
                    }
                    // Replan from currentStart to this fallback charger location.
                    let fallbackSegment = null;
                    try {
                        fallbackSegment = await (0, leastTimeSegment_1.planLeastTimeSegment)({
                            requestId: input.requestId,
                            segmentStart: { id: currentStart.id, type: "start", coords: currentStart.coords },
                            segmentEnd: { id: String(c.id), type: "end", coords: c.coords },
                            chargers: chargersForSegmentCapped,
                            rangeMiles,
                            bufferSoc,
                            batteryKwh
                        });
                    }
                    catch {
                        fallbackSegment = null;
                    }
                    if (fallbackSegment?.stops?.length) {
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
            overnightStopsCount++;
            if (overallStops.length === 0) {
                overallStops = truncatedStops;
                overallLegs = truncatedLegs;
            }
            else {
                overallStops = overallStops.concat(truncatedStops.slice(1));
                overallLegs = overallLegs.concat(truncatedLegs);
            }
            // Sleep block: find Holiday Inn Express within HOTEL_RADIUS_METERS of anchor charger.
            let sleepStop = null;
            const anchorEta = anchorStop.etaMinutesFromStart ?? 0;
            if (resolvedSelectedHotel) {
                sleepStop = {
                    id: `sleep-${anchorStop.id}`,
                    name: resolvedSelectedHotel.name,
                    coords: resolvedSelectedHotel.coords,
                    etaMinutesFromStart: anchorEta
                };
            }
            else {
                // No hotel found during anchor evaluation; fall back to one last check on the chosen anchor.
                try {
                    const cacheKey = String(anchorStop.id);
                    let hotels = [];
                    if (hotelCache.has(cacheKey)) {
                        hotels = hotelCache.get(cacheKey) ?? [];
                    }
                    else {
                        hotels = await (0, overpassClient_1.findHolidayInnExpressNearby)(anchorStop.coords, overnightHotelRadiusMeters);
                        hotelCache.set(cacheKey, hotels);
                    }
                    if (hotels.length) {
                        let best = hotels[0];
                        let bestD = Infinity;
                        for (const h of hotels) {
                            const d = Math.sqrt((h.coords.lat - anchorStop.coords.lat) ** 2 +
                                (h.coords.lon - anchorStop.coords.lon) ** 2);
                            if (d < bestD) {
                                bestD = d;
                                best = h;
                            }
                        }
                        sleepStop = {
                            id: `sleep-${anchorStop.id}`,
                            name: best.name,
                            coords: best.coords,
                            etaMinutesFromStart: anchorEta
                        };
                    }
                }
                catch {
                    // Overpass failure degrades to charging-only (no hotel stop).
                }
            }
            // Soft preference: if we found a Holiday Inn Express `sleep` stop,
            // also try to find a nearby EV charger so the same stop can
            // represent "charging + sleeping together".
            //
            // This is intentionally non-fatal: missing chargers should not
            // break the overnight/hotel insertion invariants.
            let sleepChargerMeta = undefined;
            if (sleepStop) {
                const chargerRadiusMiles = hotelRadiusMeters / 1609.34;
                const cacheKey = `${sleepStop.coords.lat.toFixed(4)}:${sleepStop.coords.lon.toFixed(4)}`;
                try {
                    let chargersAtHotel = hotelChargerCache.get(cacheKey);
                    if (!chargersAtHotel) {
                        chargersAtHotel = includeAllElectricChargers
                            ? await (0, nrelClient_1.fetchElectricChargersNearPoint)(sleepStop.coords, chargerRadiusMiles)
                            : await (0, nrelClient_1.fetchDcFastChargersNearPoint)(sleepStop.coords, chargerRadiusMiles);
                        hotelChargerCache.set(cacheKey, chargersAtHotel);
                    }
                    if (chargersAtHotel.length) {
                        // Choose the closest charger to the hotel coords.
                        let best = chargersAtHotel[0];
                        let bestD = Infinity;
                        for (const c of chargersAtHotel) {
                            const d = (0, geo_1.haversineMiles)(sleepStop.coords, c.coords);
                            if (d < bestD) {
                                bestD = d;
                                best = c;
                            }
                        }
                        sleepChargerMeta = {
                            chargerFound: true,
                            chargerId: String(best.id),
                            chargerName: best.name,
                            chargerMaxPowerKw: best.maxPowerKw,
                            chargerLat: best.coords.lat,
                            chargerLon: best.coords.lon
                        };
                    }
                    else {
                        sleepChargerMeta = { chargerFound: false };
                    }
                }
                catch {
                    // Overpass/NREL failures degrade to sleep-without-charger.
                    sleepChargerMeta = { chargerFound: false };
                }
            }
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
                currentStart = { id: sleepStop.id, coords: sleepStop.coords };
                lastHotelMessage = undefined;
            }
            else {
                const anchors = debug.overnightAnchors;
                const noHotelAnchors = anchors
                    .slice(overnightAnchorsBefore)
                    .filter((a) => !a.hotelFound);
                lastHotelMessage =
                    noHotelAnchors.length > 1
                        ? `Hotel not found within ${overnightHotelRadiusYards} yards for ${noHotelAnchors.length} overnight stop(s) (e.g. near "${anchorStop.name}"). Showing charging plan only.`
                        : `Hotel not found within ${overnightHotelRadiusYards} yards of charger "${anchorStop.name}". Showing charging plan only for this overnight.`;
                currentStart = { id: anchorStop.id, coords: anchorStop.coords };
            }
        }
        // If we hit the cap, append the final remainder segment from the current start.
        if (!overallStops.some((s) => s.type === "end")) {
            const chargersForRemainder = currentStart.id === "start"
                ? chargerCandidates
                : chargerCandidates.filter((c) => c.id !== currentStart.id);
            const remainder = await (0, leastTimeSegment_1.planLeastTimeSegment)({
                requestId: input.requestId,
                segmentStart: { id: currentStart.id, type: "start", coords: currentStart.coords },
                segmentEnd: finalEnd,
                chargers: chargersForRemainder,
                rangeMiles,
                bufferSoc,
                batteryKwh
            });
            const stopsToAppend = overallStops.length === 0 ? remainder.stops : remainder.stops.slice(1);
            overallStops = overallStops.concat(stopsToAppend);
            overallLegs = overallLegs.concat(remainder.legs);
        }
        const travelTimeMinutes = overallLegs.reduce((sum, l) => sum + (l.travelTimeMinutes ?? 0), 0);
        const chargeTimeMinutes = overallLegs.reduce((sum, l) => sum + (l.chargeTimeMinutes ?? 0), 0);
        const totalTimeMinutes = travelTimeMinutes + chargeTimeMinutes + sleepTimeMinutesTotal;
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
            debug
        };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : "Planner failed";
        return {
            requestId: input.requestId,
            responseVersion: input.responseVersion,
            status: "error",
            message: msg,
            debug,
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
