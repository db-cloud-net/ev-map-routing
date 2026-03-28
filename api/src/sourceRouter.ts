import type {
  CanonicalCharger,
  CanonicalPoiHotel,
  ChargerPointMode,
  LatLng,
  PlanProviderBundle,
  ProviderCallOptions
} from "./corridor/providerContracts";

/**
 * POI-only runtime: corridor chargers and hotels come from POI Services (`corridorCandidates`).
 * Legacy NREL / Overpass / mirror tiers were removed (see deprecate-nrel-overpass-mirror ADR).
 * These stubs remain on the bundle type for any residual call sites; they return empty results.
 */
const emptyChargers = {
  async findChargersNearPoint(
    _point: LatLng,
    _radiusMiles: number,
    _mode: ChargerPointMode,
    _opts?: ProviderCallOptions
  ): Promise<CanonicalCharger[]> {
    return [];
  },
  async findChargersNearRoute(
    _routePoints: LatLng[],
    _corridorMiles: number,
    _mode: ChargerPointMode,
    _opts?: ProviderCallOptions
  ): Promise<CanonicalCharger[]> {
    return [];
  }
};

const emptyPois = {
  async findHolidayInnExpressHotelsNearPoint(
    _point: LatLng,
    _radiusMeters: number,
    _opts?: ProviderCallOptions
  ): Promise<CanonicalPoiHotel[]> {
    return [];
  }
};

const POI_ONLY_META: PlanProviderBundle["meta"] = {
  mode: "poi_only",
  effectiveSourceRoutingMode: "poi_only"
};

function logPlanSourceSelection(requestId: string) {
  if ((process.env.PLAN_LOG_REQUESTS ?? "true").toLowerCase() !== "true") return;
  const deploymentEnv = (process.env.DEPLOYMENT_ENV ?? "dev-local").trim().toLowerCase();
  console.log(
    JSON.stringify({
      event: "plan_source_selection",
      deploymentEnv,
      requestId,
      sourceRoutingMode: "poi_only",
      effectiveSourceRoutingMode: "poi_only",
      chargersTier: "poi_services",
      poisTier: "poi_services"
    })
  );
}

export function resolvePlanProviders(_input: {
  mode?: never;
  requestId: string;
  signal?: AbortSignal;
}): PlanProviderBundle {
  logPlanSourceSelection(_input.requestId);
  return {
    chargers: emptyChargers,
    pois: emptyPois,
    meta: POI_ONLY_META
  };
}

/** Compact JSON for `POST /plan` `debug.sourceRouting` — legacy mirror fields removed. */
export function sourceRoutingDebugFromMeta(meta: PlanProviderBundle["meta"]): Record<string, unknown> {
  return {
    sourceRoutingMode: meta.mode,
    effectiveSourceRoutingMode: meta.effectiveSourceRoutingMode
  };
}
