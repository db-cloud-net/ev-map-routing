"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.haversineMiles = haversineMiles;
exports.clamp = clamp;
function haversineMiles(a, b) {
    const R = 3958.8;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const lat1 = (a.lat * Math.PI) / 180;
    const lat2 = (b.lat * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}
function clamp(x, min, max) {
    return Math.min(max, Math.max(min, x));
}
