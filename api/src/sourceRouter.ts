import fs from "fs";
import path from "path";
import type {
  ChargerPointMode,
  MirrorSchemaVersion,
  PlanProviderBundle,
  LatLng,
  PoiProvider,
  ProviderCallOptions,
  SourceRoutingMode
} from "./mirror/providerContracts";
import type { SourceError, SourceErrorCode } from "./mirror/sourceErrors";
import { LocalMirrorAdapter } from "./mirror/localMirrorAdapter";
import { RemoteNrelAdapter } from "./mirror/remoteNrelAdapter";
import { RemoteOverpassAdapter } from "./mirror/remoteOverpassAdapter";
import {
  getC2Approved,
  recordDualReadComparableSample,
  recordDualReadMirrorError
} from "./mirror/c2Gate";

const remoteNrelAdapter = new RemoteNrelAdapter();
const remoteOverpassAdapter = new RemoteOverpassAdapter();
const localMirrorAdapter = new LocalMirrorAdapter();

function parseSourceRoutingMode(raw: string | undefined): SourceRoutingMode {
  const v = (raw ?? "remote_only").trim();
  if (
    v === "remote_only" ||
    v === "local_primary_fallback_remote" ||
    v === "local_primary_fail_closed" ||
    v === "dual_read_compare"
  ) {
    return v;
  }
  return "remote_only";
}

function readMirrorManifestSync(): { snapshotId?: string; schemaVersion?: string; createdAt?: string } {
  try {
    const mirrorRoot = process.env.MIRROR_ROOT ?? "mirror";
    const manifestPath = path.join(mirrorRoot, "current", "manifest.json");
    const raw = fs.readFileSync(manifestPath, "utf8");
    const m = JSON.parse(raw) as {
      snapshotId?: string;
      schemaVersion?: string;
      createdAt?: string;
    };
    return { snapshotId: m.snapshotId, schemaVersion: m.schemaVersion, createdAt: m.createdAt };
  } catch {
    return {};
  }
}

export function resolvePlanProviders(input: {
  mode?: SourceRoutingMode;
  requestId: string;
  signal?: AbortSignal;
}): PlanProviderBundle {
  const configuredMode = input.mode ?? parseSourceRoutingMode(process.env.SOURCE_ROUTING_MODE);
  let effectiveSourceRoutingMode: SourceRoutingMode = configuredMode;

  // C3 rollback override: config/flag-only.
  const forceMode = (process.env.SOURCE_ROUTING_MODE_FORCE ?? "").trim();
  if (forceMode === "remote_only") {
    effectiveSourceRoutingMode = "remote_only";
  } else if (configuredMode === "dual_read_compare" && getC2Approved()) {
    // C2 cutover: once gates are satisfied, switch away from dual-read compare.
    effectiveSourceRoutingMode = "local_primary_fallback_remote";
  }

  // C4: log which tiers were selected for this request (correlate by requestId).
  const usesMirror = effectiveSourceRoutingMode !== "remote_only";
  const chargersTier = usesMirror ? "mirror" : "remote";
  const poisTier = usesMirror ? "mirror" : "remote";

  const mirrorManifest = usesMirror ? readMirrorManifestSync() : {};
  const createdAtMs = mirrorManifest.createdAt ? Date.parse(mirrorManifest.createdAt) : NaN;
  const mirrorAgeHours = Number.isFinite(createdAtMs) ? (Date.now() - createdAtMs) / (1000 * 60 * 60) : undefined;

  logEvent("plan_source_selection", {
    requestId: input.requestId,
    sourceRoutingMode: configuredMode,
    effectiveSourceRoutingMode,
    chargersTier,
    poisTier,
    mirrorSnapshotId: mirrorManifest.snapshotId,
    mirrorSchemaVersion: mirrorManifest.schemaVersion,
    mirrorAgeHours
  });

  if (forceMode === "remote_only") {
    logEvent("rollback_triggered", {
      requestId: input.requestId,
      rollbackTriggered: true,
      rollbackReason: {
        operatorOverride: "SOURCE_ROUTING_MODE_FORCE=remote_only",
        lastKnownSourceRoutingMode: configuredMode
      }
    });
  }

  return {
    chargers: makeChargerProvider(effectiveSourceRoutingMode, input),
    pois: makePoiProvider(effectiveSourceRoutingMode, input),
    meta: {
      mode: configuredMode,
      effectiveSourceRoutingMode,
      ...(usesMirror
        ? {
            mirrorSnapshotId: mirrorManifest.snapshotId,
            mirrorSchemaVersion: mirrorManifest.schemaVersion as MirrorSchemaVersion | undefined,
            mirrorCreatedAt: mirrorManifest.createdAt,
            ...(mirrorAgeHours != null ? { mirrorAgeHours } : {})
          }
        : {})
    }
  };
}

/** Compact JSON for `POST /plan` `debug.sourceRouting` (ROUTING_UX_SPEC §2). */
export function sourceRoutingDebugFromMeta(meta: PlanProviderBundle["meta"]): Record<string, unknown> {
  const o: Record<string, unknown> = {
    sourceRoutingMode: meta.mode,
    effectiveSourceRoutingMode: meta.effectiveSourceRoutingMode
  };
  if (meta.mirrorSnapshotId) o.mirrorSnapshotId = meta.mirrorSnapshotId;
  if (meta.mirrorSchemaVersion) o.mirrorSchemaVersion = meta.mirrorSchemaVersion;
  if (meta.mirrorCreatedAt) o.mirrorCreatedAt = meta.mirrorCreatedAt;
  if (meta.mirrorAgeHours != null) o.mirrorAgeHours = meta.mirrorAgeHours;
  return o;
}

function shouldLogPlan() {
  return (process.env.PLAN_LOG_REQUESTS ?? "true").toLowerCase() === "true";
}

const deploymentEnv = (process.env.DEPLOYMENT_ENV ?? "dev-local").trim().toLowerCase();

function logEvent(
  event: string,
  input: { requestId?: string; [k: string]: unknown }
) {
  if (!shouldLogPlan()) return;
  const { requestId, ...rest } = input;
  console.log(JSON.stringify({ event, deploymentEnv, requestId, ...rest }));
}

function isSourceError(err: unknown): err is SourceError {
  const e = err as any;
  return Boolean(e && typeof e === "object" && typeof e.code === "string");
}

const FALLBACK_ALLOW_LIST: Set<SourceErrorCode> = new Set([
  "MIRROR_UNAVAILABLE",
  "MIRROR_MANIFEST_MISSING",
  "MIRROR_MANIFEST_INVALID",
  "MIRROR_ARTIFACT_MISSING",
  "MIRROR_ARTIFACT_CORRUPT",
  "SCHEMA_MISMATCH",
  "SNAPSHOT_INVALID",
  "STALE_SNAPSHOT"
]);

function withLocalPrimaryFallbackChargers(input: {
  local: any;
  remote: any;
  requestId: string;
}): any {
  return {
    async findChargersNearPoint(
      point: LatLng,
      radiusMiles: number,
      mode: ChargerPointMode,
      opts?: ProviderCallOptions
    ) {
      try {
        return await input.local.findChargersNearPoint(point, radiusMiles, mode, opts);
      } catch (err) {
        if (isSourceError(err) && FALLBACK_ALLOW_LIST.has(err.code) && err.fallbackSuggested !== false) {
          logEvent("plan_fallback", {
            requestId: input.requestId,
            provider: "chargers",
            primaryTier: "mirror",
            fallbackTier: "remote",
            fallbackReason: { code: err.code, source: err.source, retryable: err.retryable }
          });
          return await input.remote.findChargersNearPoint(point, radiusMiles, mode, opts);
        }
        throw err;
      }
    },
    async findChargersNearRoute(
      routePoints: LatLng[],
      corridorMiles: number,
      mode: ChargerPointMode,
      opts?: ProviderCallOptions
    ) {
      try {
        return await input.local.findChargersNearRoute(routePoints, corridorMiles, mode, opts);
      } catch (err) {
        if (isSourceError(err) && FALLBACK_ALLOW_LIST.has(err.code) && err.fallbackSuggested !== false) {
          logEvent("plan_fallback", {
            requestId: input.requestId,
            provider: "chargers",
            primaryTier: "mirror",
            fallbackTier: "remote",
            fallbackReason: { code: err.code, source: err.source, retryable: err.retryable }
          });
          return await input.remote.findChargersNearRoute(routePoints, corridorMiles, mode, opts);
        }
        throw err;
      }
    }
  };
}

function withDualReadCompareChargers(input: {
  local: any;
  remote: any;
  requestId: string;
}): any {
  return {
    async findChargersNearPoint(
      point: LatLng,
      radiusMiles: number,
      mode: ChargerPointMode,
      opts?: ProviderCallOptions
    ) {
      const localT0 = Date.now();
      const remoteT0 = Date.now();

      const localResP = input.local.findChargersNearPoint(point, radiusMiles, mode, opts).then(
        (value: any) => ({
          status: "fulfilled" as const,
          value,
          durationMs: Date.now() - localT0
        }),
        (reason: unknown) => ({
          status: "rejected" as const,
          reason,
          durationMs: Date.now() - localT0
        })
      );

      const remoteResP = input.remote.findChargersNearPoint(point, radiusMiles, mode, opts).then(
        (value: any) => ({
          status: "fulfilled" as const,
          value,
          durationMs: Date.now() - remoteT0
        }),
        (reason: unknown) => ({
          status: "rejected" as const,
          reason,
          durationMs: Date.now() - remoteT0
        })
      );

      const [localRes, remoteRes] = await Promise.all([localResP, remoteResP]);

      const mirrorDurationMs = (localRes as any).durationMs as number | undefined;
      const remoteDurationMs = (remoteRes as any).durationMs as number | undefined;

      if (localRes.status === "fulfilled") {
        if (remoteRes.status === "fulfilled") {
          const compareT0 = Date.now();
          const divergence = computeDivergenceByIdAndCoords(localRes.value, remoteRes.value);
          const mismatchSeverity = classifyDivergence(divergence);
          const compareDurationMs = Date.now() - compareT0;
          recordDualReadComparableSample({ provider: "chargers", mismatchSeverity });
          logEvent("dual_read_compare", {
            requestId: input.requestId,
            provider: "chargers",
            method: "nearPoint",
            mirrorResult: { success: true },
            remoteResult: { success: true },
            mirrorDurationMs: localRes.durationMs,
            remoteDurationMs: remoteRes.durationMs,
            compareDurationMs,
            ...divergence,
            mismatchSeverity
          });
        } else {
          logEvent("dual_read_compare", {
            requestId: input.requestId,
            provider: "chargers",
            method: "nearPoint",
            mirrorResult: { success: true },
            remoteResult: { success: false, errorCode: getErrorCode(remoteRes.reason) },
            mirrorDurationMs: localRes.durationMs,
            remoteDurationMs: remoteRes.durationMs,
            compareDurationMs: 0
          });
        }
        return localRes.value;
      }

      if (remoteRes.status === "fulfilled") {
        recordDualReadMirrorError({
          provider: "chargers",
          mirrorErrorCode: getErrorCode(localRes.reason)
        });
        logEvent("dual_read_compare", {
          requestId: input.requestId,
          provider: "chargers",
          method: "nearPoint",
          mirrorResult: { success: false, errorCode: getErrorCode(localRes.reason) },
          remoteResult: { success: true },
          mirrorDurationMs: localRes.durationMs,
          remoteDurationMs: remoteRes.durationMs,
          compareDurationMs: 0
        });
        return remoteRes.value;
      }

      // Both failed; prefer mirror if it looks more diagnostic.
      throw chooseBestError(localRes.reason, remoteRes.reason);
    },
    async findChargersNearRoute(
      routePoints: LatLng[],
      corridorMiles: number,
      mode: ChargerPointMode,
      opts?: ProviderCallOptions
    ) {
      const localT0 = Date.now();
      const remoteT0 = Date.now();

      const localResP = input.local.findChargersNearRoute(routePoints, corridorMiles, mode, opts).then(
        (value: any) => ({
          status: "fulfilled" as const,
          value,
          durationMs: Date.now() - localT0
        }),
        (reason: unknown) => ({
          status: "rejected" as const,
          reason,
          durationMs: Date.now() - localT0
        })
      );

      const remoteResP = input.remote.findChargersNearRoute(routePoints, corridorMiles, mode, opts).then(
        (value: any) => ({
          status: "fulfilled" as const,
          value,
          durationMs: Date.now() - remoteT0
        }),
        (reason: unknown) => ({
          status: "rejected" as const,
          reason,
          durationMs: Date.now() - remoteT0
        })
      );

      const [localRes, remoteRes] = await Promise.all([localResP, remoteResP]);

      const mirrorDurationMs = (localRes as any).durationMs as number | undefined;
      const remoteDurationMs = (remoteRes as any).durationMs as number | undefined;

      if (localRes.status === "fulfilled") {
        if (remoteRes.status === "fulfilled") {
          const compareT0 = Date.now();
          const divergence = computeDivergenceByIdAndCoords(localRes.value, remoteRes.value);
          const mismatchSeverity = classifyDivergence(divergence);
          const compareDurationMs = Date.now() - compareT0;
          recordDualReadComparableSample({ provider: "chargers", mismatchSeverity });
          logEvent("dual_read_compare", {
            requestId: input.requestId,
            provider: "chargers",
            method: "nearRoute",
            mirrorResult: { success: true },
            remoteResult: { success: true },
            mirrorDurationMs: localRes.durationMs,
            remoteDurationMs: remoteRes.durationMs,
            compareDurationMs,
            ...divergence,
            mismatchSeverity
          });
        } else {
          logEvent("dual_read_compare", {
            requestId: input.requestId,
            provider: "chargers",
            method: "nearRoute",
            mirrorResult: { success: true },
            remoteResult: { success: false, errorCode: getErrorCode(remoteRes.reason) },
            mirrorDurationMs: localRes.durationMs,
            remoteDurationMs: remoteRes.durationMs,
            compareDurationMs: 0
          });
        }
        return localRes.value;
      }

      if (remoteRes.status === "fulfilled") {
        recordDualReadMirrorError({
          provider: "chargers",
          mirrorErrorCode: getErrorCode(localRes.reason)
        });
        logEvent("dual_read_compare", {
          requestId: input.requestId,
          provider: "chargers",
          method: "nearRoute",
          mirrorResult: { success: false, errorCode: getErrorCode(localRes.reason) },
          remoteResult: { success: true },
          mirrorDurationMs: localRes.durationMs,
          remoteDurationMs: remoteRes.durationMs,
          compareDurationMs: 0
        });
        return remoteRes.value;
      }
      throw chooseBestError(localRes.reason, remoteRes.reason);
    }
  };
}

function withLocalPrimaryFallbackPois(input: {
  local: PoiProvider;
  remote: PoiProvider;
  requestId: string;
}): PoiProvider {
  return {
    async findHolidayInnExpressHotelsNearPoint(point, radiusMeters, opts?: ProviderCallOptions) {
      try {
        return await input.local.findHolidayInnExpressHotelsNearPoint(point, radiusMeters, opts);
      } catch (err) {
        if (
          isSourceError(err) &&
          FALLBACK_ALLOW_LIST.has(err.code) &&
          err.fallbackSuggested !== false
        ) {
          logEvent("plan_fallback", {
            requestId: input.requestId,
            provider: "pois",
            primaryTier: "mirror",
            fallbackTier: "remote",
            fallbackReason: { code: err.code, source: err.source, retryable: err.retryable }
          });
          return await input.remote.findHolidayInnExpressHotelsNearPoint(
            point,
            radiusMeters,
            opts
          );
        }
        throw err;
      }
    }
  };
}

function withDualReadComparePois(input: {
  local: PoiProvider;
  remote: PoiProvider;
  requestId: string;
}): PoiProvider {
  return {
    async findHolidayInnExpressHotelsNearPoint(point, radiusMeters, opts?: ProviderCallOptions) {
      const localT0 = Date.now();
      const remoteT0 = Date.now();

      const localResP = input.local.findHolidayInnExpressHotelsNearPoint(point, radiusMeters, opts).then(
        (value: any) => ({
          status: "fulfilled" as const,
          value,
          durationMs: Date.now() - localT0
        }),
        (reason: unknown) => ({
          status: "rejected" as const,
          reason,
          durationMs: Date.now() - localT0
        })
      );

      const remoteResP = input.remote.findHolidayInnExpressHotelsNearPoint(point, radiusMeters, opts).then(
        (value: any) => ({
          status: "fulfilled" as const,
          value,
          durationMs: Date.now() - remoteT0
        }),
        (reason: unknown) => ({
          status: "rejected" as const,
          reason,
          durationMs: Date.now() - remoteT0
        })
      );

      const [localRes, remoteRes] = await Promise.all([localResP, remoteResP]);

      const mirrorDurationMs = (localRes as any).durationMs as number | undefined;
      const remoteDurationMs = (remoteRes as any).durationMs as number | undefined;

      if (localRes.status === "fulfilled") {
        if (remoteRes.status === "fulfilled") {
          const compareT0 = Date.now();
          const divergence = computeDivergenceByIdAndCoords(
            localRes.value,
            remoteRes.value
          );
          const mismatchSeverity = classifyDivergence(divergence);
          const compareDurationMs = Date.now() - compareT0;
          recordDualReadComparableSample({ provider: "pois", mismatchSeverity });
          logEvent("dual_read_compare", {
            requestId: input.requestId,
            provider: "pois",
            method: "nearPoint",
            mirrorResult: { success: true },
            remoteResult: { success: true },
            mirrorDurationMs: localRes.durationMs,
            remoteDurationMs: remoteRes.durationMs,
            compareDurationMs,
            ...divergence,
            mismatchSeverity
          });
        } else {
          logEvent("dual_read_compare", {
            requestId: input.requestId,
            provider: "pois",
            method: "nearPoint",
            mirrorResult: { success: true },
            remoteResult: { success: false, errorCode: getErrorCode(remoteRes.reason) },
            mirrorDurationMs: localRes.durationMs,
            remoteDurationMs: remoteRes.durationMs,
            compareDurationMs: 0
          });
        }
        return localRes.value;
      }

      if (remoteRes.status === "fulfilled") {
        recordDualReadMirrorError({
          provider: "pois",
          mirrorErrorCode: getErrorCode(localRes.reason)
        });
        logEvent("dual_read_compare", {
          requestId: input.requestId,
          provider: "pois",
          method: "nearPoint",
          mirrorResult: { success: false, errorCode: getErrorCode(localRes.reason) },
          remoteResult: { success: true },
          mirrorDurationMs: localRes.durationMs,
          remoteDurationMs: remoteRes.durationMs,
          compareDurationMs: 0
        });
        return remoteRes.value;
      }

      throw chooseBestError(localRes.reason, remoteRes.reason);
    }
  };
}

function makePoiProvider(mode: SourceRoutingMode, input: { requestId: string }): PoiProvider {
  if (mode === "remote_only") return remoteOverpassAdapter;
  if (mode === "local_primary_fallback_remote") {
    return withLocalPrimaryFallbackPois({
      local: localMirrorAdapter,
      remote: remoteOverpassAdapter,
      requestId: input.requestId
    });
  }

  return withDualReadComparePois({
    local: localMirrorAdapter,
    remote: remoteOverpassAdapter,
    requestId: input.requestId
  });
}

function makeChargerProvider(mode: SourceRoutingMode, input: { requestId: string }) {
  if (mode === "remote_only") return remoteNrelAdapter;
  if (mode === "local_primary_fail_closed") return localMirrorAdapter;
  if (mode === "local_primary_fallback_remote") {
    return withLocalPrimaryFallbackChargers({ local: localMirrorAdapter, remote: remoteNrelAdapter, requestId: input.requestId });
  }
  return withDualReadCompareChargers({ local: localMirrorAdapter, remote: remoteNrelAdapter, requestId: input.requestId });
}

function getErrorCode(err: unknown): string | undefined {
  const e = err as any;
  return typeof e?.code === "string" ? e.code : undefined;
}

function chooseBestError(a: unknown, b: unknown) {
  // Prefer mirror errors when they encode mirror/unavailability/stale.
  const ea = a as any;
  const eb = b as any;
  const aCode: unknown = ea?.code;
  const bCode: unknown = eb?.code;
  if (typeof aCode === "string" && String(aCode).startsWith("MIRROR")) return a;
  if (typeof aCode === "string" && aCode === "STALE_SNAPSHOT") return a;
  if (typeof eb?.code === "string" && String(bCode).startsWith("MIRROR")) return b;
  return a ?? b;
}

function computeDivergenceByIdAndCoords<T extends { id: string; coords: { lat: number; lon: number } }>(
  mirror: T[],
  remote: T[]
) {
  const mirrorById = new Map<string, T>(mirror.map((r) => [r.id, r]));
  const remoteById = new Map<string, T>(remote.map((r) => [r.id, r]));
  const ids = new Set<string>([...mirrorById.keys(), ...remoteById.keys()]);
  let intersection = 0;
  let mirrorOnly = 0;
  let remoteOnly = 0;
  let maxCoordDriftMeters = 0;
  let sumCoordDriftMeters = 0;
  let bothCoordsCount = 0;

  const toMeters = (miles: number) => miles * 1609.34;

  for (const id of ids) {
    const m = mirrorById.get(id);
    const r = remoteById.get(id);
    if (m && r) {
      intersection++;
      bothCoordsCount++;
      // cheap haversine approximation via lat/lon degrees (miles)
      const dMiles = haversineMetersBetween(m.coords, r.coords);
      const dMeters = dMiles;
      maxCoordDriftMeters = Math.max(maxCoordDriftMeters, dMeters);
      sumCoordDriftMeters += dMeters;
    } else if (m) {
      mirrorOnly++;
    } else if (r) {
      remoteOnly++;
    }
  }

  const union = ids.size;
  const jaccard = union === 0 ? 1 : intersection / union;
  const avgCoordDriftMeters = bothCoordsCount === 0 ? 0 : sumCoordDriftMeters / bothCoordsCount;

  return {
    idIntersectionCount: intersection,
    idMirrorOnlyCount: mirrorOnly,
    idRemoteOnlyCount: remoteOnly,
    idUnionCount: union,
    jaccard,
    bothCoordsCount,
    maxCoordDriftMeters,
    avgCoordDriftMeters
  };
}

function haversineMetersBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  // Mirror of planner/geo haversineMiles but returning meters.
  const R = 6371000; // meters
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function classifyDivergence(div: {
  jaccard: number;
  idRemoteOnlyCount: number;
  idUnionCount: number;
  maxCoordDriftMeters: number;
}) {
  const remoteOnlyPct = div.idUnionCount === 0 ? 0 : (div.idRemoteOnlyCount / div.idUnionCount) * 100;
  if (div.jaccard < 0.95 || remoteOnlyPct > 2 || div.maxCoordDriftMeters > 2000) return "FAIL";
  if (div.jaccard < 0.99 || remoteOnlyPct > 0.5 || div.maxCoordDriftMeters > 500) return "WARN";
  return "OK";
}

