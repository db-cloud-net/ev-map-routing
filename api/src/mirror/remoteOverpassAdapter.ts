import type { LatLng } from "./providerContracts";
import type {
  CanonicalPoiHotel,
  PoiProvider,
  ProviderCallOptions
} from "./providerContracts";
import type { SourceError } from "./sourceErrors";
import { SourceErrorImpl } from "./sourceErrors";
import { withAbortTimeout } from "./withAbortTimeout";

import {
  findHolidayInnExpressNearby,
  OverpassError
} from "../services/overpassClient";

function parseStatusFromMessage(message: string): number | null {
  const m = message.match(/\((\d+)\)/);
  if (!m) return null;
  const status = Number(m[1]);
  return Number.isFinite(status) ? status : null;
}

function mapOverpassError(err: unknown): SourceError {
  if (err instanceof OverpassError) {
    if (err.message.toLowerCase().includes("timeout")) {
      return new SourceErrorImpl({
        message: err.message,
        code: "REMOTE_TIMEOUT",
        source: "overpass",
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
        source: "overpass",
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
        source: "overpass",
        retryable: is5xx,
        fallbackSuggested: true,
        context: { httpStatus: status },
        cause: err
      });
    }

    return new SourceErrorImpl({
      message: err.message,
      code: "REMOTE_HTTP",
      source: "overpass",
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
        source: "overpass",
        retryable: true,
        fallbackSuggested: true,
        cause: err
      });
    }

    if (err.name === "SyntaxError") {
      return new SourceErrorImpl({
        message: err.message,
        code: "REMOTE_PARSE",
        source: "overpass",
        retryable: false,
        fallbackSuggested: true,
        cause: err
      });
    }
  }

  return new SourceErrorImpl({
    message: err instanceof Error ? err.message : "Overpass fetch failed",
    code: "REMOTE_NETWORK",
    source: "overpass",
    retryable: true,
    fallbackSuggested: true,
    cause: err
  });
}

function mapHotel(h: {
  id: string;
  name: string;
  coords: LatLng;
  osmType?: string;
  // Overpass client doesn't currently expose brand/tourism.
}): CanonicalPoiHotel {
  const osmType = h.osmType ?? "unknown";
  return {
    entityType: "poi_hotel",
    id: `overpass:${osmType}:${h.id}`,
    providerId: h.id,
    source: "overpass",
    name: h.name,
    coords: h.coords,
    tourism: "hotel",
    osmType
  };
}

function defaultTimeoutMsForEnv(envVar: string, fallback: number) {
  const raw = process.env[envVar];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class RemoteOverpassAdapter implements PoiProvider {
  async findHolidayInnExpressHotelsNearPoint(
    point: LatLng,
    radiusMeters: number,
    opts?: ProviderCallOptions
  ): Promise<CanonicalPoiHotel[]> {
    const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMsForEnv("OVERPASS_FETCH_TIMEOUT_MS", 60000);
    const { signal, cleanup } = withAbortTimeout({
      parentSignal: opts?.signal,
      timeoutMs
    });

    try {
      const hotels = await findHolidayInnExpressNearby(point, radiusMeters, { signal });
      return hotels.map(mapHotel);
    } catch (err) {
      throw mapOverpassError(err);
    } finally {
      cleanup();
    }
  }
}

