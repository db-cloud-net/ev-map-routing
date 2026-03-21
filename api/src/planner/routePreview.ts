/**
 * Slice 4 — single-leg road preview (Valhalla only, no EV least-time solver).
 * See docs/designs/slice4-progressive-first-screen.md.
 */

import type { ItineraryLeg, RoutePreviewApiResponse, RoutePreviewBody } from "../types";
import { GeocodeError, geocodeTextToLatLng } from "../services/geocode";
import {
  ValhallaError,
  getRoutePolyline,
  getRouteWithDirectionsAndSummary
} from "../services/valhallaClient";

function horizonConfig(): { maxMinutes: number; minManeuvers: number } {
  const maxMinutes = Number(process.env.ROUTE_PREVIEW_HORIZON_MINUTES ?? "10");
  const minManeuvers = Number(process.env.ROUTE_PREVIEW_MIN_MANEUVERS ?? "2");
  return {
    maxMinutes: Number.isFinite(maxMinutes) && maxMinutes > 0 ? maxMinutes : 10,
    minManeuvers:
      Number.isFinite(minManeuvers) && minManeuvers >= 1 ? Math.floor(minManeuvers) : 2
  };
}

/**
 * First ~maxMinutes of driving along the route, with at least minManeuvers steps when possible.
 * Aligns with ROUTING_UX_SPEC §3 (time-primary horizon + guardrails).
 */
export function clipManeuversToHorizon(
  maneuvers: NonNullable<ItineraryLeg["maneuvers"]>,
  opts: { maxMinutes: number; minManeuvers: number }
): { horizon: NonNullable<ItineraryLeg["maneuvers"]>; cumulativeTimeSeconds: number } {
  if (!maneuvers.length) {
    return { horizon: [], cumulativeTimeSeconds: 0 };
  }

  const maxSec = opts.maxMinutes * 60;
  const hasAnyTime = maneuvers.some((m) => typeof m.timeSeconds === "number" && m.timeSeconds > 0);

  if (!hasAnyTime) {
    const take = Math.min(
      maneuvers.length,
      Math.max(opts.minManeuvers, Math.min(12, maneuvers.length))
    );
    const horizon = maneuvers.slice(0, take);
    return { horizon, cumulativeTimeSeconds: 0 };
  }

  const out: NonNullable<ItineraryLeg["maneuvers"]> = [];
  let cum = 0;
  for (let i = 0; i < maneuvers.length; i++) {
    const m = maneuvers[i];
    out.push(m);
    cum += typeof m.timeSeconds === "number" ? m.timeSeconds : 0;
    if (out.length >= opts.minManeuvers && cum >= maxSec) {
      break;
    }
  }

  if (out.length < opts.minManeuvers && maneuvers.length >= opts.minManeuvers) {
    const horizon = maneuvers.slice(0, opts.minManeuvers);
    let c = 0;
    for (const m of horizon) {
      c += typeof m.timeSeconds === "number" ? m.timeSeconds : 0;
    }
    return { horizon, cumulativeTimeSeconds: c };
  }

  return { horizon: out, cumulativeTimeSeconds: cum };
}

export async function buildRoutePreviewSingleLeg(input: {
  requestId: string;
  start: string;
  end: string;
}): Promise<RoutePreviewApiResponse> {
  const responseVersion = "v2-1-route-preview" as const;
  const { maxMinutes, minManeuvers } = horizonConfig();

  try {
    const [startCoords, endCoords] = await Promise.all([
      geocodeTextToLatLng(input.start),
      geocodeTextToLatLng(input.end)
    ]);

    let route = await getRouteWithDirectionsAndSummary(startCoords, endCoords);

    if (!route.geometry?.coordinates?.length) {
      try {
        const poly = await getRoutePolyline(startCoords, endCoords);
        if (!poly?.coordinates?.length) {
          return {
            requestId: input.requestId,
            responseVersion,
            status: "error",
            message: "Valhalla returned no route geometry for preview.",
            errorCode: "ROUTE_PREVIEW_NO_GEOMETRY"
          };
        }
        route = { ...route, geometry: poly };
      } catch {
        return {
          requestId: input.requestId,
          responseVersion,
          status: "error",
          message: "Valhalla returned no route geometry for preview.",
          errorCode: "ROUTE_PREVIEW_NO_GEOMETRY"
        };
      }
    }

    if (!route.geometry?.coordinates?.length) {
      return {
        requestId: input.requestId,
        responseVersion,
        status: "error",
        message: "Valhalla returned no route geometry for preview.",
        errorCode: "ROUTE_PREVIEW_NO_GEOMETRY"
      };
    }

    const tripTimeSeconds = route.tripTimeSeconds;
    const tripTimeMinutes =
      tripTimeSeconds != null && Number.isFinite(tripTimeSeconds)
        ? tripTimeSeconds / 60
        : 0;

    const tripDistanceMiles =
      route.tripDistanceMiles != null && Number.isFinite(route.tripDistanceMiles)
        ? route.tripDistanceMiles
        : 0;

    const maneuvers = route.maneuvers ?? [];
    const { horizon, cumulativeTimeSeconds } = clipManeuversToHorizon(maneuvers, {
      maxMinutes,
      minManeuvers
    });

    const preview: RoutePreviewBody = {
      polyline: route.geometry,
      tripTimeMinutes,
      tripDistanceMiles,
      horizon: {
        maxMinutes,
        maneuvers: horizon,
        cumulativeTimeSeconds
      }
    };

    return {
      requestId: input.requestId,
      responseVersion,
      status: "ok",
      preview
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof GeocodeError) {
      return {
        requestId: input.requestId,
        responseVersion,
        status: "error",
        message: msg,
        errorCode: "GEOCODE_FAILED"
      };
    }
    if (e instanceof ValhallaError) {
      return {
        requestId: input.requestId,
        responseVersion,
        status: "error",
        message: msg,
        errorCode: "VALHALLA_ROUTE_PREVIEW_FAILED"
      };
    }
    return {
      requestId: input.requestId,
      responseVersion,
      status: "error",
      message: msg,
      errorCode: "ROUTE_PREVIEW_FAILED"
    };
  }
}
