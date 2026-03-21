import type { LatLng } from "../types";
import { timeProviderCall } from "./providerCallMetrics";

export type Hotel = {
  id: string;
  name: string;
  coords: LatLng;
  /** OSM element type when known (`node` | `way` | `relation`). */
  osmType?: string;
};

export class OverpassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverpassError";
  }
}

function sleepMs(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }

    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(t);
      cleanup();
      reject(signal?.reason ?? new Error("Aborted"));
    };

    const cleanup = () => {
      if (!signal) return;
      signal.removeEventListener("abort", onAbort);
    };

    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function computeRetryDelayMs(attempt: number) {
  const base = Number(process.env.OVERPASS_RETRY_BASE_DELAY_MS ?? "750");
  const maxJitter = Number(process.env.OVERPASS_RETRY_JITTER_MS ?? "250");
  const exp = base * 2 ** attempt;
  const jitter = Math.random() * maxJitter;
  return Math.floor(exp + jitter);
}

function overpassQueryTimeoutSeconds() {
  return Number(process.env.OVERPASS_QUERY_TIMEOUT_SECONDS ?? "30");
}

function haversineMiles(a: LatLng, b: LatLng) {
  const R = 3958.8;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export async function findHolidayInnExpressNearby(
  point: LatLng,
  radiusMeters: number,
  opts?: { signal?: AbortSignal }
): Promise<Hotel[]> {
  const signal = opts?.signal;
  const overpassUrl =
    process.env.OVERPASS_BASE_URL ?? "https://overpass-api.de/api/interpreter";

  // Overpass: match Holiday Inn Express by name or brand (OSM tagging varies).
  const pattern = "Holiday Inn Express";

  const maxAttempts = Number(process.env.OVERPASS_MAX_ATTEMPTS ?? "3");
  const interRequestDelayMs = Number(
    process.env.OVERPASS_INTER_REQUEST_DELAY_MS ?? "200"
  );

  const q = `
[out:json][timeout:${overpassQueryTimeoutSeconds()}];
(
  node["name"~"${pattern}",i]["tourism"="hotel"](around:${radiusMeters},${point.lat},${point.lon});
  way["name"~"${pattern}",i]["tourism"="hotel"](around:${radiusMeters},${point.lat},${point.lon});
  relation["name"~"${pattern}",i]["tourism"="hotel"](around:${radiusMeters},${point.lat},${point.lon});
  node["brand"~"${pattern}",i]["tourism"="hotel"](around:${radiusMeters},${point.lat},${point.lon});
  way["brand"~"${pattern}",i]["tourism"="hotel"](around:${radiusMeters},${point.lat},${point.lon});
  relation["brand"~"${pattern}",i]["tourism"="hotel"](around:${radiusMeters},${point.lat},${point.lon});
);
out center tags;`;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleepMs(computeRetryDelayMs(attempt - 1), signal);
    await sleepMs(interRequestDelayMs, signal);

    try {
      const json = await timeProviderCall("overpass", async () => {
        const resp = await fetch(overpassUrl, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: q,
          signal
        });

        if (!resp.ok) {
          throw new OverpassError(`Overpass request failed (${resp.status})`);
        }

        return (await resp.json()) as any;
      });
      const elements: any[] = Array.isArray(json?.elements) ? json.elements : [];

      const hotels: Hotel[] = [];
      for (const el of elements) {
        const lat =
          el?.lat != null
            ? Number(el.lat)
            : el?.center?.lat != null
              ? Number(el.center.lat)
              : null;
        const lon =
          el?.lon != null
            ? Number(el.lon)
            : el?.center?.lon != null
              ? Number(el.center.lon)
              : null;

        if (lat == null || lon == null) continue;
        const name = String(
          el?.tags?.name ?? el?.tags?.brand ?? "Holiday Inn Express"
        );
        const id = String(el?.id ?? `${lat},${lon}`);
        const osmType = String(el?.type ?? "unknown");

        const coords: LatLng = { lat, lon };
        const miles = haversineMiles(point, coords);
        // Defensive filter: keep only within radius to enforce MVP rule C.
        if (miles * 1609.34 <= radiusMeters) {
          hotels.push({ id, name, coords, osmType });
        }
      }

      // Dedupe by coords/name.
      const seen = new Set<string>();
      const out: Hotel[] = [];
      for (const h of hotels) {
        const key = `${h.coords.lat.toFixed(4)}:${h.coords.lon.toFixed(4)}:${h.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(h);
      }
      return out;
    } catch (e) {
      lastErr = e;
    }
  }

  const msg =
    lastErr instanceof Error ? lastErr.message : "Overpass request failed";
  throw new OverpassError(msg);
}

