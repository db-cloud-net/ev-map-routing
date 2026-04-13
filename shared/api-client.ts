/**
 * shared/api-client.ts
 *
 * Typed fetch wrappers for the EV routing API.
 *
 * Usage:
 *   import { planTrip, getCandidates, getRoutePreview } from "../../../shared/api-client";
 *   const result = await planTrip({ start: "Charlotte, NC", end: "Raleigh, NC" }, { baseUrl: "http://localhost:3001" });
 *
 * All functions throw ApiError on non-2xx responses and propagate TypeError
 * on network failure. Pass an AbortSignal via options.signal for timeouts.
 */

import type {
  CandidatesApiResponse,
  ItineraryStop,
  PlanTripRequest,
  PlanTripResponse,
  ReplanFrom,
  RoutePreviewApiResponse,
} from "./types";

// ─── Error type ──────────────────────────────────────────────────────────────

/**
 * Thrown when the API returns a non-2xx HTTP status.
 * Carries the raw status code and the parsed response body (if available).
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface ApiClientOptions {
  /** API origin with no trailing slash, e.g. "http://localhost:3001". */
  baseUrl: string;
  /** Optional AbortSignal for timeout or cancellation. */
  signal?: AbortSignal;
}

// ─── Request types ────────────────────────────────────────────────────────────

/**
 * Request body for POST /candidates.
 * Subset of PlanTripRequest — only the fields the candidates endpoint accepts.
 */
export type CandidatesRequest =
  | { start: string; end: string; waypoints?: string[] }
  | { replanFrom: ReplanFrom; previousStops?: ItineraryStop[]; end: string; waypoints?: string[] };

/**
 * Request body for POST /route-preview (single leg, no EV solver).
 */
export type RoutePreviewRequest = {
  start: string;
  end: string;
  waypoints?: string[];
};

// ─── Internal helper ─────────────────────────────────────────────────────────

async function postJson<T>(
  url: string,
  body: unknown,
  signal: AbortSignal | undefined
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ApiError(
      response.status,
      `API returned HTTP ${response.status} with non-JSON body`
    );
  }

  if (!response.ok) {
    const message =
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof (parsed as Record<string, unknown>).message === "string"
        ? (parsed as { message: string }).message
        : `Request failed with HTTP ${response.status}`;
    throw new ApiError(response.status, message, parsed);
  }

  return parsed as T;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * POST /plan — blocking EV route plan.
 *
 * Returns the full PlanTripResponse once the solver finishes.
 * For progressive updates while planning, use planTripJob() (future — see TODOS.md).
 */
export async function planTrip(
  request: PlanTripRequest,
  options: ApiClientOptions
): Promise<PlanTripResponse> {
  const url = `${options.baseUrl.replace(/\/$/, "")}/plan`;
  return postJson<PlanTripResponse>(url, request, options.signal);
}

/**
 * POST /candidates — charger + hotel candidates along the corridor.
 *
 * Intended for parallel prefetch alongside planTrip() so map pins can
 * appear before the full itinerary arrives.
 */
export async function getCandidates(
  request: CandidatesRequest,
  options: ApiClientOptions
): Promise<CandidatesApiResponse> {
  const url = `${options.baseUrl.replace(/\/$/, "")}/candidates`;
  return postJson<CandidatesApiResponse>(url, request, options.signal);
}

/**
 * POST /route-preview — fast road geometry for a single A→B leg (no EV solver).
 *
 * Returns the Valhalla polyline + turn-by-turn horizon. Use fetchMergedRoutePreview
 * from web/src/lib/mergeRoutePreview.ts when multi-hop chains are needed.
 */
export async function getRoutePreview(
  request: RoutePreviewRequest,
  options: ApiClientOptions
): Promise<RoutePreviewApiResponse> {
  const url = `${options.baseUrl.replace(/\/$/, "")}/route-preview`;
  return postJson<RoutePreviewApiResponse>(url, request, options.signal);
}
