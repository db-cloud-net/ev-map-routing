import fs from "fs/promises";
import path from "path";

import type {
  CanonicalCharger,
  CanonicalPoiHotel,
  ChargerPointMode,
  ChargerProvider,
  LatLng,
  PoiProvider,
  ProviderCallOptions
} from "./providerContracts";
import { haversineMiles } from "../planner/geo";
import type { SourceError, SourceErrorCode, SourceTier } from "./sourceErrors";
import { SourceErrorImpl } from "./sourceErrors";

type Manifest = {
  snapshotId: string;
  schemaVersion: "1.0.0";
  createdAt: string;
  validation?: { passed?: boolean };
  files: {
    chargers: string;
    poiHotels: string;
  };
};

type LoadedSnapshot = {
  manifest: Manifest;
  chargers: CanonicalCharger[];
  poiHotels: CanonicalPoiHotel[];
};

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envString(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function parseIsoUtc(s: string): number | null {
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function isSourceErrorLike(err: unknown): err is SourceError {
  const e = err as any;
  return Boolean(e && typeof e === "object" && typeof e.code === "string" && typeof e.retryable === "boolean");
}

function computeAgeHours(nowMs: number, createdAtMs: number): number {
  return (nowMs - createdAtMs) / (1000 * 60 * 60);
}

function ndjsonFileKey(filePath: string) {
  return filePath.replace(/\\/g, "/");
}

async function readNdjsonArray<T>(filePath: string): Promise<T[]> {
  const txt = await fs.readFile(filePath, "utf8");
  const lines = txt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: T[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Keep error minimal; validation (B3) is responsible for deep canonical checks.
      throw new Error(`NDJSON parse failed in ${ndjsonFileKey(filePath)}`);
    }
  }
  return out;
}

export class LocalMirrorAdapter
  implements ChargerProvider, PoiProvider
{
  private mirrorRoot: string;
  private maxAgeHours: number;
  private stalePolicy: "fallback_remote" | "fail";
  private deploymentEnv: string;

  private loaded: LoadedSnapshot | null = null;
  private loadedSnapshotId: string | null = null;
  private loading: Promise<LoadedSnapshot> | null = null;
  private lastStalenessLogKey: string | null = null;
  private lastStalenessLogAtMs = 0;

  constructor(opts?: { mirrorRoot?: string }) {
    const mirrorRoot = opts?.mirrorRoot ?? process.env.MIRROR_ROOT ?? "mirror";
    this.mirrorRoot = path.resolve(mirrorRoot);
    this.maxAgeHours = envNumber("MIRROR_MAX_AGE_HOURS", 840);
    const policy = envString("STALE_SNAPSHOT_POLICY", "fallback_remote");
    this.stalePolicy = policy === "fail" ? "fail" : "fallback_remote";
    this.deploymentEnv = (process.env.DEPLOYMENT_ENV ?? "dev-local").trim().toLowerCase();
  }

  private logMirrorStaleness(requestId: string | undefined, manifest: Manifest, ageHours: number | null) {
    const dedupeKey = requestId ? `${requestId}:${manifest.snapshotId}` : null;
    if (dedupeKey && this.lastStalenessLogKey === dedupeKey && Date.now() - this.lastStalenessLogAtMs < 5000) {
      return;
    }
    if (dedupeKey) {
      this.lastStalenessLogKey = dedupeKey;
      this.lastStalenessLogAtMs = Date.now();
    }
    const payload: any = {
      event: "mirror_staleness",
      deploymentEnv: this.deploymentEnv,
      requestId,
      mirrorSnapshotId: manifest.snapshotId,
      mirrorSchemaVersion: manifest.schemaVersion,
      manifestCreatedAt: manifest.createdAt,
      ageHours,
      maxAgeHours: this.maxAgeHours,
      STALE_SNAPSHOT_POLICY: this.stalePolicy
    };
    // Avoid emitting `requestId: undefined` for cleaner logs.
    if (payload.requestId === undefined) delete payload.requestId;
    console.log(JSON.stringify(payload));
  }

  private async loadCurrentSnapshot(opts?: { requestId?: string }): Promise<LoadedSnapshot> {
    const manifestPath = path.join(this.mirrorRoot, "current", "manifest.json");

    let manifest: Manifest;
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      manifest = JSON.parse(raw) as Manifest;
    } catch (err) {
      // Differentiate missing manifest vs unreadable root vs invalid JSON.
      const code = isSourceErrorLike(err) ? err.code : "unknown";
      void code;
      if (err instanceof Error) {
        const msg = err.message.toLowerCase();
        if (msg.includes("no such file") || msg.includes("enonot") || msg.includes("not found")) {
          throw new SourceErrorImpl({
            message: `Mirror manifest missing: ${manifestPath}`,
            code: "MIRROR_MANIFEST_MISSING",
            source: "mirror",
            retryable: false,
            fallbackSuggested: true
          });
        }
        // Treat JSON parse issues as invalid.
        if (msg.includes("json") || err.name === "SyntaxError") {
          throw new SourceErrorImpl({
            message: `Mirror manifest invalid: ${manifestPath}`,
            code: "MIRROR_MANIFEST_INVALID",
            source: "mirror",
            retryable: false,
            fallbackSuggested: true,
            cause: err
          });
        }
      }

      throw new SourceErrorImpl({
        message: `Mirror unavailable: ${manifestPath}`,
        code: "MIRROR_UNAVAILABLE",
        source: "mirror",
        retryable: true,
        fallbackSuggested: true,
        cause: err
      });
    }

    // Basic manifest shape checks (deep canonical validation handled by B3).
    if (!manifest || typeof manifest !== "object") {
      throw new SourceErrorImpl({
        message: "Mirror manifest invalid (missing fields)",
        code: "MIRROR_MANIFEST_INVALID",
        source: "mirror",
        retryable: false,
        fallbackSuggested: true
      });
    }

    if (manifest.schemaVersion !== "1.0.0") {
      throw new SourceErrorImpl({
        message: `Mirror schema mismatch: ${manifest.schemaVersion}`,
        code: "SCHEMA_MISMATCH",
        source: "mirror",
        retryable: false,
        fallbackSuggested: true
      });
    }

    const createdAtMs = parseIsoUtc(manifest.createdAt);
    if (createdAtMs == null) {
      throw new SourceErrorImpl({
        message: "Mirror manifest createdAt invalid",
        code: "MIRROR_MANIFEST_INVALID",
        source: "mirror",
        retryable: false,
        fallbackSuggested: true
      });
    }

    const nowMs = Date.now();
    const ageHours = computeAgeHours(nowMs, createdAtMs);

    // v1 C4 preview: log staleness when mirror is consulted/loaded.
    // (Even if it later throws STALE_SNAPSHOT, it should still be explainable.)
    this.logMirrorStaleness(opts?.requestId, manifest, ageHours);

    if (ageHours > this.maxAgeHours) {
      throw new SourceErrorImpl({
        message: `Mirror snapshot stale: ageHours=${ageHours} maxAgeHours=${this.maxAgeHours}`,
        code: "STALE_SNAPSHOT",
        source: "mirror",
        retryable: false,
        fallbackSuggested: this.stalePolicy === "fallback_remote",
        context: {
          manifestCreatedAt: manifest.createdAt,
          ageHours,
          maxAgeHours: this.maxAgeHours,
          stalePolicy: this.stalePolicy
        }
      });
    }

    if (manifest.validation?.passed === false) {
      throw new SourceErrorImpl({
        message: "Mirror snapshot invalid: manifest.validation.passed=false",
        code: "SNAPSHOT_INVALID",
        source: "mirror",
        retryable: false,
        fallbackSuggested: true,
        context: { snapshotId: manifest.snapshotId }
      });
    }

    const snapshotId = manifest.snapshotId;
    if (this.loadedSnapshotId === snapshotId && this.loaded) return this.loaded;

    const snapshotDir = path.join(this.mirrorRoot, "snapshots", snapshotId);
    const chargersPath = path.join(snapshotDir, manifest.files.chargers);
    const poiHotelsPath = path.join(snapshotDir, manifest.files.poiHotels);

    let chargers: CanonicalCharger[];
    let poiHotels: CanonicalPoiHotel[];
    try {
      chargers = await readNdjsonArray<CanonicalCharger>(chargersPath);
      poiHotels = await readNdjsonArray<CanonicalPoiHotel>(poiHotelsPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message.toLowerCase() : "";
      if (msg.includes("no such file") || msg.includes("not found")) {
        // If one facet missing, treat as artifact missing.
        const isChargersMissing = msg.includes(ndjsonFileKey(chargersPath));
        const code: SourceErrorCode = isChargersMissing
          ? "MIRROR_ARTIFACT_MISSING"
          : "MIRROR_ARTIFACT_MISSING";

        throw new SourceErrorImpl({
          message: `Mirror artifact missing for snapshot ${snapshotId}`,
          code,
          source: "mirror",
          retryable: false,
          fallbackSuggested: true,
          context: { snapshotId }
        });
      }

      throw new SourceErrorImpl({
        message: `Mirror artifact corrupt for snapshot ${snapshotId}`,
        code: "MIRROR_ARTIFACT_CORRUPT",
        source: "mirror",
        retryable: false,
        fallbackSuggested: false,
        cause: err
      });
    }

    const loaded: LoadedSnapshot = { manifest, chargers, poiHotels };
    this.loaded = loaded;
    this.loadedSnapshotId = snapshotId;
    return loaded;
  }

  private async ensureLoaded(opts?: { requestId?: string }): Promise<LoadedSnapshot> {
    if (this.loaded) {
      const createdAtMs = parseIsoUtc(this.loaded.manifest.createdAt);
      const ageHours = createdAtMs == null ? null : computeAgeHours(Date.now(), createdAtMs);
      this.logMirrorStaleness(opts?.requestId, this.loaded.manifest, ageHours);
      return this.loaded;
    }

    if (this.loading) {
      const snap = await this.loading;
      const createdAtMs = parseIsoUtc(snap.manifest.createdAt);
      const ageHours = createdAtMs == null ? null : computeAgeHours(Date.now(), createdAtMs);
      this.logMirrorStaleness(opts?.requestId, snap.manifest, ageHours);
      return snap;
    }

    this.loading = this.loadCurrentSnapshot(opts).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async findChargersNearPoint(
    point: LatLng,
    radiusMiles: number,
    mode: ChargerPointMode,
    opts?: { requestId?: string; signal?: AbortSignal; timeoutMs?: number }
  ): Promise<CanonicalCharger[]> {
    // v1 note: mirror files are v1 snapshots; we do not yet encode power-mode facets
    // separately. For now, ignore `mode` and return chargers from snapshot.
    void mode;
    const snap = await this.ensureLoaded(opts);
    const out = snap.chargers.filter((c) => haversineMiles(point, c.coords) <= radiusMiles);
    // Extra safety: dedupe by id.
    const seen = new Set<string>();
    return out.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
  }

  async findChargersNearRoute(
    routePoints: LatLng[],
    corridorMiles: number,
    mode: ChargerPointMode,
    opts?: ProviderCallOptions
  ): Promise<CanonicalCharger[]> {
    void mode;
    if (routePoints.length < 2) return [];
    const snap = await this.ensureLoaded(opts);
    const out: CanonicalCharger[] = [];
    const seen = new Set<string>();

    for (const c of snap.chargers) {
      for (const rp of routePoints) {
        if (haversineMiles(c.coords, rp) <= corridorMiles) {
          if (!seen.has(c.id)) {
            seen.add(c.id);
            out.push(c);
          }
          break;
        }
      }
    }

    return out;
  }

  async findHolidayInnExpressHotelsNearPoint(
    point: LatLng,
    radiusMeters: number,
    opts?: ProviderCallOptions
  ): Promise<CanonicalPoiHotel[]> {
    const snap = await this.ensureLoaded(opts);
    const radiusMiles = radiusMeters / 1609.34;
    const out = snap.poiHotels.filter((h) => haversineMiles(point, h.coords) <= radiusMiles);
    const seen = new Set<string>();
    return out.filter((h) => {
      if (seen.has(h.id)) return false;
      seen.add(h.id);
      return true;
    });
  }
}

