import fs from "fs/promises";
import path from "path";
import { existsSync } from "fs";

import { RemoteNrelAdapter } from "./remoteNrelAdapter";
import { RemoteOverpassAdapter } from "./remoteOverpassAdapter";
import type {
  CanonicalCharger,
  CanonicalPoiHotel
} from "./providerContracts";
import { SourceErrorImpl } from "./sourceErrors";
import dotenv from "dotenv";

const deploymentEnv = (process.env.DEPLOYMENT_ENV ?? "dev-local").trim().toLowerCase();

type Manifest = {
  snapshotId: string;
  schemaVersion: "1.0.0";
  createdAt: string;
  builtBy: "snapshot-job";
  sourceWindow: Record<string, string | undefined>;
  counts: { chargers: number; poiHotels: number };
  files: { chargers: string; poiHotels: string };
  provenance: {
    nrel: { baseUrl: string; dataset: "alt-fuel-stations" };
    overpass: { baseUrl: string; queryFamily: "holiday-inn-express-hotel" };
  };
  validation: { passed: boolean; warnings: string[]; errors: string[] };
};

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envString(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function toIsoUtc(d: Date) {
  return d.toISOString();
}

function haversineMiles(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 3958.8;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function gridPointsAroundCenter(args: {
  center: { lat: number; lon: number };
  radiusMiles: number;
  stepMiles: number;
}) {
  const { center, radiusMiles, stepMiles } = args;
  const steps = Math.max(1, Math.floor(radiusMiles / stepMiles));
  const latPerMile = 1 / 69.0;
  const lonPerMile = 1 / (69.0 * Math.cos((center.lat * Math.PI) / 180) || 1);

  const pts: Array<{ lat: number; lon: number }> = [];
  for (let i = -steps; i <= steps; i++) {
    for (let j = -steps; j <= steps; j++) {
      const lat = center.lat + i * stepMiles * latPerMile;
      const lon = center.lon + j * stepMiles * lonPerMile;
      const d = haversineMiles(center, { lat, lon });
      if (d <= radiusMiles) pts.push({ lat, lon });
    }
  }
  // Dedupe exact coords (grid points) to avoid redundant calls.
  const seen = new Set<string>();
  return pts.filter((p) => {
    const key = `${p.lat.toFixed(6)}:${p.lon.toFixed(6)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function chargerModeFromEnv(): "dc_fast" | "electric_all" {
  const includeAllElectric =
    (process.env.NREL_INCLUDE_ALL_ELECTRIC_CHARGERS ?? "false").toLowerCase() === "true";
  return includeAllElectric ? "electric_all" : "dc_fast";
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const handle = await fs.open(lockPath, "wx");
  await handle.writeFile(`${process.pid}\n`);
  await handle.close();
  return async () => {
    try {
      await fs.unlink(lockPath);
    } catch {
      // best effort
    }
  };
}

type RefreshStateEnum =
  | "starting"
  | "fetching_nrel"
  | "fetching_overpass"
  | "finalizing_manifest"
  | "validating"
  | "promoting"
  | "archiving"
  | "done"
  | "failed";

type RefreshStateFile = {
  snapshotId: string;
  state: RefreshStateEnum;
  createdAt: string;
  updatedAt: string;
  stageDurationsMs?: Record<string, number>;
  lastError?: {
    message: string;
    code?: string;
    source?: string;
    facet?: string;
  };
};

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function countNdjsonLines(p: string): Promise<number> {
  const txt = await fs.readFile(p, "utf8");
  return txt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean).length;
}

async function writeRefreshState(args: {
  snapshotDir: string;
  snapshotId: string;
  state: RefreshStateEnum;
  createdAtIso: string;
  stageDurationsMs?: Record<string, number>;
  lastError?: RefreshStateFile["lastError"];
}): Promise<void> {
  const statePath = path.join(args.snapshotDir, "refresh.state.json");
  const payload: RefreshStateFile = {
    snapshotId: args.snapshotId,
    state: args.state,
    createdAt: args.createdAtIso,
    updatedAt: new Date().toISOString(),
    stageDurationsMs: args.stageDurationsMs,
    lastError: args.lastError
  };
  await fs.writeFile(statePath, JSON.stringify(payload, null, 2), "utf8");
}

async function validateSnapshotForB3(args: {
  manifest: Manifest;
  snapshotDir: string;
}): Promise<Manifest["validation"]> {
  const warnings: string[] = [];
  const errors: string[] = [];

  // Basic manifest checks
  if (args.manifest.schemaVersion !== "1.0.0") errors.push("schemaVersion mismatch");
  if (!args.manifest.createdAt) errors.push("createdAt missing");

  // Promotion-time freshness gate (B3)
  const createdAtMs = Date.parse(args.manifest.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    errors.push("createdAt unparsable");
  } else {
    const maxAgeHours = envNumber("MIRROR_MAX_AGE_HOURS", 840);
    const ageHours = (Date.now() - createdAtMs) / (1000 * 60 * 60);
    if (ageHours > maxAgeHours) {
      errors.push(`STALE_SNAPSHOT: ageHours=${ageHours.toFixed(2)} > maxAgeHours=${maxAgeHours}`);
    }
  }

  const chargersPath = path.join(args.snapshotDir, args.manifest.files.chargers);
  const poisPath = path.join(args.snapshotDir, args.manifest.files.poiHotels);

  const chargersTxt = await fs.readFile(chargersPath, "utf8");
  const chargersLines = chargersTxt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const chargerIds = new Set<string>();
  for (const line of chargersLines) {
    try {
      const rec = JSON.parse(line) as CanonicalCharger;
      if (rec.entityType !== "charger") errors.push("non-charger record in chargers.ndjson");
      if (!rec.id || !rec.id.startsWith("nrel:")) errors.push("charger id invalid/missing");
      if (rec.source !== "nrel") errors.push("charger source must be nrel");
      if (typeof rec.coords?.lat !== "number" || typeof rec.coords?.lon !== "number")
        errors.push("charger coords invalid");
      if (typeof rec.coords?.lat === "number") {
        if (rec.coords.lat < -90 || rec.coords.lat > 90) errors.push("charger coords lat out of range");
      }
      if (typeof rec.coords?.lon === "number") {
        if (rec.coords.lon < -180 || rec.coords.lon > 180) errors.push("charger coords lon out of range");
      }
      if (chargerIds.has(rec.id)) errors.push(`duplicate charger id: ${rec.id}`);
      chargerIds.add(rec.id);
    } catch {
      errors.push("failed to parse charger NDJSON line");
    }
  }

  const poisTxt = await fs.readFile(poisPath, "utf8");
  const poisLines = poisTxt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const poiIds = new Set<string>();
  for (const line of poisLines) {
    try {
      const rec = JSON.parse(line) as CanonicalPoiHotel;
      if (rec.entityType !== "poi_hotel") errors.push("non-poi_hotel record in poi_hotels.ndjson");
      if (!rec.id || !rec.id.startsWith("overpass:")) errors.push("poi id invalid/missing");
      if (rec.source !== "overpass") errors.push("poi source must be overpass");
      if (rec.tourism !== "hotel") errors.push("poi tourism must be hotel");
      if (typeof rec.coords?.lat !== "number" || typeof rec.coords?.lon !== "number")
        errors.push("poi coords invalid");
      if (typeof rec.coords?.lat === "number") {
        if (rec.coords.lat < -90 || rec.coords.lat > 90) errors.push("poi coords lat out of range");
      }
      if (typeof rec.coords?.lon === "number") {
        if (rec.coords.lon < -180 || rec.coords.lon > 180) errors.push("poi coords lon out of range");
      }
      if (poiIds.has(rec.id)) errors.push(`duplicate poi id: ${rec.id}`);
      poiIds.add(rec.id);
    } catch {
      errors.push("failed to parse poi NDJSON line");
    }
  }

  // Counts consistency check (warn, not fail).
  const chargersCount = chargerIds.size;
  const poiHotelsCount = poiIds.size;
  if (args.manifest.counts.chargers !== chargersCount) {
    warnings.push("manifest.counts.chargers mismatch");
  }
  if (args.manifest.counts.poiHotels !== poiHotelsCount) {
    warnings.push("manifest.counts.poiHotels mismatch");
  }

  return { passed: errors.length === 0, warnings, errors };
}

export async function refreshMirrorSnapshot(): Promise<void> {
  // Load the repo-root `.env` so refresh jobs can access `NREL_API_KEY`, etc.
  const cwdEnvPath = path.join(process.cwd(), ".env");
  const fallbackRepoRoot1 = path.resolve(__dirname, "../../../");
  const fallbackEnvPath1 = path.join(fallbackRepoRoot1, ".env");
  const fallbackRepoRoot2 = path.resolve(__dirname, "../../../../");
  const fallbackEnvPath2 = path.join(fallbackRepoRoot2, ".env");
  const envPath = existsSync(cwdEnvPath)
    ? cwdEnvPath
    : existsSync(fallbackEnvPath1)
      ? fallbackEnvPath1
      : fallbackEnvPath2;
  dotenv.config({ path: envPath });

  const mirrorRoot = envString("MIRROR_ROOT", "mirror");
  const snapshotsDir = path.join(mirrorRoot, "snapshots");
  const currentDir = path.join(mirrorRoot, "current");
  const currentManifestPath = path.join(currentDir, "manifest.json");
  const lockPath = path.join(currentDir, "refresh.lock");

  await fs.mkdir(snapshotsDir, { recursive: true });
  await fs.mkdir(currentDir, { recursive: true });

  const now = new Date();
  const snapshotId =
    process.env.MIRROR_SNAPSHOT_ID ?? now.toISOString().replace(/[:.]/g, "-");

  const centerLat = envNumber("MIRROR_SEED_CENTER_LAT", 35.2271);
  const centerLon = envNumber("MIRROR_SEED_CENTER_LON", -80.8431);
  const seedRadiusMiles = envNumber("MIRROR_SEED_RADIUS_MILES", 60);
  const seedStepMiles = envNumber("MIRROR_SEED_STEP_MILES", 20);
  const hotelQueryRadiusMeters = envNumber(
    "MIRROR_HOTEL_QUERY_RADIUS_METERS",
    1200
  );

  const chargerMode = chargerModeFromEnv();

  const snapshotDir = path.join(snapshotsDir, snapshotId);
  const chargersNdjson = path.join(snapshotDir, "chargers.ndjson");
  const poisNdjson = path.join(snapshotDir, "poi_hotels.ndjson");
  const manifestPath = path.join(snapshotDir, "manifest.json");

  const releaseLock = await acquireLock(lockPath);

  try {
    const snapshotJobCreatedAtIso = new Date().toISOString();
    await fs.mkdir(snapshotDir, { recursive: true });
    const stageDurationsMs: Record<string, number> = {};
    let previousSnapshotId: string | null = null;
    try {
      const rawCurrent = await fs.readFile(currentManifestPath, "utf8");
      const currentManifest = JSON.parse(rawCurrent) as Manifest;
      previousSnapshotId = currentManifest.snapshotId;
    } catch {
      // ignore (no active snapshot yet)
    }

    // Restart resume (v1): if a prior run died mid-facet, force-rewrite that facet.
    const existingStatePath = path.join(snapshotDir, "refresh.state.json");
    if (await fileExists(existingStatePath)) {
      try {
        const rawState = await fs.readFile(existingStatePath, "utf8");
        const existingState = JSON.parse(rawState) as RefreshStateFile;
        if (existingState.state === "fetching_nrel") {
          await fs.rm(chargersNdjson, { force: true });
        }
        if (existingState.state === "fetching_overpass") {
          await fs.rm(poisNdjson, { force: true });
        }
      } catch {
        // ignore corrupted state; we'll proceed based on artifact existence.
      }
    }

    await writeRefreshState({
      snapshotDir,
      snapshotId,
      state: "starting",
      createdAtIso: snapshotJobCreatedAtIso,
      stageDurationsMs
    });

    // If this candidate snapshot was previously validated successfully,
    // allow reruns to skip fetch + validation and go straight to promotion.
    if (await fileExists(manifestPath)) {
      try {
        const raw = await fs.readFile(manifestPath, "utf8");
        const existing = JSON.parse(raw) as Manifest;
        if (existing?.validation?.passed === true) {
          await writeRefreshState({
            snapshotDir,
            snapshotId,
            state: "promoting",
            createdAtIso: snapshotJobCreatedAtIso,
            stageDurationsMs
          });

          const tmpPath = path.join(currentDir, `manifest.json.tmp-${snapshotId}`);
          await fs.writeFile(tmpPath, JSON.stringify(existing, null, 2), "utf8");
          try {
            await fs.rename(tmpPath, currentManifestPath);
          } catch {
            await fs.unlink(currentManifestPath).catch(() => undefined);
            await fs.rename(tmpPath, currentManifestPath);
          }

          await writeRefreshState({
            snapshotDir,
            snapshotId,
            state: "done",
            createdAtIso: snapshotJobCreatedAtIso,
            stageDurationsMs
          });
          return;
        }
      } catch {
        // Treat invalid existing state as rewrite.
      }
    }

    const nrel = new RemoteNrelAdapter();
    const overpass = new RemoteOverpassAdapter();

    const points = gridPointsAroundCenter({
      center: { lat: centerLat, lon: centerLon },
      radiusMiles: seedRadiusMiles,
      stepMiles: seedStepMiles
    });

    // v1 knob: in this repo we often allow a partially-empty POI facet when
    // Overpass is rate-limited/flaky; planner can still run without overnight insertion.
    const allowOverpassNonFatal =
      (process.env.MIRROR_ALLOW_OVERPASS_FAILURE_NONFATAL ?? "true").toLowerCase() === "true";

    let chargerById: Map<string, CanonicalCharger> | null = null;
    let poiById: Map<string, CanonicalPoiHotel> | null = null;

    let nrelStartedAt = Date.now();
    let nrelCompletedAt = nrelStartedAt;
    let overpassStartedAt = Date.now();
    let overpassCompletedAt = overpassStartedAt;
    let overpassWarning: string | null = null;

    // Fetch chargers (or reuse if artifact already exists).
    if (!(await fileExists(chargersNdjson))) {
      await writeRefreshState({
        snapshotDir,
        snapshotId,
        state: "fetching_nrel",
        createdAtIso: snapshotJobCreatedAtIso,
        stageDurationsMs
      });

      chargerById = new Map<string, CanonicalCharger>();
      nrelStartedAt = Date.now();
      for (const p of points) {
        const chargers = await nrel.findChargersNearPoint(
          p,
          seedRadiusMiles,
          chargerMode,
          { timeoutMs: envNumber("NREL_FETCH_TIMEOUT_MS", 60000) }
        );
        for (const c of chargers) chargerById.set(c.id, c);
      }
      nrelCompletedAt = Date.now();
      stageDurationsMs["fetch_nrel_ms"] = nrelCompletedAt - nrelStartedAt;

      await fs.writeFile(
        chargersNdjson,
        Array.from(chargerById.values())
          .map((c) => JSON.stringify(c))
          .join("\n") + "\n",
        "utf8"
      );
    }

    // Fetch hotels (or reuse if artifact already exists).
    if (!(await fileExists(poisNdjson))) {
      await writeRefreshState({
        snapshotDir,
        snapshotId,
        state: "fetching_overpass",
        createdAtIso: snapshotJobCreatedAtIso,
        stageDurationsMs
      });

      poiById = new Map<string, CanonicalPoiHotel>();
      overpassStartedAt = Date.now();
      try {
        for (const p of points) {
          const hotels = await overpass.findHolidayInnExpressHotelsNearPoint(
            p,
            hotelQueryRadiusMeters,
            { timeoutMs: envNumber("OVERPASS_FETCH_TIMEOUT_MS", 60000) }
          );
          for (const h of hotels) poiById.set(h.id, h);
        }
        overpassCompletedAt = Date.now();
      } catch (err) {
        overpassCompletedAt = Date.now();
        const msg = err instanceof Error ? err.message : String(err);
        overpassWarning = `overpass_fetch_failed_nonfatal: ${msg}`;
        if (!allowOverpassNonFatal) throw err;
      }
      stageDurationsMs["fetch_overpass_ms"] = overpassCompletedAt - overpassStartedAt;

      await fs.writeFile(
        poisNdjson,
        Array.from(poiById.values())
          .map((h) => JSON.stringify(h))
          .join("\n") + "\n",
        "utf8"
      );
    } else {
      // Reused facet: still keep timestamps for sourceWindow.
      // (v1: best-effort, not exact.)
      overpassCompletedAt = overpassStartedAt;
      poiById = null;
    }

    const chargersCount = await countNdjsonLines(chargersNdjson);
    const poisCount = await countNdjsonLines(poisNdjson);

    const manifest: Manifest = {
      snapshotId,
      schemaVersion: "1.0.0",
      createdAt: toIsoUtc(now),
      builtBy: "snapshot-job",
      sourceWindow: {
        nrelStartedAt: toIsoUtc(new Date(nrelStartedAt)),
        nrelCompletedAt: toIsoUtc(new Date(nrelCompletedAt)),
        overpassStartedAt: toIsoUtc(new Date(overpassStartedAt)),
        overpassCompletedAt: toIsoUtc(new Date(overpassCompletedAt))
      },
      counts: {
        chargers: chargersCount,
        poiHotels: poisCount
      },
      files: {
        chargers: "chargers.ndjson",
        poiHotels: "poi_hotels.ndjson"
      },
      provenance: {
        nrel: {
          baseUrl:
            process.env.NREL_BASE_URL ??
            "https://developer.nrel.gov/api/alt-fuel-stations/v1/nearest.json",
          dataset: "alt-fuel-stations"
        },
        overpass: {
          baseUrl: process.env.OVERPASS_BASE_URL ?? "https://overpass-api.de/api/interpreter",
          queryFamily: "holiday-inn-express-hotel"
        }
      },
      validation: {
        passed: false,
        warnings: [],
        errors: []
      }
    };

    if (overpassWarning) manifest.validation.warnings.push(overpassWarning);

    await writeRefreshState({
      snapshotDir,
      snapshotId,
      state: "finalizing_manifest",
      createdAtIso: snapshotJobCreatedAtIso,
      stageDurationsMs
    });

    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    await writeRefreshState({
      snapshotDir,
      snapshotId,
      state: "validating",
      createdAtIso: snapshotJobCreatedAtIso,
      stageDurationsMs
    });

    const validation = await validateSnapshotForB3({ manifest, snapshotDir });
    manifest.validation = validation;
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    if (!manifest.validation.passed) {
      await writeRefreshState({
        snapshotDir,
        snapshotId,
        state: "failed",
        createdAtIso: snapshotJobCreatedAtIso,
        stageDurationsMs,
        lastError: {
          message: `Snapshot validation failed (${validation.errors.length} errors)`,
          code: "SNAPSHOT_INVALID"
        }
      });
      throw new SourceErrorImpl({
        message: `Snapshot validation failed (${validation.errors.length} errors)`,
        code: "SNAPSHOT_INVALID",
        source: "mirror",
        retryable: false,
        fallbackSuggested: false,
        context: {
          snapshotId,
          errors: validation.errors.slice(0, 10)
        }
      });
    }

    await writeRefreshState({
      snapshotDir,
      snapshotId,
      state: "promoting",
      createdAtIso: snapshotJobCreatedAtIso,
      stageDurationsMs
    });

    // Atomic promotion: write temp, then rename over current/manifest.json
    const tmpPath = path.join(currentDir, `manifest.json.tmp-${snapshotId}`);
    await fs.writeFile(tmpPath, JSON.stringify(manifest, null, 2), "utf8");

    try {
      await fs.rename(tmpPath, currentManifestPath);
    } catch (err) {
      // Windows often doesn't replace existing files on rename. Fallback to unlink+rename.
      await fs.unlink(currentManifestPath).catch(() => undefined);
      await fs.rename(tmpPath, currentManifestPath);
    }

    await writeRefreshState({
      snapshotDir,
      snapshotId,
      state: "archiving",
      createdAtIso: snapshotJobCreatedAtIso,
      stageDurationsMs
    });

    // Retention: keep last N snapshots by mtime; always keep the newly promoted one.
    const keepLastRaw = process.env.MIRROR_SNAPSHOT_KEEP_LAST ?? "2";
    const keepLast = Math.max(1, Number(keepLastRaw) || 2);

    const entries = await fs.readdir(snapshotsDir, { withFileTypes: true });
    const snapshotDirs = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const full = path.join(snapshotsDir, e.name);
          const st = await fs.stat(full);
          return { name: e.name, mtimeMs: st.mtimeMs };
        })
    );
    snapshotDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const keepSet = new Set<string>([snapshotId]);
    if (previousSnapshotId) keepSet.add(previousSnapshotId);
    for (const sd of snapshotDirs.slice(0, keepLast)) keepSet.add(sd.name);

    for (const sd of snapshotDirs) {
      if (keepSet.has(sd.name)) continue;
      const toDelete = path.join(snapshotsDir, sd.name);
      await fs.rm(toDelete, { recursive: true, force: true });
    }

    await writeRefreshState({
      snapshotDir,
      snapshotId,
      state: "done",
      createdAtIso: snapshotJobCreatedAtIso,
      stageDurationsMs
    });
  } finally {
    await releaseLock();
  }
}

if (require.main === module) {
  refreshMirrorSnapshot()
    .then(() => {
      console.log(
        JSON.stringify({
          event: "mirror_refresh_done",
          deploymentEnv,
          mirrorRoot: process.env.MIRROR_ROOT ?? "mirror"
        })
      );
    })
    .catch((err) => {
      console.error(
        JSON.stringify({
          event: "mirror_refresh_failed",
          deploymentEnv,
          error: err instanceof Error ? err.message : String(err)
        })
      );
      process.exit(1);
    });
}

