import type { LatLng as SharedLatLng } from "../types";

export type LatLng = SharedLatLng;

export type MirrorSchemaVersion = "1.0.0";

export type CanonicalCharger = {
  entityType: "charger";
  /** Stable canonical id: `nrel:<providerId>` */
  id: string;
  providerId: string;
  source: "nrel";
  name: string;
  coords: LatLng;
  maxPowerKw?: number;
};

export type CanonicalPoiHotel = {
  entityType: "poi_hotel";
  /** Stable canonical id: `overpass:<osmType>:<providerId>` */
  id: string;
  providerId: string;
  source: "overpass";
  name: string;
  coords: LatLng;
  brand?: string;
  tourism: "hotel";
  osmType?: string;
};

export type ChargerPointMode = "dc_fast" | "electric_all";

export type ProviderCallOptions = {
  /** request correlation id for logs */
  requestId?: string;
  /** Parent cancellation (client disconnect, etc.) */
  signal?: AbortSignal;
  /** Per-call deadline */
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

export type SourceRoutingMode =
  | "remote_only"
  | "local_primary_fallback_remote"
  | "dual_read_compare";

export type PlanProviderBundle = {
  chargers: ChargerProvider;
  pois: PoiProvider;
  meta: {
    mode: SourceRoutingMode;
    mirrorSnapshotId?: string;
    mirrorSchemaVersion?: MirrorSchemaVersion;
    effectiveSourceRoutingMode: SourceRoutingMode;
  };
};

