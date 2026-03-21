import type { LatLng, PlanTripResponse } from "../types";
import type {
  CanonicalCharger,
  ChargerPointMode,
  ChargerProvider,
  PoiProvider
} from "../mirror/providerContracts";
import { haversineMiles } from "./geo";
import { getRoutePolyline } from "../services/valhallaClient";
import { samplePointsAlongPolyline } from "./roadSampling";

function interpolateLatLng(a: LatLng, b: LatLng, t: number): LatLng {
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t
  };
}

export type CorridorChargersOk = {
  ok: true;
  chargers: CanonicalCharger[];
  candidatesForResponse?: PlanTripResponse["candidates"];
  debug: {
    chargersFoundTotal: number;
    corridorSampling: {
      stepMiles: number;
      nrelRadiusMiles: number;
      corridorSamplesUsed: number;
      corridorMaxSamples: number;
      chargersCandidateCap: number;
      mode: "nearby-route" | "nearby-point";
    };
  };
};

export type CorridorChargersErr = {
  ok: false;
  message: string;
  debug: Record<string, unknown>;
};

/**
 * Valhalla corridor polyline + NREL corridor chargers + optional hotel preview.
 * Shared by `planTripOneLeg` and `POST /candidates`.
 */
export async function fetchCorridorChargersForLeg(ctx: {
  requestId: string;
  legIndex: number;
  startCoords: LatLng;
  endCoords: LatLng;
  includeCandidates: boolean;
  chargersProvider: ChargerProvider;
  poisProvider: PoiProvider;
  logEvent: (event: string, data?: Record<string, unknown>) => void;
  overnightHotelRadiusMeters: number;
}): Promise<CorridorChargersOk | CorridorChargersErr> {
  const radiusMiles = Number(process.env.NREL_RADIUS_MILES ?? "30");
  const stepMiles = Number(process.env.CORRIDOR_STEP_MILES ?? "30");
  const maxCorridorSamples = Number(process.env.CORRIDOR_MAX_SAMPLE_POINTS ?? "80");
  const candidateChargersCap = Number(process.env.CANDIDATE_CHARGERS_CAP ?? "25");
  const includeAllElectricChargers =
    (process.env.NREL_INCLUDE_ALL_ELECTRIC_CHARGERS ?? "false").toLowerCase() === "true";
  const chargerPointMode: ChargerPointMode = includeAllElectricChargers
    ? "electric_all"
    : "dc_fast";
  const useNearbyRoute =
    (process.env.USE_NREL_NEARBY_ROUTE ?? "false").toLowerCase() === "true";

  let samplePoints: LatLng[] = [];
  const polyT0 = Date.now();
  try {
    const poly = await getRoutePolyline(ctx.startCoords, ctx.endCoords);
    const valhallaMs = Date.now() - polyT0;
    samplePoints = samplePointsAlongPolyline(
      poly as { type: "LineString"; coordinates: [number, number][] },
      stepMiles,
      maxCorridorSamples
    );
    ctx.logEvent("provider_valhalla_polyline", {
      durationMs: valhallaMs,
      corridorSamplesUsed: samplePoints.length
    });
  } catch (e) {
    const valhallaAttemptMs = Date.now() - polyT0;
    const errMsg = e instanceof Error ? e.message : String(e);
    ctx.logEvent("provider_valhalla_polyline_failed", {
      durationMs: valhallaAttemptMs,
      error: errMsg.length > 300 ? `${errMsg.slice(0, 300)}…` : errMsg
    });

    const fallbackT0 = Date.now();
    const approxMiles = haversineMiles(ctx.startCoords, ctx.endCoords);
    const rawSampleCount = Math.max(5, Math.ceil(approxMiles / stepMiles));
    const approxSampleCount = Math.min(rawSampleCount, maxCorridorSamples);
    for (let i = 0; i < approxSampleCount; i++) {
      const t = approxSampleCount <= 1 ? 0 : i / (approxSampleCount - 1);
      samplePoints.push(interpolateLatLng(ctx.startCoords, ctx.endCoords, t));
    }
    ctx.logEvent("provider_valhalla_polyline_fallback", {
      valhallaAttemptMs,
      fallbackBuildMs: Date.now() - fallbackT0,
      corridorSamplesUsed: samplePoints.length,
      approxMiles: Math.round(approxMiles * 10) / 10
    });
  }

  if (samplePoints.length > 0) {
    const startD = haversineMiles(samplePoints[0], ctx.startCoords);
    if (startD > 0.05) samplePoints.unshift(ctx.startCoords);

    const endD = haversineMiles(samplePoints[samplePoints.length - 1], ctx.endCoords);
    if (endD > 0.05) samplePoints.push(ctx.endCoords);
  }

  let chargers: CanonicalCharger[] = [];
  const nrelCorridorT0 = Date.now();
  if (useNearbyRoute && samplePoints.length >= 2) {
    chargers = await ctx.chargersProvider.findChargersNearRoute(
      samplePoints,
      radiusMiles,
      "dc_fast",
      { requestId: ctx.requestId }
    );
  } else {
    const chargersById = new Map<string, CanonicalCharger>();
    for (const p of samplePoints) {
      const chargersNearPoint = await ctx.chargersProvider.findChargersNearPoint(
        p,
        radiusMiles,
        chargerPointMode,
        { requestId: ctx.requestId }
      );
      for (const c of chargersNearPoint) chargersById.set(c.id, c);
    }
    chargers = Array.from(chargersById.values());
  }
  ctx.logEvent("provider_nrel_corridor_chargers", {
    durationMs: Date.now() - nrelCorridorT0,
    mode: useNearbyRoute ? "nearby-route" : "nearby-point",
    corridorSamplesUsed: samplePoints.length,
    chargersFoundTotal: chargers.length
  });

  const debugSampling = {
    chargersFoundTotal: chargers.length,
    corridorSampling: {
      stepMiles,
      nrelRadiusMiles: radiusMiles,
      corridorSamplesUsed: samplePoints.length,
      corridorMaxSamples: maxCorridorSamples,
      chargersCandidateCap: candidateChargersCap,
      mode: useNearbyRoute ? ("nearby-route" as const) : ("nearby-point" as const)
    }
  };

  if (!chargers.length) {
    return {
      ok: false,
      message: "No EV charging stops found for the trip.",
      debug: debugSampling
    };
  }

  let candidatesForResponse: PlanTripResponse["candidates"] | undefined;
  if (ctx.includeCandidates && chargers.length) {
    const chargerRows = chargers.slice(0, 500).map((c) => ({
      id: String(c.id),
      name: c.name,
      coords: c.coords,
      maxPowerKw: c.maxPowerKw,
      source: "nrel" as const
    }));
    const hotelRows: NonNullable<PlanTripResponse["candidates"]>["hotels"] = [];
    const hotelPreviewEnabled =
      (process.env.V2_HOTEL_MAP_PREVIEW ?? "true").toLowerCase() !== "false";
    if (hotelPreviewEnabled && samplePoints.length) {
      const mid = samplePoints[Math.floor(samplePoints.length / 2)] ?? samplePoints[0];
      try {
        const hotels = await ctx.poisProvider.findHolidayInnExpressHotelsNearPoint(
          mid,
          Math.min(120000, ctx.overnightHotelRadiusMeters * 4),
          { requestId: ctx.requestId }
        );
        for (const h of hotels.slice(0, 40)) {
          hotelRows.push({
            id: h.id,
            name: h.name,
            coords: h.coords,
            source: "overpass" as const
          });
        }
      } catch {
        // ignore — map still shows chargers
      }
    }
    candidatesForResponse = {
      chargers: chargerRows,
      hotels: hotelRows,
      legIndex: ctx.legIndex
    };
  }

  return {
    ok: true,
    chargers,
    candidatesForResponse,
    debug: debugSampling
  };
}
