import express from "express";
import http from "http";
import { z } from "zod";
import { randomUUID } from "crypto";
import { execSync } from "child_process";
import { planTrip, planTripCandidatesOnly } from "./planner/planTrip";
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
    const totalMs = Number(process.env.PLAN_TOTAL_TIMEOUT_MS ?? 120000);
    providerMetrics = new ProviderCallMetrics();
    const result = await runPlanWithProviderMetrics(providerMetrics, () =>
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
      parsed.replanFrom
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
    const totalMs = Number(process.env.PLAN_TOTAL_TIMEOUT_MS ?? 120000);
    providerMetrics = new ProviderCallMetrics();
    const result = await runPlanWithProviderMetrics(providerMetrics, () =>
      withTimeout(
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
          previousStops: parsed.previousStops
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

