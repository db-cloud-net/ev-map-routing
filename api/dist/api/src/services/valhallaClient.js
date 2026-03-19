"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValhallaError = void 0;
exports.getRoutePolyline = getRoutePolyline;
exports.getTravelTimeMinutes = getTravelTimeMinutes;
exports.getTravelDistanceMiles = getTravelDistanceMiles;
exports.getRouteLegGeometryAndManeuvers = getRouteLegGeometryAndManeuvers;
class ValhallaError extends Error {
    constructor(message) {
        super(message);
        this.name = "ValhallaError";
    }
}
exports.ValhallaError = ValhallaError;
function extractLineStringFromValhalla(json) {
    const leg = json?.trip?.legs?.[0];
    const shape = leg?.shape;
    if (shape?.type === "LineString" && Array.isArray(shape.coordinates)) {
        return { type: "LineString", coordinates: shape.coordinates };
    }
    // Some configurations return coordinates directly as an array.
    if (Array.isArray(leg?.shape) && leg.shape.length > 1) {
        const coords = leg.shape;
        if (coords.every((p) => Array.isArray(p) && p.length >= 2)) {
            return {
                type: "LineString",
                coordinates: coords.map((p) => [p[0], p[1]])
            };
        }
    }
    return undefined;
}
async function getRoutePolyline(from, to) {
    const baseUrl = process.env.VALHALLA_BASE_URL ?? "http://valhalla:8002";
    const url = `${baseUrl}/route`;
    let resp;
    try {
        resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                locations: [
                    { lat: from.lat, lon: from.lon },
                    { lat: to.lat, lon: to.lon }
                ],
                costing: "auto",
                directions: false,
                units: "miles",
                shape_format: "geojson"
            })
        });
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new ValhallaError(`Valhalla fetch failed at ${url}: ${msg}`);
    }
    if (!resp.ok) {
        throw new ValhallaError(`Valhalla route failed (${resp.status})`);
    }
    const json = await resp.json();
    const geometry = extractLineStringFromValhalla(json);
    if (!geometry)
        throw new ValhallaError("Valhalla response missing route geometry");
    return geometry;
}
function getTimeSecondsFromResponse(json) {
    const t = json?.trip?.summary?.time ??
        json?.trip?.summary?.time_seconds ??
        json?.trip?.time;
    return typeof t === "number" ? t : typeof t === "string" ? Number(t) : null;
}
function getDistanceMilesFromResponse(json) {
    const d = json?.trip?.summary?.length ??
        json?.trip?.summary?.distance ??
        json?.trip?.distance;
    return typeof d === "number" ? d : typeof d === "string" ? Number(d) : null;
}
async function getTravelTimeMinutes(from, to) {
    const baseUrl = process.env.VALHALLA_BASE_URL ?? "http://valhalla:8002";
    const url = `${baseUrl}/route`;
    let resp;
    try {
        resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                locations: [
                    { lat: from.lat, lon: from.lon },
                    { lat: to.lat, lon: to.lon }
                ],
                costing: "auto",
                directions: false,
                units: "miles",
                // Request geojson if supported; planner can fall back to time-only.
                shape_format: "geojson"
            })
        });
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new ValhallaError(`Valhalla fetch failed at ${url}: ${msg}`);
    }
    if (!resp.ok) {
        throw new ValhallaError(`Valhalla route failed (${resp.status})`);
    }
    const json = await resp.json();
    const seconds = getTimeSecondsFromResponse(json);
    if (seconds == null || !Number.isFinite(seconds)) {
        throw new ValhallaError("Valhalla response missing travel time");
    }
    return seconds / 60;
}
async function getTravelDistanceMiles(from, to) {
    const baseUrl = process.env.VALHALLA_BASE_URL ?? "http://valhalla:8002";
    const url = `${baseUrl}/route`;
    let resp;
    try {
        resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                locations: [
                    { lat: from.lat, lon: from.lon },
                    { lat: to.lat, lon: to.lon }
                ],
                costing: "auto",
                directions: false,
                units: "miles",
                shape_format: "geojson"
            })
        });
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new ValhallaError(`Valhalla fetch failed at ${url}: ${msg}`);
    }
    if (!resp.ok) {
        throw new ValhallaError(`Valhalla route failed (${resp.status})`);
    }
    const json = await resp.json();
    const miles = getDistanceMilesFromResponse(json);
    if (miles == null || !Number.isFinite(miles)) {
        throw new ValhallaError("Valhalla response missing travel distance");
    }
    return miles;
}
async function getRouteLegGeometryAndManeuvers(from, to) {
    const baseUrl = process.env.VALHALLA_BASE_URL ?? "http://valhalla:8002";
    const url = `${baseUrl}/route`;
    let resp;
    try {
        resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                locations: [
                    { lat: from.lat, lon: from.lon },
                    { lat: to.lat, lon: to.lon }
                ],
                costing: "auto",
                directions: true,
                directions_type: "maneuver",
                units: "miles",
                shape_format: "geojson"
            })
        });
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new ValhallaError(`Valhalla fetch failed at ${url}: ${msg}`);
    }
    if (!resp.ok) {
        throw new ValhallaError(`Valhalla directions failed (${resp.status})`);
    }
    const json = await resp.json();
    const leg = json?.trip?.legs?.[0];
    if (!leg)
        return {};
    // geometry
    const shape = leg?.shape;
    let geometry;
    if (shape?.type === "LineString" && Array.isArray(shape.coordinates)) {
        geometry = { type: "LineString", coordinates: shape.coordinates };
    }
    else if (Array.isArray(leg?.shape) && leg.shape.length > 1) {
        // Some Valhalla configurations return coordinates directly.
        const coords = leg.shape;
        if (coords.every((p) => Array.isArray(p) && p.length >= 2)) {
            geometry = {
                type: "LineString",
                coordinates: coords.map((p) => [p[0], p[1]])
            };
        }
    }
    // maneuvers
    const maneuvers = leg?.maneuvers ?? leg?.maneuver ?? [];
    const parsedManeuvers = [];
    if (Array.isArray(maneuvers)) {
        for (const m of maneuvers) {
            const text = m?.instruction ?? m?.text ?? m?.name ?? m?.modifier ?? m?.sign ?? null;
            if (typeof text === "string" && text.trim()) {
                parsedManeuvers.push({
                    text: text.trim(),
                    instructionType: m?.instruction_type ?? m?.type,
                    distanceMeters: typeof m?.length === "number" ? m.length : undefined,
                    timeSeconds: typeof m?.time === "number" ? m.time : undefined
                });
            }
        }
    }
    return { geometry, maneuvers: parsedManeuvers.length ? parsedManeuvers : undefined };
}
