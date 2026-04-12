import express from "express";
import http from "http";
import { z } from "zod";
import { randomUUID } from "crypto";
import { execSync } from "child_process";
import { planTrip, planTripCandidatesOnly } from "./planner/planTrip";
import {
  appendPlanJobCheckpoint,
  completePlanJob,
  createPlanJob,
  failPlanJob,
  getPlanJob,
  subscribePlanJobStream
} from "./planJobStore";
import { buildRoutePreviewSingleLeg } from "./planner/routePreview";
import { withTimeout } from "./planTimeout";
import { ProviderCallMetrics, runPlanWithProviderMetrics } from "./services/providerCallMetrics";
import {
  isPoiServicesCorridorEnabled,
  postCorridorQuery
} from "./services/poiServicesClient";
import type { PoiServicesPoi } from "./services/poiServicesTypes";
import path from "path";
import { existsSync } from "fs";

import dotenv from "dotenv";

/**
 * Find repo-root `.env` whether you start from workspace root (`npm -w api run start`),
 * from `api/`, or run compiled `node dist/api/src/server.js` (deep `__dirname`).
 * A shallow `../..` from dist is **not** the repo root — that missed `.env` and caused empty config.
 */
function findEnvFilePath(): string | undefined {
  const candidates: string[] = [];
  const push = (p: string) => {
    const n = path.normalize(path.resolve(p));
    if (!candidates.includes(n)) candidates.push(n);
  };

  push(path.join(process.cwd(), ".env"));
  push(path.join(process.cwd(), "..", ".env"));

  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    push(path.join(dir, ".env"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Smoke / E2E scripts spawn the API with `PORT=<ephemeral>` and scenario vars (`DEPLOYMENT_ENV`, `CORS_ORIGIN`, …).
 * Repo `.env` often sets `PORT=3001` and `DEPLOYMENT_ENV=dev-local`; `dotenv.config({ override: true })` would
 * overwrite those and break health checks + CORS scenarios. Parent sets `E2E_SPAWN_PORT` (same as `PORT`);
 * we snapshot spawn-controlled keys **before** dotenv and restore them after.
 */
const e2eSpawnPortLock = process.env.E2E_SPAWN_PORT?.trim();
const e2eKeysToRestore = [
  "PORT",
  "DEPLOYMENT_ENV",
  "CORS_ORIGIN",
  "PLAN_LOG_REQUESTS",
  "PLAN_TOTAL_TIMEOUT_MS",
  "POI_SERVICES_BASE_URL"
] as const;
const e2eEnvSnapshot: Partial<Record<(typeof e2eKeysToRestore)[number], string>> = {};
if (e2eSpawnPortLock && /^\d+$/.test(e2eSpawnPortLock)) {
  for (const k of e2eKeysToRestore) {
    const v = process.env[k];
    if (v !== undefined) e2eEnvSnapshot[k] = v;
  }
}

const envPath = findEnvFilePath();
if (envPath) {
  // Prefer values from the file when the shell has stale/empty vars.
  dotenv.config({ path: envPath, override: true });
} else {
  dotenv.config();
}

if (e2eSpawnPortLock && /^\d+$/.test(e2eSpawnPortLock)) {
  const p = Number(e2eSpawnPortLock);
  if (p >= 1 && p <= 65535) {
    for (const [k, v] of Object.entries(e2eEnvSnapshot)) {
      process.env[k] = v;
    }
    process.env.PORT = e2eSpawnPortLock;
  }
}

const deploymentEnv = (process.env.DEPLOYMENT_ENV ?? "dev-local").trim().toLowerCase();
if (envPath && deploymentEnv !== "production" && deploymentEnv !== "prod") {
  console.log(`[env] loaded ${envPath}`);
}
console.log(
  JSON.stringify({
    event: "auto_waypoints_config",
    deploymentEnv,
    enabled: (process.env.ENABLE_AUTO_WAYPOINTS ?? "false").toLowerCase() === "true",
    thresholdMi: Number(process.env.AUTO_WAYPOINT_THRESHOLD_MI ?? "500")
  })
);
console.log(
  JSON.stringify({
    event: "poi_corridor_config",
    poiCorridorEnabled: isPoiServicesCorridorEnabled()
  })
);

const isProdDeployment =
  deploymentEnv === "production" || deploymentEnv === "prod";
// E2E spawns (e.g. CORS scenarios) set E2E_SPAWN_PORT without a real POI stack — skip fatal.
if (
  isProdDeployment &&
  !isPoiServicesCorridorEnabled() &&
  !(e2eSpawnPortLock && /^\d+$/.test(e2eSpawnPortLock))
) {
  console.error(
    "[fatal] Production requires POI_SERVICES_BASE_URL (and corridor enabled) for trip planning."
  );
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// Allow the web frontend (Next.js) to call this API.
// We handle CORS preflight (OPTIONS) explicitly so browsers can POST JSON.
//
// Behavior:
// - dev-local: reflect the incoming `Origin` header to avoid hardcoding WSL IPs.
// - production: strict allowlist via `CORS_ORIGIN` (or `*`).
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const corsOrigin = (process.env.CORS_ORIGIN ?? "").trim();
  const isProduction = deploymentEnv === "production" || deploymentEnv === "prod";

  if (!isProduction) {
    // For dev-like environments, allow the browser-provided origin.
    // If Origin is missing (same-origin requests), fall back to configured/default.
    const fallback = corsOrigin || "http://localhost:3000";
    res.setHeader("Access-Control-Allow-Origin", origin ?? fallback);
  } else {
    // In production, only allow the explicit origin. If it doesn't match, omit the header
    // so the browser blocks the request (fails the preflight access-control check).
    if (corsOrigin === "*") {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (origin && corsOrigin && origin === corsOrigin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    debug: {
      cwd: process.cwd(),
      poiCorridorEnabled: isPoiServicesCorridorEnabled()
    }
  });
});

const latLngSchema = z.object({
  lat: z.number(),
  lon: z.number()
});

const replanFromSchema = z.union([
  z.object({ coords: latLngSchema }),
  z.object({ stopId: z.string().min(1).max(200) })
]);

const itineraryStopSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(["start", "charge", "sleep", "end", "waypoint"]),
  name: z.string().max(500),
  coords: latLngSchema,
  etaMinutesFromStart: z.number().optional(),
  meta: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional()
});

const planSchema = z
  .object({
    start: z.string().max(200).optional(),
    end: z.string().min(1).max(200),
    waypoints: z.array(z.string().min(1).max(200)).max(24).optional(),
    includeCandidates: z.boolean().optional(),
    lockedChargersByLeg: z
      .array(z.array(z.string().min(1).max(200)).max(24))
      .max(24)
      .optional(),
    lockedHotelId: z.string().min(1).max(200).optional(),
    replanFrom: replanFromSchema.optional(),
    previousStops: z.array(itineraryStopSchema).max(200).optional(),
    /** When true, respond **202** with `jobId` and run planning in the background; poll `GET /plan/jobs/:jobId`. */
    planJob: z.boolean().optional(),
    /** Multi-waypoint: minimize haversine leg-sum proxy order (time-budgeted); ignored with locks or replan. */
    optimizeWaypointOrder: z.boolean().optional()
  })
  .superRefine((data, ctx) => {
    const hasStart = (data.start ?? "").trim().length > 0;
    const hasReplan = data.replanFrom != null;
    if (!hasStart && !hasReplan) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Exactly one of start (non-empty) or replanFrom is required.",
        path: ["start"]
      });
    }
    if (hasStart && hasReplan) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Cannot send both start and replanFrom.",
        path: ["replanFrom"]
      });
    }
    if (data.replanFrom && "stopId" in data.replanFrom && !data.previousStops?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "previousStops is required when replanFrom.stopId is set.",
        path: ["previousStops"]
      });
    }
  });

const candidatesSchema = z
  .object({
    start: z.string().max(200).optional(),
    end: z.string().min(1).max(200),
    waypoints: z.array(z.string().min(1).max(200)).max(24).optional(),
    replanFrom: replanFromSchema.optional(),
    previousStops: z.array(itineraryStopSchema).max(200).optional()
  })
  .superRefine((data, ctx) => {
    const hasStart = (data.start ?? "").trim().length > 0;
    const hasReplan = data.replanFrom != null;
    if (!hasStart && !hasReplan) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Exactly one of start (non-empty) or replanFrom is required.",
        path: ["start"]
      });
    }
    if (hasStart && hasReplan) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Cannot send both start and replanFrom.",
        path: ["replanFrom"]
      });
    }
    if (data.replanFrom && "stopId" in data.replanFrom && !data.previousStops?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "previousStops is required when replanFrom.stopId is set.",
        path: ["previousStops"]
      });
    }
  });

const routePreviewSchema = z
  .object({
    start: z.string().min(1).max(200),
    end: z.string().min(1).max(200),
    waypoints: z.array(z.string().min(1).max(200)).max(24).optional()
  })
  .superRefine((data, ctx) => {
    if (data.waypoints && data.waypoints.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "route-preview v1 supports single-leg trips only (omit waypoints).",
        path: ["waypoints"]
      });
    }
  });

app.post("/route-preview", async (req, res) => {
  const requestId =
    (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
  const startedAt = Date.now();
  const responseVersion = "v2-1-route-preview";
  let providerMetrics: ProviderCallMetrics | undefined;

  try {
    const parsed = routePreviewSchema.parse(req.body);
    console.log(
      JSON.stringify({
        event: "route_preview_request_start",
        deploymentEnv,
        requestId,
        responseVersion,
        start: parsed.start,
        end: parsed.end
      })
    );
    const totalMs = Number(process.env.ROUTE_PREVIEW_TOTAL_TIMEOUT_MS ?? "90000");
    providerMetrics = new ProviderCallMetrics();
    const result = await runPlanWithProviderMetrics(providerMetrics, async () =>
      withTimeout(
        buildRoutePreviewSingleLeg({
          requestId,
          start: parsed.start,
          end: parsed.end
        }),
        totalMs,
        `Route preview exceeded time limit (${totalMs}ms). Try a shorter corridor or retry later.`
      )
    );
    console.log(
      JSON.stringify({
        event: "route_preview_request_end",
        deploymentEnv,
        requestId,
        responseVersion,
        status: result.status,
        durationMs: Date.now() - startedAt,
        previewManeuvers: result.preview?.horizon.maneuvers.length ?? 0,
        previewNextManeuvers: result.preview?.nextHorizon?.maneuvers.length ?? 0
      })
    );
    res.status(result.status === "ok" ? 200 : 400).json({
      ...result,
      debug: providerMetrics.toDebugPayload()
    });
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      /exceeded time limit|timed out|ECONNABORTED/i.test(err.message);
    console.log(
      JSON.stringify({
        event: "route_preview_request_error",
        deploymentEnv,
        requestId,
        responseVersion,
        durationMs: Date.now() - startedAt,
        message: err instanceof Error ? err.message : String(err),
        timeout: isTimeout
      })
    );
    const msg =
      err instanceof Error ? err.message : "Unexpected error building route preview";
    const statusCode = isTimeout ? 408 : 400;
    const errorDebug = {
      ...(isTimeout ? { reason: "route_preview_timeout" } : {}),
      ...(providerMetrics?.toDebugPayload() ?? {})
    };
    res.status(statusCode).json({
      requestId,
      responseVersion,
      status: "error",
      message: msg,
      debug: Object.keys(errorDebug).length > 0 ? errorDebug : undefined
    });
  }
});

app.post("/candidates", async (req, res) => {
  const requestId =
    (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
  const startedAt = Date.now();
  const responseVersion = "v2-1-candidates";
  let providerMetrics: ProviderCallMetrics | undefined;

  try {
    const parsed = candidatesSchema.parse(req.body);
    const replanLog =
      parsed.replanFrom == null
        ? null
        : "coords" in parsed.replanFrom
          ? { mode: "coords" as const }
          : { mode: "stopId" as const, stopId: parsed.replanFrom.stopId };
    console.log(
      JSON.stringify({
        event: "candidates_request_start",
        deploymentEnv,
        requestId,
        responseVersion,
        startTextPresent: Boolean(parsed.start?.trim()),
        end: parsed.end,
        waypointsCount: parsed.waypoints?.length ?? 0,
        replanFrom: replanLog,
        previousStopsCount: parsed.previousStops?.length ?? 0
      })
    );
    const totalMs = Number(process.env.PLAN_TOTAL_TIMEOUT_MS ?? 300000);
    providerMetrics = new ProviderCallMetrics();
    const result = await runPlanWithProviderMetrics(providerMetrics, async () =>
      withTimeout(
        planTripCandidatesOnly({
          requestId,
          responseVersion,
          start: parsed.start?.trim() ? parsed.start : undefined,
          end: parsed.end,
          waypoints: parsed.waypoints,
          replanFrom: parsed.replanFrom,
          previousStops: parsed.previousStops
        }),
        totalMs,
        `Candidates request exceeded time limit (${totalMs}ms). Try a shorter corridor or retry later.`
      )
    );
    console.log(
      JSON.stringify({
        event: "candidates_request_end",
        deploymentEnv,
        requestId,
        responseVersion,
        status: result.status,
        durationMs: Date.now() - startedAt,
        chargerCandidates: result.candidates?.chargers?.length ?? 0,
        hotelCandidates: result.candidates?.hotels?.length ?? 0
      })
    );
    res.status(result.status === "ok" ? 200 : 400).json({
      ...result,
      debug: {
        ...(result.debug ?? {}),
        ...providerMetrics.toDebugPayload()
      }
    });
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      /exceeded time limit|timed out|ECONNABORTED/i.test(err.message);
    console.log(
      JSON.stringify({
        event: "candidates_request_error",
        deploymentEnv,
        requestId,
        responseVersion,
        durationMs: Date.now() - startedAt,
        message: err instanceof Error ? err.message : String(err),
        timeout: isTimeout
      })
    );
    const msg =
      err instanceof Error ? err.message : "Unexpected error fetching candidates";
    const statusCode = isTimeout ? 408 : 400;
    const errorDebug = {
      ...(isTimeout ? { reason: "planner_timeout" } : {}),
      ...(providerMetrics?.toDebugPayload() ?? {})
    };
    res.status(statusCode).json({
      requestId,
      responseVersion,
      status: "error",
      message: msg,
      debug: Object.keys(errorDebug).length > 0 ? errorDebug : undefined
    });
  }
});

const corridorPoisSchema = z.object({
  shape: z.array(latLngSchema).min(2).max(5000),
  corridor_radius_mi: z.number().positive().max(500),
  poi_type: z.enum(["accommodation", "charger", "all"]),
  network: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().max(2000).optional()
});

type CorridorPoiResponseRow = {
  id: string;
  poi_type: "accommodation" | "charger";
  name: string;
  lat: number;
  lon: number;
  address?: string;
  city?: string;
  state?: string;
  zip_code?: string;
  network?: string;
  distance_from_route_mi?: number;
  attributes: Record<string, string | number | boolean | undefined>;
};

function poiResponseType(rawType: "hotel" | "charger"): "accommodation" | "charger" {
  return rawType === "hotel" ? "accommodation" : "charger";
}

function poiId(rawType: "hotel" | "charger", poi: PoiServicesPoi): string {
  return `poi_services:${rawType}:${poi.id}`;
}

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function equirectangularProjection(point: { lat: number; lon: number }, origin: { lat: number; lon: number }) {
  const latRad = toRadians(point.lat);
  const lonRad = toRadians(point.lon);
  const originLatRad = toRadians(origin.lat);
  const originLonRad = toRadians(origin.lon);
  const x = (lonRad - originLonRad) * Math.cos(originLatRad);
  const y = latRad - originLatRad;
  return { x, y };
}

function distanceBetweenProjected(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy) * 3960; // Earth radius in miles
}

function distanceFromPointToSegmentMiles(
  point: { lat: number; lon: number },
  start: { lat: number; lon: number },
  end: { lat: number; lon: number }
): number {
  const p = equirectangularProjection(point, point);
  const a = equirectangularProjection(start, point);
  const b = equirectangularProjection(end, point);
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const ab2 = abx * abx + aby * aby;
  if (ab2 === 0) {
    return distanceBetweenProjected(p, a);
  }
  const t = Math.max(0, Math.min(1, (p.x - a.x) * abx + (p.y - a.y) * aby) / ab2);
  const projection = { x: a.x + t * abx, y: a.y + t * aby };
  return distanceBetweenProjected(p, projection);
}

function distanceFromRouteMiles(
  poi: { lat: number; lon: number },
  shape: Array<{ lat: number; lon: number }>
): number {
  let minMiles = Number.POSITIVE_INFINITY;
  for (let i = 0; i < shape.length - 1; i++) {
    const miles = distanceFromPointToSegmentMiles(poi, shape[i]!, shape[i + 1]!);
    if (miles < minMiles) {
      minMiles = miles;
    }
  }
  return Number.isFinite(minMiles) ? minMiles : 0;
}

function mapPoiServicesPoiToResponse(
  poi: PoiServicesPoi,
  rawType: "hotel" | "charger",
  shape: Array<{ lat: number; lon: number }>
): CorridorPoiResponseRow {
  return {
    id: poiId(rawType, poi),
    poi_type: poiResponseType(rawType),
    name: poi.name || (rawType === "hotel" ? "Hotel" : "Charger"),
    lat: poi.lat,
    lon: poi.lon,
    address: poi.address,
    city: poi.city,
    state: poi.state,
    zip_code: poi.zip_code,
    network: poi.network,
    distance_from_route_mi: distanceFromRouteMiles(poi, shape),
    attributes: {
      rooms: poi.rooms,
      onsite_charger_level: poi.onsite_charger_level,
      onsite_charger_power_kw: poi.onsite_charger_power_kw,
      onsite_charger_ports: poi.onsite_charger_ports,
      onsite_charger_network: poi.onsite_charger_network,
      connector_types: poi.connector_types,
      power_kw: poi.power_kw,
      num_ports: poi.num_ports,
      nearby_dcfc_id: poi.nearby_dcfc_id,
      nearby_dcfc_distance_yd: poi.nearby_dcfc_distance_yd,
      status: poi.status,
      website: poi.website,
      phone: poi.phone
    }
  };
}

function applyLimitSplit(
  chargers: CorridorPoiResponseRow[],
  hotels: CorridorPoiResponseRow[],
  limit: number
): CorridorPoiResponseRow[] {
  const total = chargers.length + hotels.length;
  if (total <= limit) {
    return [...chargers, ...hotels];
  }
  const chargerQuota = Math.max(1, Math.round((chargers.length / total) * limit));
  const hotelQuota = Math.max(1, limit - chargerQuota);
  const cappedChargerQuota = Math.min(chargerQuota, chargers.length);
  const cappedHotelQuota = Math.min(hotelQuota, hotels.length);
  const remainder = limit - (cappedChargerQuota + cappedHotelQuota);
  const extraChargers = remainder > 0 ? Math.min(remainder, chargers.length - cappedChargerQuota) : 0;
  const extraHotels = remainder > extraChargers ? Math.min(remainder - extraChargers, hotels.length - cappedHotelQuota) : 0;
  return [
    ...chargers.slice(0, cappedChargerQuota + extraChargers),
    ...hotels.slice(0, cappedHotelQuota + extraHotels)
  ];
}

app.post("/corridor/pois", async (req, res) => {
  const requestId =
    (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
  const startedAt = Date.now();
  const responseVersion = "v2-1-corridor-pois";

  try {
    const parsed = corridorPoisSchema.parse(req.body);
    const rawLayers: Array<"charger" | "hotel"> =
      parsed.poi_type === "all"
        ? ["charger", "hotel"]
        : parsed.poi_type === "accommodation"
          ? ["hotel"]
          : ["charger"];

    const queryBody = {
      shape: parsed.shape,
      corridor_radius_mi: parsed.corridor_radius_mi,
      layers: rawLayers,
      filters:
        parsed.poi_type === "charger"
          ? { network: parsed.network }
          : undefined,
      limit: parsed.limit
    } as const;

    const corridor = await postCorridorQuery(queryBody);
    let chargerPois: CorridorPoiResponseRow[] = [];
    let hotelPois: CorridorPoiResponseRow[] = [];

    if (corridor.charger) {
      chargerPois = corridor.charger
        .map((poi) => mapPoiServicesPoiToResponse(poi, "charger", parsed.shape))
        .filter((poi) =>
          parsed.network && parsed.poi_type === "all"
            ? poi.network?.toLowerCase() === parsed.network.toLowerCase()
            : true
        );
    }
    if (corridor.hotel) {
      hotelPois = corridor.hotel.map((poi) => mapPoiServicesPoiToResponse(poi, "hotel", parsed.shape));
    }

    let pois: CorridorPoiResponseRow[] = [];
    if (parsed.poi_type === "all") {
      pois = parsed.limit ? applyLimitSplit(chargerPois, hotelPois, parsed.limit) : [...chargerPois, ...hotelPois];
    } else if (parsed.poi_type === "charger") {
      pois = parsed.limit ? chargerPois.slice(0, parsed.limit) : chargerPois;
    } else {
      pois = parsed.limit ? hotelPois.slice(0, parsed.limit) : hotelPois;
    }

    res.status(200).json({
      requestId,
      responseVersion,
      status: "ok",
      pois,
      debug: {
        durationMs: Date.now() - startedAt,
        filters: {
          poi_type: parsed.poi_type,
          network: parsed.network
        },
        corridor: {
          radius_mi: corridor.corridor?.radius_mi,
          shape_points: corridor.corridor?.shape_points,
          warnings: corridor.warnings
        }
      }
    });
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      /exceeded time limit|timed out|ECONNABORTED/i.test(err.message);
    console.log(
      JSON.stringify({
        event: "corridor_pois_request_error",
        deploymentEnv,
        requestId,
        responseVersion,
        durationMs: Date.now() - startedAt,
        message: err instanceof Error ? err.message : String(err),
        timeout: isTimeout
      })
    );
    const msg = err instanceof Error ? err.message : "Unexpected error fetching corridor POIs";
    const statusCode = isTimeout ? 408 : 400;
    res.status(statusCode).json({
      requestId,
      responseVersion,
      status: "error",
      message: msg
    });
  }
});

type PlanBodyParsed = z.infer<typeof planSchema>;

async function runPlanJobInBackground(args: {
  jobId: string;
  requestId: string;
  responseVersion: string;
  startedAt: number;
  parsed: PlanBodyParsed;
}): Promise<void> {
  const { jobId, requestId, responseVersion, startedAt, parsed } = args;
  const providerMetrics = new ProviderCallMetrics();
  const checkpointAgg = {
    total: 0,
    byKind: new Map<string, number>(),
    byOutcome: new Map<string, number>(),
    bySolverStatus: new Map<string, number>(),
    constrainedAttempted: 0,
    constrainedUsed: 0,
    maxPartialStopsCount: 0,
    maxPartialLegsCount: 0
  };
  const inc = (m: Map<string, number>, k: string | undefined) => {
    if (!k) return;
    m.set(k, (m.get(k) ?? 0) + 1);
  };
  const mapToObject = (m: Map<string, number>) =>
    Object.fromEntries([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  const summarizeAttemptForEvent = (attempt: Record<string, unknown>) => {
    const pickNumber = (k: string) =>
      typeof attempt[k] === "number" ? (attempt[k] as number) : undefined;
    const pickString = (k: string) =>
      typeof attempt[k] === "string" ? (attempt[k] as string) : undefined;
    const pickBool = (k: string) =>
      typeof attempt[k] === "boolean" ? (attempt[k] as boolean) : undefined;
    return {
      outcome: pickString("outcome"),
      solverStatus: pickString("solverStatus"),
      errorCode: pickString("errorCode"),
      constrainedModeAttempted: pickBool("constrainedModeAttempted"),
      constrainedUsed: pickBool("constrainedUsed"),
      overnightIndex: pickNumber("overnightIndex"),
      stopsCount: pickNumber("stopsCount"),
      legsCount: pickNumber("legsCount"),
      chargeStopsCount: pickNumber("chargeStopsCount"),
      chargersForSegmentCappedCount: pickNumber("chargersForSegmentCappedCount"),
      corridorChargersTotal: pickNumber("corridorChargersTotal"),
      edgeGraphChargersCount: pickNumber("edgeGraphChargersCount"),
      fallbackPoolCount: pickNumber("fallbackPoolCount"),
      fallbackCapAfterConstrainedNoPath: pickNumber("fallbackCapAfterConstrainedNoPath"),
      message:
        typeof attempt.errorMessage === "string"
          ? (attempt.errorMessage as string)
          : undefined
    };
  };
  try {
    const result = await runPlanWithProviderMetrics(providerMetrics, async () =>
      planTrip({
        requestId,
        start: parsed.start?.trim() ? parsed.start : undefined,
        end: parsed.end,
        responseVersion,
        waypoints: parsed.waypoints,
        includeCandidates: parsed.includeCandidates,
        lockedChargersByLeg: parsed.lockedChargersByLeg,
        lockedHotelId: parsed.lockedHotelId,
        replanFrom: parsed.replanFrom,
        previousStops: parsed.previousStops,
        onSolverAttempt: (ev) => {
          const kind = String((ev.attempt as Record<string, unknown>)?.kind ?? "");
          const reason = String((ev.attempt as Record<string, unknown>)?.reason ?? "");
          const ps = (ev.attempt as Record<string, unknown>)?.partialSnapshot as
            | { stops?: unknown[]; legs?: unknown[] }
            | undefined;
          const summary = summarizeAttemptForEvent(ev.attempt as Record<string, unknown>);
          checkpointAgg.total++;
          inc(checkpointAgg.byKind, kind || undefined);
          inc(checkpointAgg.byOutcome, summary.outcome);
          inc(checkpointAgg.bySolverStatus, summary.solverStatus);
          if (summary.constrainedModeAttempted) checkpointAgg.constrainedAttempted++;
          if (summary.constrainedUsed) checkpointAgg.constrainedUsed++;
          const partialStopsCount = Array.isArray(ps?.stops) ? ps.stops.length : undefined;
          const partialLegsCount = Array.isArray(ps?.legs) ? ps.legs.length : undefined;
          if (typeof partialStopsCount === "number") {
            checkpointAgg.maxPartialStopsCount = Math.max(
              checkpointAgg.maxPartialStopsCount,
              partialStopsCount
            );
          }
          if (typeof partialLegsCount === "number") {
            checkpointAgg.maxPartialLegsCount = Math.max(
              checkpointAgg.maxPartialLegsCount,
              partialLegsCount
            );
          }
          console.log(
            JSON.stringify({
              event: "plan_job_checkpoint",
              deploymentEnv,
              requestId,
              responseVersion,
              jobId,
              legIndex: ev.legIndex,
              kind,
              reason: reason || undefined,
              partialStopsCount,
              partialLegsCount,
              attemptSummary: summary
            })
          );
          appendPlanJobCheckpoint(jobId, ev);
        }
      })
    );
    console.log(
      JSON.stringify({
        event: "plan_request_end",
        deploymentEnv,
        requestId,
        responseVersion,
        jobId,
        planJob: true,
        status: result.status,
        durationMs: Date.now() - startedAt,
        stopsCount: result.stops?.length ?? 0,
        overnightStopsCount: result.totals?.overnightStopsCount ?? 0
      })
    );
    console.log(
      JSON.stringify({
        event: "plan_job_terminal_summary",
        deploymentEnv,
        requestId,
        responseVersion,
        jobId,
        status: result.status,
        durationMs: Date.now() - startedAt,
        checkpointsTotal: checkpointAgg.total,
        checkpointsByKind: mapToObject(checkpointAgg.byKind),
        outcomes: mapToObject(checkpointAgg.byOutcome),
        solverStatuses: mapToObject(checkpointAgg.bySolverStatus),
        constrainedAttempted: checkpointAgg.constrainedAttempted,
        constrainedUsed: checkpointAgg.constrainedUsed,
        maxPartialStopsCount: checkpointAgg.maxPartialStopsCount,
        maxPartialLegsCount: checkpointAgg.maxPartialLegsCount
      })
    );
    completePlanJob(jobId, {
      ...result,
      debug: {
        ...(result.debug ?? {}),
        ...providerMetrics.toDebugPayload()
      }
    });
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      /exceeded time limit|timed out|ECONNABORTED/i.test(err.message);
    console.log(
      JSON.stringify({
        event: "plan_request_error",
        deploymentEnv,
        requestId,
        responseVersion,
        jobId,
        planJob: true,
        durationMs: Date.now() - startedAt,
        message: err instanceof Error ? err.message : String(err),
        timeout: isTimeout
      })
    );
    console.log(
      JSON.stringify({
        event: "plan_job_terminal_summary",
        deploymentEnv,
        requestId,
        responseVersion,
        jobId,
        status: "error",
        durationMs: Date.now() - startedAt,
        timeout: isTimeout,
        checkpointsTotal: checkpointAgg.total,
        checkpointsByKind: mapToObject(checkpointAgg.byKind),
        outcomes: mapToObject(checkpointAgg.byOutcome),
        solverStatuses: mapToObject(checkpointAgg.bySolverStatus),
        constrainedAttempted: checkpointAgg.constrainedAttempted,
        constrainedUsed: checkpointAgg.constrainedUsed,
        maxPartialStopsCount: checkpointAgg.maxPartialStopsCount,
        maxPartialLegsCount: checkpointAgg.maxPartialLegsCount,
        errorMessage: err instanceof Error ? err.message : String(err)
      })
    );
    const msg =
      err instanceof Error ? err.message : "Unexpected error planning trip";
    const statusCode = isTimeout ? 408 : 400;
    const errorDebug = {
      ...(isTimeout ? { reason: "planner_timeout" } : {}),
      ...providerMetrics.toDebugPayload()
    };
    failPlanJob(jobId, {
      message: msg,
      httpStatus: statusCode,
      debug: Object.keys(errorDebug).length > 0 ? errorDebug : undefined
    });
  }
}

app.get("/plan/jobs/:jobId", (req, res) => {
  const job = getPlanJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({
      status: "error",
      message: "Unknown or expired plan job id"
    });
  }
  const payload: Record<string, unknown> = {
    jobId: req.params.jobId,
    requestId: job.requestId,
    responseVersion: job.responseVersion,
    status: job.status,
    checkpoints: job.checkpoints
  };
  if (job.status === "complete" && job.result) {
    payload.result = job.result;
  }
  if (job.status === "error" && job.error) {
    payload.message = job.error.message;
    payload.httpStatus = job.error.httpStatus;
    if (job.error.debug && Object.keys(job.error.debug).length > 0) {
      payload.debug = job.error.debug;
    }
    if (job.error.lastPartialSnapshot) {
      payload.lastPartialSnapshot = job.error.lastPartialSnapshot;
    }
  }
  res.status(200).json(payload);
});

/** Keep long `planJob` streams alive through proxies; client resets idle timeout on `type: "heartbeat"`. */
function planJobSseHeartbeatIntervalMs(): number {
  const raw = process.env.PLAN_JOB_SSE_HEARTBEAT_MS;
  if (raw === undefined || raw === "") return 25_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function startPlanJobStreamHeartbeat(
  res: express.Response,
  format: "ndjson" | "sse"
): () => void {
  const ms = planJobSseHeartbeatIntervalMs();
  if (ms <= 0) return () => { };
  const id = setInterval(() => {
    if (res.writableEnded) return;
    const payload = JSON.stringify({ type: "heartbeat", t: Date.now() });
    try {
      if (format === "sse") {
        res.write(`data: ${payload}\n\n`);
      } else {
        res.write(`${payload}\n`);
      }
    } catch {
      clearInterval(id);
    }
  }, ms);
  return () => clearInterval(id);
}

app.get("/plan/jobs/:jobId/stream", (req, res) => {
  const job = getPlanJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({
      status: "error",
      message: "Unknown or expired plan job id"
    });
  }
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  const stopHeartbeat = startPlanJobStreamHeartbeat(res, "ndjson");
  const unsub = subscribePlanJobStream(
    req.params.jobId,
    (obj) => {
      res.write(`${JSON.stringify(obj)}\n`);
    },
    () => {
      stopHeartbeat();
      res.end();
    }
  );
  req.on("close", () => {
    stopHeartbeat();
    unsub();
  });
});

/** Server-Sent Events — same JSON payloads as NDJSON stream (`data:` lines); EventSource-friendly. */
app.get("/plan/jobs/:jobId/events", (req, res) => {
  const job = getPlanJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({
      status: "error",
      message: "Unknown or expired plan job id"
    });
  }
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.write("retry: 3000\n\n");
  const stopHeartbeat = startPlanJobStreamHeartbeat(res, "sse");
  const unsub = subscribePlanJobStream(
    req.params.jobId,
    (obj) => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    },
    () => {
      stopHeartbeat();
      res.end();
    }
  );
  req.on("close", () => {
    stopHeartbeat();
    unsub();
  });
});

app.post("/plan", async (req, res) => {
  const requestId =
    (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
  const startedAt = Date.now();
  let responseVersion = "mvp-1";
  let providerMetrics: ProviderCallMetrics | undefined;

  try {
    const parsed = planSchema.parse(req.body);
    responseVersion =
      parsed.waypoints?.length ||
        parsed.includeCandidates ||
        (parsed.lockedChargersByLeg && parsed.lockedChargersByLeg.length > 0) ||
        parsed.lockedHotelId ||
        parsed.replanFrom ||
        parsed.planJob ||
        parsed.optimizeWaypointOrder
        ? "v2-1"
        : "mvp-1";
    const replanLog =
      parsed.replanFrom == null
        ? null
        : "coords" in parsed.replanFrom
          ? { mode: "coords" as const }
          : { mode: "stopId" as const, stopId: parsed.replanFrom.stopId };
    console.log(
      JSON.stringify({
        event: "plan_request_start",
        deploymentEnv,
        requestId,
        responseVersion,
        planJob: Boolean(parsed.planJob),
        startTextPresent: Boolean(parsed.start?.trim()),
        end: parsed.end,
        waypointsCount: parsed.waypoints?.length ?? 0,
        includeCandidates: Boolean(parsed.includeCandidates),
        lockedChargersByLeg: parsed.lockedChargersByLeg?.map((r) => r.length) ?? null,
        lockedHotelId: parsed.lockedHotelId ?? null,
        replanFrom: replanLog,
        previousStopsCount: parsed.previousStops?.length ?? 0
      })
    );

    if (parsed.planJob === true) {
      const jobId = randomUUID();
      createPlanJob({ jobId, requestId, responseVersion });
      void runPlanJobInBackground({ jobId, requestId, responseVersion, startedAt, parsed });
      return res.status(202).json({
        jobId,
        requestId,
        responseVersion,
        status: "running",
        pollUrl: `/plan/jobs/${jobId}`,
        streamUrl: `/plan/jobs/${jobId}/stream`,
        eventsUrl: `/plan/jobs/${jobId}/events`
      });
    }

    providerMetrics = new ProviderCallMetrics();
    const result = await runPlanWithProviderMetrics(providerMetrics, async () =>
      planTrip({
        requestId,
        start: parsed.start?.trim() ? parsed.start : undefined,
        end: parsed.end,
        responseVersion,
        waypoints: parsed.waypoints,
        includeCandidates: parsed.includeCandidates,
        lockedChargersByLeg: parsed.lockedChargersByLeg,
        lockedHotelId: parsed.lockedHotelId,
        replanFrom: parsed.replanFrom,
        previousStops: parsed.previousStops,
        optimizeWaypointOrder: parsed.optimizeWaypointOrder
      })
    );
    console.log(
      JSON.stringify({
        event: "plan_request_end",
        deploymentEnv,
        requestId,
        responseVersion,
        status: result.status,
        durationMs: Date.now() - startedAt,
        stopsCount: result.stops?.length ?? 0,
        overnightStopsCount: result.totals?.overnightStopsCount ?? 0
      })
    );
    res.status(result.status === "ok" ? 200 : 400).json({
      ...result,
      debug: {
        ...(result.debug ?? {}),
        ...providerMetrics.toDebugPayload()
      }
    });
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      /exceeded time limit|timed out|ECONNABORTED/i.test(err.message);
    console.log(
      JSON.stringify({
        event: "plan_request_error",
        deploymentEnv,
        requestId,
        responseVersion,
        durationMs: Date.now() - startedAt,
        message: err instanceof Error ? err.message : String(err),
        timeout: isTimeout
      })
    );
    const msg =
      err instanceof Error ? err.message : "Unexpected error planning trip";
    const statusCode = isTimeout ? 408 : 400;
    const errorDebug = {
      ...(isTimeout ? { reason: "planner_timeout" } : {}),
      ...(providerMetrics?.toDebugPayload() ?? {})
    };
    res.status(statusCode).json({
      requestId,
      responseVersion,
      status: "error",
      message: msg,
      stops: [],
      legs: [],
      debug: Object.keys(errorDebug).length > 0 ? errorDebug : undefined
    });
  }
});

// Default 3001 so Next.js can use 3000 (see README / TESTING.md).
const port = Number(process.env.PORT ?? "3001");
const httpServer = http.createServer(app);

/**
 * ts-node-dev can start the new process before the old child releases the port.
 * Retrying listen() in a tight loop stacks listeners; instead we best-effort kill
 * listeners on this port before binding (dev-like deployments only).
 *
 * Windows: `Get-NetTCPConnection -LocalPort` without `-State Listen` can miss the
 * actual LISTEN socket; we use `-State Listen` and a `netstat -ano` + `taskkill`
 * fallback. One delayed re-bind handles races where the OS hasn't released yet.
 */
function netstatListeningPidsWin(p: number): number[] {
  try {
    const out = execSync(`cmd.exe /c netstat -ano`, { encoding: "utf8" });
    const pids = new Set<number>();
    const portSuffix = `:${p}`;
    for (const line of out.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("TCP")) continue;
      if (!trimmed.includes("LISTENING")) continue;
      const parts = trimmed.split(/\s+/).filter(Boolean);
      if (parts.length < 5) continue;
      const localAddr = parts[1];
      if (!localAddr.endsWith(portSuffix)) continue;
      const m = localAddr.match(/:(\d+)$/);
      if (!m || Number(m[1]) !== p) continue;
      const pid = Number(parts[parts.length - 1]);
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
        pids.add(pid);
      }
    }
    return [...pids];
  } catch {
    return [];
  }
}

function freeListeningPortBestEffort(p: number): void {
  try {
    if (process.platform === "win32") {
      try {
        execSync(
          `powershell -NoProfile -Command "$pids = Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($procId in $pids) { if ($procId -and $procId -ne ${process.pid}) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } }"`,
          { stdio: "ignore" }
        );
      } catch {
        // ignore
      }
      for (const pid of netstatListeningPidsWin(p)) {
        try {
          execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
        } catch {
          // ignore
        }
      }
    } else {
      let pids = "";
      try {
        pids = execSync(`lsof -ti:${p}`, { encoding: "utf8" }).trim();
      } catch {
        // no listeners
      }
      if (pids) {
        for (const pid of pids.split(/\s+/).filter(Boolean)) {
          if (pid === String(process.pid)) continue;
          try {
            execSync(`kill -9 ${pid}`, { stdio: "ignore" });
          } catch {
            // ignore
          }
        }
      }
    }
  } catch {
    // ignore
  }
}

const shouldFreePortBeforeListen =
  process.env.API_FREE_PORT_BEFORE_LISTEN !== "false" &&
  deploymentEnv !== "production" &&
  deploymentEnv !== "prod";

const maxListenAttempts = Math.min(
  20,
  Math.max(1, Number(process.env.API_LISTEN_MAX_ATTEMPTS ?? "5") || 5)
);

/**
 * After killing listeners, Windows can take a moment to release the socket.
 * Skip on attempt 0 so cold starts stay fast when the port is already free; retries
 * (attempt ≥ 1) run after a prior EADDRINUSE and benefit from a short wait.
 * Set API_ALWAYS_SLEEP_AFTER_FREE=true to wait after every free.
 */
function sleepMsAfterFreePortSync(attempt: number): void {
  if (!shouldFreePortBeforeListen) return;
  const always = process.env.API_ALWAYS_SLEEP_AFTER_FREE === "true";
  if (attempt === 0 && !always) return;
  const ms =
    process.platform === "win32"
      ? Math.max(0, Number(process.env.API_AFTER_FREE_PORT_MS_WIN ?? "220") || 220)
      : Math.max(0, Number(process.env.API_AFTER_FREE_PORT_MS_UNIX ?? "60") || 60);
  if (ms <= 0) return;
  try {
    if (process.platform === "win32") {
      execSync(`powershell -NoProfile -Command "Start-Sleep -Milliseconds ${ms}"`, {
        stdio: "ignore"
      });
    } else {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        /* dev-only startup sync wait; avoids fractional sleep portability issues */
      }
    }
  } catch {
    // ignore
  }
}

function startListening(attempt: number): void {
  if (shouldFreePortBeforeListen) {
    freeListeningPortBestEffort(port);
    sleepMsAfterFreePortSync(attempt);
  }

  // Use explicit `listening` + `listen()` without a callback. A failed `listen()`
  // can leave a stale `listening` listener; a later successful bind may invoke
  // every registered listener — producing duplicate "api listening" lines.
  let onListening: () => void;

  const onError = (err: NodeJS.ErrnoException) => {
    httpServer.off("error", onError);
    httpServer.off("listening", onListening);
    if (err.code === "EADDRINUSE" && attempt < maxListenAttempts - 1 && shouldFreePortBeforeListen) {
      freeListeningPortBestEffort(port);
      httpServer.close(() => {
        const delayMs = Math.min(350 * 2 ** attempt, 3000);
        setTimeout(() => startListening(attempt + 1), delayMs);
      });
      return;
    }
    // eslint-disable-next-line no-console
    console.error(err);
    if (err.code === "EADDRINUSE") {
      // eslint-disable-next-line no-console
      console.error(
        `[api] Port ${port} is still in use. Stop the other process (e.g. duplicate npm run dev:api) or change PORT.`
      );
    }
    process.exit(1);
  };

  onListening = () => {
    httpServer.off("error", onError);
    // eslint-disable-next-line no-console
    console.log(`api listening on :${port}`);
  };

  httpServer.once("error", onError);
  httpServer.once("listening", onListening);
  httpServer.listen(port);
}

startListening(0);

function shutdown(signal: string): void {
  // eslint-disable-next-line no-console
  console.log(`[api] ${signal} received, closing HTTP server…`);
  httpServer.close(() => {
    process.exit(0);
  });
  setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error("[api] HTTP close timed out, exiting");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

