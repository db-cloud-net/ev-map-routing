export type ChargingTimeInput = {
  arrivalSoc: number; // 0..1
  departureSoc: number; // 0..1
  maxPowerKw: number; // if unknown, use default
  batteryKwh: number;
};

export function estimateChargeTimeMinutes({
  arrivalSoc,
  departureSoc,
  maxPowerKw,
  batteryKwh
}: ChargingTimeInput): number {
  const beta = Number(process.env.CHARGE_TAPER_BETA ?? "0.5"); // linear-ish taper factor
  const minEffectivePowerFraction = Number(
    process.env.CHARGE_MIN_POWER_FRACTION ?? "0.2"
  );

  const a = clamp01(arrivalSoc);
  const d = clamp01(departureSoc);
  if (d <= a) return 0;
  const energyKwh = batteryKwh * (d - a);

  // Approximate ramp-down by averaging SOC during charging.
  const avgSoc = (a + d) / 2;
  const effectivePower = maxPowerKw * clamp(1 - beta * avgSoc, minEffectivePowerFraction, 1);

  const hours = energyKwh / effectivePower;
  return hours * 60;
}

function clamp01(x: number) {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

function clamp(x: number, min: number, max: number) {
  return Math.min(max, Math.max(min, x));
}

