import { AsyncLocalStorage } from "node:async_hooks";

export type ProviderKind = "valhalla" | "geocode" | "poi_services";

/** Per-provider HTTP timing for one `/plan` request (mutated during planning). */
export class ProviderCallMetrics {
  valhallaMs: number[] = [];
  geocodeMs: number[] = [];
  poiServicesMs: number[] = [];

  record(kind: ProviderKind, ms: number) {
    if (!Number.isFinite(ms) || ms < 0) return;
    const rounded = Math.round(ms * 100) / 100;
    switch (kind) {
      case "valhalla":
        this.valhallaMs.push(rounded);
        break;
      case "geocode":
        this.geocodeMs.push(rounded);
        break;
      case "poi_services":
        this.poiServicesMs.push(rounded);
        break;
      default:
        break;
    }
  }

  /**
   * Shape for `PlanTripResponse.debug` (map page “Debug (MVP)”).
   * Large `durationsMs` arrays are truncated with a tail marker.
   */
  toDebugPayload(): Record<string, unknown> {
    return {
      providerCalls: {
        valhalla: summarizeDurations(this.valhallaMs),
        geocode: summarizeDurations(this.geocodeMs),
        poi_services: summarizeDurations(this.poiServicesMs)
      }
    };
  }
}

const MAX_DURATIONS_LIST = 200;

function summarizeDurations(durations: number[]) {
  const n = durations.length;
  const totalMs = durations.reduce((a, b) => a + b, 0);
  return {
    calls: n,
    totalMs: Math.round(totalMs * 100) / 100,
    avgMs: n ? Math.round((totalMs / n) * 100) / 100 : 0,
    durationsMs:
      n <= MAX_DURATIONS_LIST
        ? durations
        : [...durations.slice(0, MAX_DURATIONS_LIST), `… +${n - MAX_DURATIONS_LIST} more`]
  };
}

const als = new AsyncLocalStorage<ProviderCallMetrics>();

export function getProviderCallMetrics(): ProviderCallMetrics | undefined {
  return als.getStore();
}

export function recordProviderCall(kind: ProviderKind, ms: number) {
  getProviderCallMetrics()?.record(kind, ms);
}

/** Time an async block and record under the active `/plan` metrics (no-op if none). */
export async function timeProviderCall<T>(kind: ProviderKind, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    const out = await fn();
    recordProviderCall(kind, performance.now() - t0);
    return out;
  } catch (e) {
    recordProviderCall(kind, performance.now() - t0);
    throw e;
  }
}

export function runPlanWithProviderMetrics<T>(
  metrics: ProviderCallMetrics,
  fn: () => Promise<T>
): Promise<T> {
  // Async wrapper so continuations after `await` stay in the ALS store (Node async_hooks).
  return als.run(metrics, async () => {
    return await fn();
  });
}
