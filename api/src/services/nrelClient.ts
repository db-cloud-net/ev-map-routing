import type { LatLng } from "../types";

export type Charger = {
  id: string;
  name: string;
  coords: LatLng;
  maxPowerKw?: number;
};

export class NrelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NrelError";
  }
}

function sleepMs(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function computeRetryDelayMs(attempt: number) {
  // Exponential backoff with jitter for rate limiting (429).
  const base = Number(process.env.NREL_RETRY_BASE_DELAY_MS ?? "750");
  const maxJitter = Number(process.env.NREL_RETRY_JITTER_MS ?? "250");
  const exp = base * 2 ** attempt;
  const jitter = Math.random() * maxJitter;
  return Math.floor(exp + jitter);
}

function parseRetryAfterMs(retryAfter: string | null): number | null {
  if (!retryAfter) return null;
  const trimmed = retryAfter.trim();
  if (!trimmed) return null;

  // Prefer delta-seconds form: "120"
  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.floor(asSeconds * 1000);
  }

  // Also accept HTTP date form: "Wed, 21 Oct 2015 07:28:00 GMT"
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    const ms = asDate - Date.now();
    return ms > 0 ? ms : null;
  }

  return null;
}

function parseMaxPowerKwFromStation(station: any): number | undefined {
  const candidates: number[] = [];

  const pushIf = (v: unknown) => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (Number.isFinite(n) && n > 0) candidates.push(n);
  };

  // Common likely fields (defensive).
  pushIf(station?.max_charge_rate_kw);
  pushIf(station?.max_charge_rate);
  pushIf(station?.ev_dc_fast_power);

  // Accessories list: often contains the charging rate / power.
  const accessories = station?.ev_dc_fast_accessories ?? station?.ev_dc_fast_accessories;
  if (Array.isArray(accessories)) {
    for (const a of accessories) {
      if (!a || typeof a !== "object") continue;
      pushIf((a as any)?.max_charge_rate_kw);
      pushIf((a as any)?.max_charge_rate);
      pushIf((a as any)?.max_charge_rate_kW);
      pushIf((a as any)?.power);
      pushIf((a as any)?.max_power);
    }
  }

  if (!candidates.length) return undefined;
  return Math.max(...candidates);
}

function dedupeByLatLon(chargers: Charger[], precision = 4) {
  const seen = new Set<string>();
  const out: Charger[] = [];
  for (const c of chargers) {
    const key = `${c.coords.lat.toFixed(precision)}:${c.coords.lon.toFixed(precision)}:${c.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export async function fetchDcFastChargersNearPoint(
  point: LatLng,
  radiusMiles: number
): Promise<Charger[]> {
  const apiKey = process.env.NREL_API_KEY;
  if (!apiKey) {
    throw new NrelError("Missing NREL_API_KEY env var");
  }

  const baseUrl =
    process.env.NREL_BASE_URL ??
    "https://developer.nrel.gov/api/alt-fuel-stations/v1/nearest.json";

  // MVP: we keep query conservative and parse charge-rate from whatever NREL returns.
  const params = new URLSearchParams({
    api_key: apiKey,
    latitude: String(point.lat),
    longitude: String(point.lon),
    radius: String(radiusMiles),
    fuel_type: "ELEC",
    // NREL docs specify lowercase `dc_fast`
    ev_station_type: "dc_fast",
    status: "E",
    limit: "200"
  });

  const url = `${baseUrl}?${params.toString()}`;

  const maxAttempts = Number(process.env.NREL_MAX_ATTEMPTS ?? "4");
  const interRequestDelayMs = Number(process.env.NREL_INTER_REQUEST_DELAY_MS ?? "100");
  let lastStatus: number | null = null;
  let forcedDelayMs: number | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    if (attempt > 0) {
      const delay = forcedDelayMs ?? computeRetryDelayMs(attempt);
      forcedDelayMs = null;
      await sleepMs(delay);
    }

    // eslint-disable-next-line no-await-in-loop
    await sleepMs(interRequestDelayMs);

    const resp = await fetch(url);
    lastStatus = resp.status;

    if (resp.status === 429 && attempt < maxAttempts - 1) {
      forcedDelayMs = parseRetryAfterMs(resp.headers.get("Retry-After"));
      // eslint-disable-next-line no-await-in-loop
      continue;
    }

    if (!resp.ok) {
      throw new NrelError(`NREL charger fetch failed (${resp.status})`);
    }

    const json = (await resp.json()) as any;
    const stations: any[] = Array.isArray(json?.fuel_stations)
      ? json.fuel_stations
      : Array.isArray(json?.stations)
        ? json.stations
        : [];

    const chargers: Charger[] = [];
    for (const s of stations) {
      const lat = Number(s?.latitude ?? s?.latitude_float ?? s?.location_lat);
      const lon = Number(s?.longitude ?? s?.longitude_float ?? s?.location_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const maxPowerKw = parseMaxPowerKwFromStation(s);
      const id = String(s?.id ?? s?.station_id ?? `${lat},${lon}`);
      const name = String(s?.station_name ?? s?.network?.name ?? "EV Charger");

      chargers.push({
        id,
        name,
        coords: { lat, lon },
        maxPowerKw
      });
    }

    // If NREL returned no stations, propagate an empty list (planner decides next UX).
    return dedupeByLatLon(chargers);
  }

  throw new NrelError(
    `NREL charger fetch failed after ${maxAttempts} attempts${lastStatus ? ` (last status ${lastStatus})` : ""}`
  );
}

export async function fetchElectricChargersNearPoint(
  point: LatLng,
  radiusMiles: number
): Promise<Charger[]> {
  const apiKey = process.env.NREL_API_KEY;
  if (!apiKey) {
    throw new NrelError("Missing NREL_API_KEY env var");
  }

  // Include all electric charging stations (dc_fast + level 1/2).
  // We still keep the corridor querying bounded via `radiusMiles` and our
  // candidate caps elsewhere in the planner.
  const baseUrl =
    process.env.NREL_BASE_URL ??
    "https://developer.nrel.gov/api/alt-fuel-stations/v1/nearest.json";

  const params = new URLSearchParams({
    api_key: apiKey,
    latitude: String(point.lat),
    longitude: String(point.lon),
    radius: String(radiusMiles),
    fuel_type: "ELEC",
    status: "E",
    limit: "200"
  });

  const url = `${baseUrl}?${params.toString()}`;

  const maxAttempts = Number(process.env.NREL_MAX_ATTEMPTS ?? "4");
  const interRequestDelayMs = Number(process.env.NREL_INTER_REQUEST_DELAY_MS ?? "100");
  let lastStatus: number | null = null;
  let forcedDelayMs: number | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    if (attempt > 0) {
      const delay = forcedDelayMs ?? computeRetryDelayMs(attempt);
      forcedDelayMs = null;
      // eslint-disable-next-line no-await-in-loop
      await sleepMs(delay);
    }

    // eslint-disable-next-line no-await-in-loop
    await sleepMs(interRequestDelayMs);

    const resp = await fetch(url);
    lastStatus = resp.status;

    if (resp.status === 429 && attempt < maxAttempts - 1) {
      forcedDelayMs = parseRetryAfterMs(resp.headers.get("Retry-After"));
      // eslint-disable-next-line no-await-in-loop
      continue;
    }

    if (!resp.ok) {
      throw new NrelError(`NREL charger fetch failed (${resp.status})`);
    }

    const json = (await resp.json()) as any;
    const stations: any[] = Array.isArray(json?.fuel_stations)
      ? json.fuel_stations
      : [];

    const chargers: Charger[] = [];
    for (const s of stations) {
      const lat = Number(s?.latitude ?? s?.latitude_float ?? s?.location_lat);
      const lon = Number(s?.longitude ?? s?.longitude_float ?? s?.location_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const maxPowerKw = parseMaxPowerKwFromStation(s);
      const id = String(s?.id ?? s?.station_id ?? `${lat},${lon}`);
      const name = String(s?.station_name ?? s?.network?.name ?? "EV Charger");

      chargers.push({
        id,
        name,
        coords: { lat, lon },
        maxPowerKw
      });
    }

    return dedupeByLatLon(chargers);
  }

  throw new NrelError(
    `NREL charger fetch failed after ${maxAttempts} attempts${
      lastStatus ? ` (last status ${lastStatus})` : ""
    }`
  );
}

function toWktLineString(routePoints: LatLng[]) {
  // WKT LINESTRING expects coordinates as `X Y` => `lon lat`.
  const coords = routePoints.map((p) => `${p.lon} ${p.lat}`).join(",");
  return `LINESTRING(${coords})`;
}

export async function fetchDcFastChargersNearRoute(
  routePoints: LatLng[],
  distanceMiles: number
): Promise<Charger[]> {
  const apiKey = process.env.NREL_API_KEY;
  if (!apiKey) {
    throw new NrelError("Missing NREL_API_KEY env var");
  }

  if (routePoints.length < 2) return [];

  const baseUrl =
    process.env.NREL_BASE_URL ??
    "https://developer.nrel.gov/api/alt-fuel-stations/v1/nearby-route.json";

  const routeWkt = toWktLineString(routePoints);

  const params = new URLSearchParams({
    api_key: apiKey,
    route: routeWkt,
    distance: String(distanceMiles),
    fuel_type: "ELEC",
    // NREL nearby-route docs use `ev_charging_level` for dc_fast.
    ev_charging_level: "dc_fast",
    status: "E",
    limit: "200"
  });

  const maxGetUrlLength = Number(
    process.env.NREL_NEARBY_ROUTE_MAX_GET_URL_LENGTH ?? "1800"
  );

  const maxAttempts = Number(process.env.NREL_MAX_ATTEMPTS ?? "4");
  const interRequestDelayMs = Number(process.env.NREL_INTER_REQUEST_DELAY_MS ?? "100");
  let lastStatus: number | null = null;
  let forcedDelayMs: number | null = null;

  const fullGetUrl = `${baseUrl}?${params.toString()}`;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    if (attempt > 0) {
      const delay = forcedDelayMs ?? computeRetryDelayMs(attempt);
      forcedDelayMs = null;
      // eslint-disable-next-line no-await-in-loop
      await sleepMs(delay);
    }

    // eslint-disable-next-line no-await-in-loop
    await sleepMs(interRequestDelayMs);

    // Prefer GET first: it works reliably for small route strings.
    // Fall back to POST when URL length would be excessive.
    const resp =
      fullGetUrl.length <= maxGetUrlLength
        ? await fetch(fullGetUrl)
        : await fetch(baseUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params
          });
    lastStatus = resp.status;

    if (resp.status === 429 && attempt < maxAttempts - 1) {
      forcedDelayMs = parseRetryAfterMs(resp.headers.get("Retry-After"));
      // eslint-disable-next-line no-await-in-loop
      continue;
    }

    if (!resp.ok) {
      throw new NrelError(`NREL charger fetch failed (${resp.status})`);
    }

    const json = (await resp.json()) as any;
    const stations: any[] = Array.isArray(json?.fuel_stations)
      ? json.fuel_stations
      : Array.isArray(json?.stations)
        ? json.stations
        : [];

    const chargers: Charger[] = [];
    for (const s of stations) {
      const lat = Number(s?.latitude ?? s?.latitude_float ?? s?.location_lat);
      const lon = Number(s?.longitude ?? s?.longitude_float ?? s?.location_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const maxPowerKw = parseMaxPowerKwFromStation(s);
      const id = String(s?.id ?? s?.station_id ?? `${lat},${lon}`);
      const name = String(s?.station_name ?? s?.network?.name ?? "EV Charger");

      chargers.push({
        id,
        name,
        coords: { lat, lon },
        maxPowerKw
      });
    }

    return dedupeByLatLon(chargers);
  }

  throw new NrelError(
    `NREL charger fetch failed after ${maxAttempts} attempts${
      lastStatus ? ` (last status ${lastStatus})` : ""
    }`
  );
}

