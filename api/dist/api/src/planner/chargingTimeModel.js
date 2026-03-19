"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.estimateChargeTimeMinutes = estimateChargeTimeMinutes;
function estimateChargeTimeMinutes({ arrivalSoc, departureSoc, maxPowerKw, batteryKwh }) {
    const beta = Number(process.env.CHARGE_TAPER_BETA ?? "0.5"); // linear-ish taper factor
    const minEffectivePowerFraction = Number(process.env.CHARGE_MIN_POWER_FRACTION ?? "0.2");
    const a = clamp01(arrivalSoc);
    const d = clamp01(departureSoc);
    if (d <= a)
        return 0;
    const energyKwh = batteryKwh * (d - a);
    // Approximate ramp-down by averaging SOC during charging.
    const avgSoc = (a + d) / 2;
    const effectivePower = maxPowerKw * clamp(1 - beta * avgSoc, minEffectivePowerFraction, 1);
    const hours = energyKwh / effectivePower;
    return hours * 60;
}
function clamp01(x) {
    if (!Number.isFinite(x))
        return 0;
    return Math.min(1, Math.max(0, x));
}
function clamp(x, min, max) {
    return Math.min(max, Math.max(min, x));
}
