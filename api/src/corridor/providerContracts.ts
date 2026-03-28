import type { LatLng as SharedLatLng } from "../types";

/**
 * Canonical corridor charger / hotel shapes for the planner. Data is loaded from **POI Services**
 * (`corridorCandidates` / `poiServicesMapping`). `source` values preserve stable id prefixes for
 * legacy `nrel:` / `overpass:` strings when POI shards expose upstream ids — Travel-Routing does not
 * call live NREL or Overpass (see `docs/designs/deprecate-nrel-overpass-mirror-travel-routing-adr.md`).
 */
export type LatLng = SharedLatLng;

export type CanonicalCharger = {
  entityType: "charger";
  /** Stable id, often `poi_services:…` or legacy `nrel:<providerId>`. */
  id: string;
  providerId: string;
  source: "nrel" | "poi_services";
  name: string;
  coords: LatLng;
  maxPowerKw?: number;
};

export type CanonicalPoiHotel = {
  entityType: "poi_hotel";
  id: string;
  providerId: string;
  source: "overpass" | "poi_services";
  name: string;
  coords: LatLng;
  brand?: string;
  tourism: "hotel";
  osmType?: string;
};

export type ChargerPointMode = "dc_fast" | "electric_all";

export type ProviderCallOptions = {
  requestId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type ChargerProvider = {
  findChargersNearPoint(
    point: LatLng,
    radiusMiles: number,
    mode: ChargerPointMode,
    opts?: ProviderCallOptions
  ): Promise<CanonicalCharger[]>;

  findChargersNearRoute(
    routePoints: LatLng[],
    corridorMiles: number,
    mode: ChargerPointMode,
    opts?: ProviderCallOptions
  ): Promise<CanonicalCharger[]>;
};

export type PoiProvider = {
  findHolidayInnExpressHotelsNearPoint(
    point: LatLng,
    radiusMeters: number,
    opts?: ProviderCallOptions
  ): Promise<CanonicalPoiHotel[]>;
};

/** Runtime bundle for `resolvePlanProviders` — POI Services-only (`sourceRouter.ts`). */
export type PlanProviderBundle = {
  chargers: ChargerProvider;
  pois: PoiProvider;
  meta: {
    mode: "poi_only";
    effectiveSourceRoutingMode: "poi_only";
  };
};
