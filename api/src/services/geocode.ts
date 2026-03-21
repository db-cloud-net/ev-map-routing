import type { LatLng } from "../types";

export class GeocodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeocodeError";
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function geocodeTextToLatLng(query: string): Promise<LatLng> {
  const baseUrl =
    process.env.NOMINATIM_BASE_URL ?? "https://nominatim.openstreetmap.org/search";
  const attempts = 2;
  const userAgent = process.env.NOMINATIM_USER_AGENT ?? "ev-map-routing-mvp/0.1";
  const timeoutMs = Number(process.env.PLAN_GEOCODE_TIMEOUT_MS ?? "30000");
  const signal =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? AbortSignal.timeout(Math.floor(timeoutMs))
      : undefined;

  for (let i = 0; i < attempts; i++) {
    const url = new URL(baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");

    let resp: Response;
    try {
      resp = await fetch(url.toString(), {
        headers: { "User-Agent": userAgent },
        signal
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const name = e instanceof Error ? e.name : "";
      if (
        name === "AbortError" ||
        msg.toLowerCase().includes("abort") ||
        msg.toLowerCase().includes("timed out")
      ) {
        throw new GeocodeError(
          `Geocoding timed out (PLAN_GEOCODE_TIMEOUT_MS=${timeoutMs}ms)`
        );
      }
      throw e;
    }

    if (!resp.ok) {
      if (i === attempts - 1) throw new GeocodeError(`Geocoding failed (${resp.status})`);
      await sleep(250 * (i + 1));
      continue;
    }

    const json = (await resp.json()) as Array<any>;
    const first = json?.[0];
    if (!first?.lat || !first?.lon) throw new GeocodeError(`No geocode match for "${query}"`);

    return { lat: Number(first.lat), lon: Number(first.lon) };
  }

  throw new GeocodeError(`No geocode match for "${query}"`);
}

