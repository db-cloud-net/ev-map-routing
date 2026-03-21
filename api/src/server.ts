import express from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { planTrip } from "./planner/planTrip";
import { withTimeout } from "./planTimeout";
import { ProviderCallMetrics, runPlanWithProviderMetrics } from "./services/providerCallMetrics";
import path from "path";
import { existsSync } from "fs";

import dotenv from "dotenv";

// Load the repo-root `.env`.
// In dev we usually run from the workspace root, but when running compiled JS
// from `api/dist/...` the `__dirname` depth changes, so we prefer `process.cwd()`.
const cwdEnvPath = path.join(process.cwd(), ".env");
const fallbackRepoRoot = path.resolve(__dirname, "../..");
const fallbackEnvPath = path.join(fallbackRepoRoot, ".env");

const envPath = existsSync(cwdEnvPath) ? cwdEnvPath : fallbackEnvPath;
dotenv.config({ path: envPath });

const deploymentEnv = (process.env.DEPLOYMENT_ENV ?? "dev-local").trim().toLowerCase();

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
      nrelApiKeyPresent: Boolean(process.env.NREL_API_KEY)
    }
  });
});

const planSchema = z.object({
  start: z.string().min(1).max(200),
  end: z.string().min(1).max(200),
  waypoints: z.array(z.string().min(1).max(200)).max(24).optional(),
  includeCandidates: z.boolean().optional(),
  lockedChargersByLeg: z.array(z.array(z.string().min(1).max(200)).max(24)).max(24).optional(),
  lockedHotelId: z.string().min(1).max(200).optional()
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
      parsed.lockedHotelId
        ? "v2-1"
        : "mvp-1";
    console.log(
      JSON.stringify({
        event: "plan_request_start",
        deploymentEnv,
        requestId,
        responseVersion,
        start: parsed.start,
        end: parsed.end,
        waypointsCount: parsed.waypoints?.length ?? 0,
        includeCandidates: Boolean(parsed.includeCandidates),
        lockedChargersByLeg: parsed.lockedChargersByLeg?.map((r) => r.length) ?? null,
        lockedHotelId: parsed.lockedHotelId ?? null
      })
    );
    const totalMs = Number(process.env.PLAN_TOTAL_TIMEOUT_MS ?? 120000);
    providerMetrics = new ProviderCallMetrics();
    const result = await runPlanWithProviderMetrics(providerMetrics, () =>
      withTimeout(
        planTrip({
          requestId,
          start: parsed.start,
          end: parsed.end,
          responseVersion,
          waypoints: parsed.waypoints,
          includeCandidates: parsed.includeCandidates,
          lockedChargersByLeg: parsed.lockedChargersByLeg,
          lockedHotelId: parsed.lockedHotelId
        }),
        totalMs,
        `Planner exceeded time limit (${totalMs}ms). Try a shorter route or retry later.`
      )
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
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`api listening on :${port}`);
});

