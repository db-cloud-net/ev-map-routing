import { recordProviderCall } from "./providerCallMetrics";
import type {
  PoiServicesCorridorRequest,
  PoiServicesCorridorResponse
} from "./poiServicesTypes";

function trimBaseUrl(): string {
  return (process.env.POI_SERVICES_BASE_URL ?? "").trim().replace(/\/$/, "");
}

export function isPoiServicesCorridorEnabled(): boolean {
  const base = trimBaseUrl();
  if (!base) return false;
  const off = (process.env.USE_POI_SERVICES_CORRIDOR ?? "true").toLowerCase() === "false";
  return !off;
}

export function isPoiServicesEdgesEnabled(): boolean {
  if (!isPoiServicesCorridorEnabled()) return false;
  return (process.env.POI_SERVICES_USE_EDGES ?? "true").toLowerCase() !== "false";
}

/** Request `pairs` layer on corridor queries (hotel↔DCFC). Default on when POI corridor is enabled. */
export function isPoiServicesPairsEnabled(): boolean {
  if (!isPoiServicesCorridorEnabled()) return false;
  return (process.env.POI_SERVICES_USE_PAIRS ?? "true").toLowerCase() !== "false";
}

/**
 * POST /corridor/query — layered corridor POI + optional edges (POI Services v2).
 */
export async function postCorridorQuery(
  body: PoiServicesCorridorRequest,
  opts?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<PoiServicesCorridorResponse> {
  const base = trimBaseUrl();
  if (!base) {
    throw new Error("POI_SERVICES_BASE_URL is not set");
  }

  const timeoutMs =
    opts?.timeoutMs ?? Number(process.env.POI_SERVICES_TIMEOUT_MS ?? "30000");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const parent = opts?.signal;
  const onParentAbort = () => ctrl.abort();
  if (parent) {
    if (parent.aborted) ctrl.abort();
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }

  const t0 = performance.now();
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json"
    };
    const key = (process.env.POI_SERVICES_API_KEY ?? "").trim();
    if (key) {
      headers.Authorization = `Bearer ${key}`;
    }

    const res = await fetch(`${base}/corridor/query`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal
    });

    const ms = performance.now() - t0;
    recordProviderCall("poi_services", ms);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`POI Services HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    return (await res.json()) as PoiServicesCorridorResponse;
  } finally {
    clearTimeout(t);
    if (parent) {
      parent.removeEventListener("abort", onParentAbort);
    }
  }
}
