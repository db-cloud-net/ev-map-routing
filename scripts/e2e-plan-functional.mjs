/**
 * Backend functional E2E runner for `/plan`.
 *
 * It is intentionally dependency-free (no Playwright/Cypress yet) and uses real
 * external services (NREL/Overpass/Valhalla) as the integration tests.
 *
 * Usage:
 *   node scripts/e2e-plan-functional.mjs
 *
 * Optional:
 *   SPAWN_SERVER=true API_PORT=3001 node scripts/e2e-plan-functional.mjs
 *
 * Assumes the API server loads the repo-root `.env` and uses process.env overrides
 * when provided.
 */

import { execSync, spawn } from "node:child_process";
import process from "node:process";

const API_PORT = Number(process.env.API_PORT ?? "3001");
const API_BASE = process.env.API_BASE ?? `http://localhost:${API_PORT}`;

const SLEEP_MS = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function fetchJson(url, { method = "GET", body, headers, timeoutMs = 120000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(headers ?? {})
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    const text = await resp.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // fallthrough
    }
    return { resp, json, text };
  } finally {
    clearTimeout(t);
  }
}

async function waitForHealth({ timeoutMs = 60000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetchJson(`${API_BASE}/health`, { method: "GET", timeoutMs: 5000 });
      if (r?.json?.ok) return true;
    } catch {
      // ignore
    }
    await SLEEP_MS(500);
  }
  throw new Error(`Timed out waiting for ${API_BASE}/health`);
}

async function withRetries(fn, { attempts = 3, delayMs = 2000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await SLEEP_MS(delayMs * (i + 1));
    }
  }
  throw lastErr;
}

function stopServer(serverProc) {
  if (!serverProc) return;
  try {
    serverProc.kill("SIGTERM");
  } catch {
    // ignore
  }
}

async function startServerWithOverrides(overrides) {
  // Build first so `dist/server.js` exists.
  // (Guarded so we don't rebuild per case.)
  if (!startServerWithOverrides._didBuild) {
    execSync("npm -w api run build", { stdio: "inherit" });
    startServerWithOverrides._didBuild = true;
  }

  const env = {
    ...process.env,
    ...overrides,
    PORT: String(API_PORT)
  };

  // `api/src/server.ts` compiles to `api/dist/api/src/server.js` (per tsconfig outDir/rootDir).
  const serverEntry = "api/dist/api/src/server.js";
  const serverProc = spawn("node", [serverEntry], {
    cwd: process.cwd(),
    env,
    stdio: "ignore"
  });

  try {
    await waitForHealth();
  } catch (e) {
    stopServer(serverProc);
    throw e;
  }

  return serverProc;
}

function summarizeStops(stops) {
  const byType = new Map();
  for (const s of stops ?? []) {
    byType.set(s.type, (byType.get(s.type) ?? 0) + 1);
  }
  return Object.fromEntries(byType.entries());
}

async function runPlanCase(caseDef) {
  const { start, end, assertions, timeoutMs = 180000 } = caseDef;

  const json = await withRetries(
    async () => {
      const url = `${API_BASE}/plan`;
      const r = await fetchJson(
        url,
        {
          method: "POST",
          body: { start, end },
          timeoutMs
        }
      );
      if (!r.json) throw new Error(`No JSON in response. text=${r.text?.slice(0, 300)}`);
      if (r.json.status !== "ok") {
        throw new Error(`Plan failed: message=${r.json.message ?? ""}`);
      }
      return r.json;
    },
    { attempts: 2, delayMs: 4000 }
  );

  assertions(json);
  return json;
}

async function main() {
  // These env overrides are passed to the server only when SPAWN_SERVER=true.
  const baseEnv = {
    DISABLE_VALHALLA_LEG_TIME: "true",
    USE_VALHALLA_DISTANCE_FEASIBILITY: "false"
  };
  const spawnServer = (process.env.SPAWN_SERVER ?? "false").toLowerCase() === "true";
  let serverProc = null;
  if (!spawnServer) await waitForHealth();

  // Test cases use real external services.
  // We keep assertions on stable invariants, not on exact charger counts.

  const cases = [
    {
      name: "Overnight sleep inserted near HIE (functional)",
      start: "Charleston, SC",
      end: "36.05807428628289,-79.8905987193178",
      envOverrides: {
        EV_RANGE_MILES: "50",
        AVG_SPEED_MPH: "30",
        OVERNIGHT_THRESHOLD_MINUTES: "600",
        MAX_OVERNIGHT_STOPS: "7",
        HOTEL_RADIUS_METERS: "1200",
        OVERNIGHT_HOTEL_RADIUS_METERS: "1200",
        NREL_RADIUS_MILES: "60",
        CORRIDOR_MAX_SAMPLE_POINTS: "10",
        CANDIDATE_CHARGERS_CAP: "200",
        NREL_INCLUDE_ALL_ELECTRIC_CHARGERS: "true"
      },
      timeoutMs: 240000,
      assertions: (json) => {
        assert(json.status === "ok", "expected ok");
        assert(Array.isArray(json.stops) && json.stops.length >= 2, "expected non-empty stops");
        const sleepStops = json.stops.filter((s) => s.type === "sleep");
        const chargeStops = json.stops.filter((s) => s.type === "charge");
        const hasHIE = sleepStops.some((s) => (s.name ?? "").includes("Holiday Inn Express"));
        const sleepChargerFoundCount = sleepStops.reduce(
          (sum, s) => sum + (s.meta?.chargerFound ? 1 : 0),
          0
        );

        console.log(
          `Hotel charger preference found on ${sleepChargerFoundCount} sleep stop(s) (sleepStops=${sleepStops.length}).`
        );

        assert(chargeStops.length >= 1, "expected at least one charge stop");
        assert(sleepStops.length >= 1, `expected >=1 sleep stop; got ${sleepStops.length}`);
        assert(hasHIE, "expected sleep stop to include Holiday Inn Express name");
        assert((json.totals?.overnightStopsCount ?? 0) >= 1, "expected overnightStopsCount>=1");
      }
    },
    {
      name: "Max days cap (<=8 days)",
      start: "Raleigh, NC",
      end: "Seattle, WA",
      envOverrides: {
        EV_RANGE_MILES: "260",
        OVERNIGHT_THRESHOLD_MINUTES: "180",
        MAX_OVERNIGHT_STOPS: "7",
        NREL_RADIUS_MILES: "60",
        CORRIDOR_MAX_SAMPLE_POINTS: "10",
        CANDIDATE_CHARGERS_CAP: "200",
        HOTEL_RADIUS_METERS: "365.76",
        OVERNIGHT_HOTEL_RADIUS_METERS: "365.76"
      },
      timeoutMs: 240000,
      assertions: (json) => {
        assert(json.status === "ok", "expected ok");
        assert(json.stops?.some((s) => s.type === "end"), "expected end stop");
        const overnightStops = json.totals?.overnightStopsCount ?? 0;
        assert(overnightStops <= 7, `expected overnightStopsCount<=7; got ${overnightStops}`);
      }
    },
    {
      name: "Sanity: no sleep when direct-ish",
      start: "Raleigh, NC",
      end: "Greensboro, NC",
      envOverrides: {
        EV_RANGE_MILES: "260",
        OVERNIGHT_THRESHOLD_MINUTES: "600",
        MAX_OVERNIGHT_STOPS: "7",
        HOTEL_RADIUS_METERS: "365.76",
        OVERNIGHT_HOTEL_RADIUS_METERS: "365.76",
        NREL_RADIUS_MILES: "60",
        CORRIDOR_MAX_SAMPLE_POINTS: "10",
        CANDIDATE_CHARGERS_CAP: "200"
      },
      timeoutMs: 180000,
      assertions: (json) => {
        assert(json.status === "ok", "expected ok");
        const sleepStops = json.stops.filter((s) => s.type === "sleep");
        assert(sleepStops.length === 0, `expected 0 sleep stops; got ${sleepStops.length}`);
      }
    }
  ];

  // When not spawning the server, tests rely on the current `.env`.
  // When you do want deterministic behavior, run with SPAWN_SERVER=true
  // and set/extend env overrides below.

  if ((process.env.SPAWN_SERVER ?? "false").toLowerCase() !== "true") {
    console.log(`Running E2E using existing server at ${API_BASE}`);
    console.log(
      "\nNote: Case-specific envOverrides in this script only apply when SPAWN_SERVER=true.\n" +
        "Against a normal dev API, some cases (e.g. overnight + HIE) may fail unless your .env matches those constraints.\n"
    );
  }

  const results = [];
  for (const c of cases) {
    const startT = Date.now();
    try {
      console.log(`\nCase: ${c.name}`);

      if (spawnServer) {
        stopServer(serverProc);
        serverProc = await startServerWithOverrides({
          ...baseEnv,
          ...(c.envOverrides ?? {})
        });
      }

      const json = await runPlanCase(c);
      const dt = Date.now() - startT;
      results.push({ name: c.name, status: "passed", ms: dt, totals: json.totals, stops: summarizeStops(json.stops) });
      console.log(`Passed in ${dt}ms totals=`, json.totals);
    } catch (e) {
      const dt = Date.now() - startT;
      results.push({ name: c.name, status: "failed", ms: dt, error: String(e?.message ?? e) });
      console.error(`Failed [${c.name}] in ${dt}ms: ${String(e?.message ?? e)}`);
    }
  }

  stopServer(serverProc);

  const failed = results.filter((r) => r.status === "failed");
  if (failed.length) {
    console.error("\nSome E2E cases failed:");
    for (const f of failed) console.error(`- ${f.name}: ${f.error}`);
    process.exitCode = 1;
  } else {
    console.log("\nAll E2E cases passed.");
  }
}

await main();

