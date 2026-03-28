import type { LatLng, PlanTripResponse } from "../types";
import type { CanonicalCharger, CanonicalPoiHotel, ChargerPointMode } from "../corridor/providerContracts";
import { haversineMiles } from "./geo";
import { getRoutePolyline } from "../services/valhallaClient";
import {
  isPoiServicesCorridorEnabled,
  isPoiServicesEdgesEnabled,
  isPoiServicesPairsEnabled,
  postCorridorQuery
} from "../services/poiServicesClient";
import {
  buildEdgeMapsFromPoiServices,
  mapPoiServicesChargerToCanonical,
  mapPoiServicesHotelToCanonical,
  parsePoiCorridorPairs
} from "../services/poiServicesMapping";
import type { PoiServicesCorridorLayer, PoiServicesPoi } from "../services/poiServicesTypes";
import { samplePointsAlongPolyline } from "./roadSampling";

/** Corridor sampling radius (miles) for POI `corridor_radius_mi`. Prefer `CORRIDOR_SEARCH_RADIUS_MILES`; `NREL_RADIUS_MILES` is a deprecated alias. */
function readCorridorSearchRadiusMiles(): number {
  const raw =
    process.env.CORRIDOR_SEARCH_RADIUS_MILES ?? process.env.NREL_RADIUS_MILES ?? "30";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/** DC-fast vs all electric — `CORRIDOR_*` names preferred; `NREL_INCLUDE_ALL_ELECTRIC_CHARGERS` is deprecated. */
function readIncludeAllElectricChargers(): boolean {
  const raw =
    process.env.CORRIDOR_INCLUDE_ALL_ELECTRIC_CHARGERS ??
    process.env.NREL_INCLUDE_ALL_ELECTRIC_CHARGERS ??
    "false";
  return raw.toLowerCase() === "true";
}

/** `USE_CORRIDOR_NEARBY_ROUTE` preferred; `USE_NREL_NEARBY_ROUTE` deprecated. */
function readUseNearbyRouteMode(): boolean {
  const raw = process.env.USE_CORRIDOR_NEARBY_ROUTE ?? process.env.USE_NREL_NEARBY_ROUTE ?? "false";
  return raw.toLowerCase() === "true";
}

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
  /** True when this leg used POI Services for corridor chargers (not NREL sampling). */
  usedPoiServices?: boolean;
  /** Hotels from POI corridor layer (canonical ids) for overnight / sleep-stop logic. */
  poiCorridorHotels?: CanonicalPoiHotel[];
  /** Raw POI hotel rows used for `sleep` stop join logic. */
  poiCorridorHotelPois?: PoiServicesPoi[];
  /** POI charger map (poiServicesPoi.id -> canonical charger) for resolving `nearby_dcfc_id`. */
  poiDcfcByPoiIntId?: Map<number, CanonicalCharger>;
  /** Precomputed hotel id → paired DCFC for sleep-stop meta when `pairs` layer returned rows. */
  pairChargerByHotelId?: Record<string, CanonicalCharger>;
  /** POI Services precomputed charger graph (canonical id pairs), when `edges` layer was used. */
  precomputedEdgeTravelMinutes?: Map<string, number>;
  precomputedEdgeDistanceMiles?: Map<string, number>;
  debug: {
    chargersFoundTotal: number;
    corridorSampling: {
      stepMiles: number;
      corridorRadiusMiles: number;
      corridorSamplesUsed: number;
      corridorMaxSamples: number;
      chargersCandidateCap: number;
      mode: "nearby-route" | "nearby-point";
      /** When true, chargers (and optional hotels/edges) came from POI Services `POST /corridor/query`. */
      poiServices?: boolean;
      poiServicesEdgeCount?: number;
      poiServicesWarnings?: string[];
      /** Rows returned in `pairs` layer (after parse), when requested. */
      poiServicesPairCount?: number;
    };
  };
};

export type CorridorChargersErr = {
  ok: false;
  message: string;
  /** Stable client code when POI corridor fail-closed applies. */
  errorCode?: string;
  debug: Record<string, unknown>;
};

/**
 * Valhalla corridor polyline + POI Services corridor chargers/hotels.
 * Shared by `planTripOneLeg` and `POST /candidates`.
 */
export async function fetchCorridorChargersForLeg(ctx: {
  requestId: string;
  legIndex: number;
  startCoords: LatLng;
  endCoords: LatLng;
  includeCandidates: boolean;
  logEvent: (event: string, data?: Record<string, unknown>) => void;
  overnightHotelRadiusMeters: number;
}): Promise<CorridorChargersOk | CorridorChargersErr> {
  const radiusMiles = readCorridorSearchRadiusMiles();
  const stepMiles = Number(process.env.CORRIDOR_STEP_MILES ?? "30");
  const maxCorridorSamples = Number(process.env.CORRIDOR_MAX_SAMPLE_POINTS ?? "80");
  const candidateChargersCap = Number(process.env.CANDIDATE_CHARGERS_CAP ?? "25");

  const usePoiConstrained = (process.env.USE_POI_CONSTRAINED_DIJKSTRA ?? "false").toLowerCase() === "true";
  const includeAllElectricChargers = readIncludeAllElectricChargers();
  const chargerPointMode: ChargerPointMode = includeAllElectricChargers
    ? "electric_all"
    : "dc_fast";
  const useNearbyRoute = readUseNearbyRouteMode();

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
  let precomputedEdgeTravelMinutes: Map<string, number> | undefined;
  let precomputedEdgeDistanceMiles: Map<string, number> | undefined;
  let usedPoiServices = false;
  let poiEdgeCount = 0;
  let poiWarnings: string[] | undefined;
  let poiServicesHotels: PoiServicesPoi[] | undefined;
  let poiDcfcByPoiIntId: Map<number, CanonicalCharger> | undefined;
  let pairChargerByHotelId: Record<string, CanonicalCharger> | undefined;
  let poiPairCount: number | undefined;

  const tryPoiServices =
    isPoiServicesCorridorEnabled() &&
    samplePoints.length >= 2 &&
    chargerPointMode === "dc_fast";

  const poiCorridorRequired = isPoiServicesCorridorEnabled();

  if (!poiCorridorRequired) {
    return {
      ok: false,
      errorCode: "POI_SERVICES_NOT_CONFIGURED",
      message:
        "POI Services is not configured for corridor planning. Set POI_SERVICES_BASE_URL (and keep USE_POI_SERVICES_CORRIDOR enabled).",
      debug: {
        corridorSampling: {
          stepMiles,
          corridorRadiusMiles: radiusMiles,
          corridorSamplesUsed: samplePoints.length,
          corridorMaxSamples: maxCorridorSamples,
          chargersCandidateCap: candidateChargersCap,
          mode: useNearbyRoute ? "nearby-route" : "nearby-point"
        }
      }
    };
  }

  if (!tryPoiServices) {
    const msg =
      samplePoints.length < 2
        ? "Need at least two corridor sample points for POI Services (check Valhalla route / polyline)."
        : "POI corridor requires DC-fast charger mode (set CORRIDOR_INCLUDE_ALL_ELECTRIC_CHARGERS=false).";
    return {
      ok: false,
      errorCode: "POI_SERVICES_CORRIDOR_FAILED",
      message: msg,
      debug: {
        corridorSampling: {
          stepMiles,
          corridorRadiusMiles: radiusMiles,
          corridorSamplesUsed: samplePoints.length,
          corridorMaxSamples: maxCorridorSamples,
          chargersCandidateCap: candidateChargersCap,
          mode: useNearbyRoute ? "nearby-route" : "nearby-point",
          poiServices: true
        }
      }
    };
  }

  {
    const poiT0 = Date.now();
    try {
      const shape = samplePoints.map((p) => ({ lat: p.lat, lon: p.lon }));
      const layers: PoiServicesCorridorLayer[] = ["charger", "hotel"];
      if (isPoiServicesEdgesEnabled() || usePoiConstrained) {
        layers.push("edges");
      }
      if (isPoiServicesPairsEnabled() || usePoiConstrained) {
        layers.push("pairs");
      }
      const pairsMaxYd = Math.min(
        500,
        Math.max(1, Math.round(ctx.overnightHotelRadiusMeters / 0.9144))
      );
      const resp = await postCorridorQuery(
        {
          shape,
          corridor_radius_mi: radiusMiles,
          layers,
          filters:
            isPoiServicesPairsEnabled() || usePoiConstrained
              ? { pairs_max_distance_yd: pairsMaxYd }
              : undefined
        },
        { timeoutMs: Number(process.env.POI_SERVICES_TIMEOUT_MS ?? "30000") }
      );
      const rawChargers = resp.charger ?? [];
      chargers = rawChargers.map(mapPoiServicesChargerToCanonical);
      usedPoiServices = true;
      poiWarnings = resp.warnings?.length ? resp.warnings : undefined;

      poiServicesHotels = resp.hotel;

      const pairsParsed = parsePoiCorridorPairs(resp.pairs as unknown);
      poiPairCount = isPoiServicesPairsEnabled() ? pairsParsed.length : undefined;
      const chargerByIntId = new Map<number, PoiServicesPoi>();
      const dcfcCanonByPoiIntId = new Map<number, CanonicalCharger>();
      for (const c of rawChargers) {
        chargerByIntId.set(c.id, c);
        dcfcCanonByPoiIntId.set(c.id, mapPoiServicesChargerToCanonical(c));
      }
      poiDcfcByPoiIntId = dcfcCanonByPoiIntId;
      const pairMap: Record<string, CanonicalCharger> = {};
      for (const p of pairsParsed) {
        const hid = p.hotel_id ?? p.hotel?.id;
        if (hid == null) continue;
        let chargerPoi: PoiServicesPoi | null = p.nearby_dcfc ?? null;
        const dcfcId = p.dcfc_id;
        if (!chargerPoi && dcfcId != null) {
          chargerPoi = chargerByIntId.get(dcfcId) ?? null;
        }
        if (!chargerPoi) continue;
        pairMap[`poi_services:hotel:${hid}`] = mapPoiServicesChargerToCanonical(chargerPoi);
      }
      if (Object.keys(pairMap).length) {
        pairChargerByHotelId = pairMap;
      }

      if (isPoiServicesEdgesEnabled() && resp.edges?.length) {
        const maps = buildEdgeMapsFromPoiServices(rawChargers, resp.edges);
        precomputedEdgeTravelMinutes = maps.travelMinutes;
        precomputedEdgeDistanceMiles = maps.distanceMiles;
        poiEdgeCount = resp.edges.length;
      }

      ctx.logEvent("provider_poi_services_corridor", {
        durationMs: Date.now() - poiT0,
        corridorSamplesUsed: samplePoints.length,
        chargersFoundTotal: chargers.length,
        edgeRows: poiEdgeCount,
        warningsCount: resp.warnings?.length ?? 0
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.logEvent("provider_poi_services_corridor_failed", {
        durationMs: Date.now() - poiT0,
        error: msg.length > 400 ? `${msg.slice(0, 400)}…` : msg
      });
      return {
        ok: false,
        errorCode: "POI_SERVICES_CORRIDOR_FAILED",
        message: `POI Services corridor query failed: ${msg}`,
        debug: {
          corridorSampling: {
            stepMiles,
            corridorRadiusMiles: radiusMiles,
            corridorSamplesUsed: samplePoints.length,
            corridorMaxSamples: maxCorridorSamples,
            chargersCandidateCap: candidateChargersCap,
            mode: useNearbyRoute ? "nearby-route" : "nearby-point",
            poiServices: true
          }
        }
      };
    }

    if (usedPoiServices && !chargers.length) {
      return {
        ok: false,
        errorCode: "POI_SERVICES_NO_CHARGERS",
        message: "No EV charging stops found for the trip (POI Services returned no chargers).",
        debug: {
          corridorSampling: {
            stepMiles,
            corridorRadiusMiles: radiusMiles,
            corridorSamplesUsed: samplePoints.length,
            corridorMaxSamples: maxCorridorSamples,
            chargersCandidateCap: candidateChargersCap,
            mode: useNearbyRoute ? "nearby-route" : "nearby-point",
            poiServices: true,
            poiServicesWarnings: poiWarnings
          }
        }
      };
    }
  }

  ctx.logEvent("corridor_chargers_resolved", {
    source: "poi_services",
    mode: useNearbyRoute ? "nearby-route" : "nearby-point",
    corridorSamplesUsed: samplePoints.length,
    chargersFoundTotal: chargers.length
  });

  const debugSampling = {
    chargersFoundTotal: chargers.length,
    corridorSampling: {
      stepMiles,
      corridorRadiusMiles: radiusMiles,
      corridorSamplesUsed: samplePoints.length,
      corridorMaxSamples: maxCorridorSamples,
      chargersCandidateCap: candidateChargersCap,
      mode: useNearbyRoute ? ("nearby-route" as const) : ("nearby-point" as const),
      ...(usedPoiServices
        ? {
            poiServices: true as const,
            poiServicesEdgeCount: poiEdgeCount,
            poiServicesWarnings: poiWarnings,
            ...(poiPairCount !== undefined ? { poiServicesPairCount: poiPairCount } : {})
          }
        : {})
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
      source: "poi_services" as const
    }));
    const hotelRows: NonNullable<PlanTripResponse["candidates"]>["hotels"] = [];
    const hotelPreviewEnabled =
      (process.env.V2_HOTEL_MAP_PREVIEW ?? "true").toLowerCase() !== "false";
    if (hotelPreviewEnabled && samplePoints.length && usedPoiServices && poiServicesHotels?.length) {
      for (const h of poiServicesHotels.slice(0, 40)) {
        const canon = mapPoiServicesHotelToCanonical(h);
        hotelRows.push({
          id: canon.id,
          name: canon.name,
          coords: canon.coords,
          source: "poi_services" as const
        });
      }
    }
    candidatesForResponse = {
      chargers: chargerRows,
      hotels: hotelRows,
      legIndex: ctx.legIndex
    };
  }

  const poiCorridorHotels: CanonicalPoiHotel[] | undefined =
    usedPoiServices && poiServicesHotels?.length
      ? poiServicesHotels.map(mapPoiServicesHotelToCanonical)
      : undefined;

  const poiCorridorHotelPois: PoiServicesPoi[] | undefined =
    usedPoiServices && poiServicesHotels?.length ? poiServicesHotels : undefined;

  return {
    ok: true,
    chargers,
    candidatesForResponse,
    usedPoiServices: usedPoiServices || undefined,
    poiCorridorHotels,
    poiCorridorHotelPois,
    poiDcfcByPoiIntId: usedPoiServices ? poiDcfcByPoiIntId : undefined,
    pairChargerByHotelId,
    precomputedEdgeTravelMinutes,
    precomputedEdgeDistanceMiles,
    debug: debugSampling
  };
}
