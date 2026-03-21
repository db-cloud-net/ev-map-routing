import type { LatLng } from "./providerContracts";
import type {
  ChargerPointMode,
  ChargerProvider,
  CanonicalCharger,
  ProviderCallOptions
} from "./providerContracts";
import type { SourceError } from "./sourceErrors";
import { SourceErrorImpl } from "./sourceErrors";
import { withAbortTimeout } from "./withAbortTimeout";

import {
  fetchDcFastChargersNearPoint,
  fetchDcFastChargersNearRoute,
  fetchElectricChargersNearPoint,
  NrelError
} from "../services/nrelClient";

function parseStatusFromMessage(message: string): number | null {
  const m = message.match(/\((\d+)\)/);
  if (!m) return null;
  const status = Number(m[1]);
  return Number.isFinite(status) ? status : null;
}

function mapNrelError(err: unknown): SourceError {
  if (err instanceof NrelError) {
    if (err.message.toLowerCase().includes("missing nrel_api_key")) {
      return new SourceErrorImpl({
        message: err.message,
        code: "CONFIG_MISSING",
        source: "nrel",
        retryable: false,
        cause: err
      });
    }

    if (err.message.toLowerCase().includes("aborted")) {
      return new SourceErrorImpl({
        message: err.message,
        code: "REMOTE_TIMEOUT",
        source: "nrel",
        retryable: true,
        fallbackSuggested: true,
        cause: err
      });
    }

    const status = parseStatusFromMessage(err.message);
    if (status === 429) {
      return new SourceErrorImpl({
        message: err.message,
        code: "REMOTE_RATE_LIMIT",
        source: "nrel",
        retryable: true,
        fallbackSuggested: true,
        context: { httpStatus: status },
        cause: err
      });
    }

    if (status != null) {
      const is5xx = status >= 500;
      return new SourceErrorImpl({
        message: err.message,
        code: "REMOTE_HTTP",
        source: "nrel",
        retryable: is5xx,
        fallbackSuggested: true,
        context: { httpStatus: status },
        cause: err
      });
    }

    return new SourceErrorImpl({
      message: err.message,
      code: "REMOTE_HTTP",
      source: "nrel",
      retryable: true,
      fallbackSuggested: true,
      cause: err
    });
  }

  if (err instanceof Error) {
    if (err.name === "AbortError" || err.message.toLowerCase().includes("aborted")) {
      return new SourceErrorImpl({
        message: err.message,
        code: "REMOTE_TIMEOUT",
        source: "nrel",
        retryable: true,
        fallbackSuggested: true,
        cause: err
      });
    }

    // JSON parse errors etc.
    if (err.name === "SyntaxError") {
      return new SourceErrorImpl({
        message: err.message,
        code: "REMOTE_PARSE",
        source: "nrel",
        retryable: false,
        fallbackSuggested: true,
        cause: err
      });
    }
  }

  return new SourceErrorImpl({
    message: err instanceof Error ? err.message : "NREL fetch failed",
    code: "REMOTE_NETWORK",
    source: "nrel",
    retryable: true,
    fallbackSuggested: true,
    cause: err
  });
}

function mapCharger(c: {
  id: string;
  name: string;
  coords: LatLng;
  maxPowerKw?: number;
}): CanonicalCharger {
  return {
    entityType: "charger",
    id: `nrel:${c.id}`,
    providerId: c.id,
    source: "nrel",
    name: c.name,
    coords: c.coords,
    maxPowerKw: c.maxPowerKw
  };
}

function defaultTimeoutMsForEnv(envVar: string, fallback: number) {
  const raw = process.env[envVar];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class RemoteNrelAdapter implements ChargerProvider {
  async findChargersNearPoint(
    point: LatLng,
    radiusMiles: number,
    mode: ChargerPointMode,
    opts?: ProviderCallOptions
  ): Promise<CanonicalCharger[]> {
    const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMsForEnv("NREL_FETCH_TIMEOUT_MS", 60000);
    const { signal, cleanup } = withAbortTimeout({
      parentSignal: opts?.signal,
      timeoutMs
    });

    try {
      const chargers =
        mode === "electric_all"
          ? await fetchElectricChargersNearPoint(point, radiusMiles, { signal })
          : await fetchDcFastChargersNearPoint(point, radiusMiles, { signal });

      return chargers.map(mapCharger);
    } catch (err) {
      throw mapNrelError(err);
    } finally {
      cleanup();
    }
  }

  async findChargersNearRoute(
    routePoints: LatLng[],
    corridorMiles: number,
    _mode: ChargerPointMode,
    opts?: ProviderCallOptions
  ): Promise<CanonicalCharger[]> {
    // v1: nearby-route is dc_fast only today; treat electric_all as dc_fast.
    const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMsForEnv("NREL_FETCH_TIMEOUT_MS", 60000);
    const { signal, cleanup } = withAbortTimeout({
      parentSignal: opts?.signal,
      timeoutMs
    });

    try {
      const chargers = await fetchDcFastChargersNearRoute(routePoints, corridorMiles, { signal });
      return chargers.map(mapCharger);
    } catch (err) {
      throw mapNrelError(err);
    } finally {
      cleanup();
    }
  }
}

