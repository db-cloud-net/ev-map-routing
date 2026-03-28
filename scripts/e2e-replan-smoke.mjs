/**
 * E2E: Slice 2 `replanFrom` — coords + stopId (with previousStops).
 *
 * Spawns a short-lived API (see e2e-plan-log-contract.mjs). Requires network
 * for NREL/Valhalla/geocode unless env points to mocks.
 *
 *   node scripts/e2e-replan-smoke.mjs
 *
 * Env: API_PORT (default 3013), NREL_API_KEY from `.env` / environment.
 */

import { execSync, spawn } from "node:child_process";
import process from "node:process";
import { killListenersOnPort } from "./e2e-kill-port.mjs";
import { startPoiCorridorMock } from "./e2e-poi-corridor-mock.mjs";

const API_PORT = Number(process.env.API_PORT ?? "3013");
const API_BASE = process.env.API_BASE ?? `http://localhost:${API_PORT}`;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth({ timeoutMs = 60000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`${API_BASE}/health`, { method: "GET" });
      if (resp.ok) return;
    } catch {
      // ignore
    }
    await sleepMs(300);
  }
  throw new Error(`Timed out waiting for ${API_BASE}/health`);
}

function startServer(poiBaseUrl) {
  killListenersOnPort(API_PORT, { verbose: process.env.E2E_VERBOSE === "1" });
  execSync("npm -w api run build", { stdio: "inherit" });

  const serverEntry = "api/dist/api/src/server.js";
  const proc = spawn("node", [serverEntry], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(API_PORT),
      E2E_SPAWN_PORT: String(API_PORT),
      DEPLOYMENT_ENV: "dev-local",
      POI_SERVICES_BASE_URL: poiBaseUrl,
      PLAN_LOG_REQUESTS: "false"
    },
    stdio: ["ignore", "inherit", "inherit"]
  });

  return proc;
}

async function postPlan(body) {
  const controller = new AbortController();
  const timeoutMs = 180000;
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${API_BASE}/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const json = await resp.json().catch(() => null);
    return { respStatus: resp.status, json };
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const poiMock = await startPoiCorridorMock();
  try {
    const proc = startServer(poiMock.baseUrl);
    try {
      await waitForHealth({ timeoutMs: 60000 });

    const base = await postPlan({
      start: "Raleigh, NC",
      end: "Greensboro, NC"
    });
    assert(base.json, "baseline /plan returned JSON");
    assert(
      base.json.status === "ok",
      `baseline plan expected ok, got ${base.json.status}: ${base.json.message ?? ""}`
    );
    const stops = base.json.stops;
    assert(Array.isArray(stops) && stops.length >= 1, "expected at least one stop");

    const startStop = stops[0];
    const { lat, lon } = startStop.coords;

    const coordsReplan = await postPlan({
      replanFrom: { coords: { lat, lon } },
      end: "Greensboro, NC"
    });
    assert(coordsReplan.json, "coords replan returned JSON");
    assert(
      coordsReplan.json.responseVersion === "v2-1",
      `expected responseVersion v2-1, got ${coordsReplan.json.responseVersion}`
    );
    assert(
      coordsReplan.json.status === "ok",
      `coords replan expected ok, got ${coordsReplan.json.status}: ${coordsReplan.json.message ?? ""}`
    );
    assert(
      coordsReplan.json.debug?.replan === true,
      "expected debug.replan true for mid-journey replan"
    );

    const stopIdReplan = await postPlan({
      replanFrom: { stopId: startStop.id },
      end: "Greensboro, NC",
      previousStops: stops
    });
    assert(stopIdReplan.json, "stopId replan returned JSON");
    assert(
      stopIdReplan.json.responseVersion === "v2-1",
      `expected responseVersion v2-1, got ${stopIdReplan.json.responseVersion}`
    );
    assert(
      stopIdReplan.json.status === "ok",
      `stopId replan expected ok, got ${stopIdReplan.json.status}: ${stopIdReplan.json.message ?? ""}`
    );
    assert(
      stopIdReplan.json.debug?.replan === true,
      "expected debug.replan true for stopId replan"
    );

    const unknownStop = await postPlan({
      replanFrom: { stopId: "definitely-not-a-real-stop-id-xyz" },
      end: "Greensboro, NC",
      previousStops: stops
    });
    assert(unknownStop.json?.status === "error", "unknown stopId should error");
    assert(
      unknownStop.json.errorCode === "UNKNOWN_REPLAN_STOP",
      `expected UNKNOWN_REPLAN_STOP, got ${unknownStop.json.errorCode}`
    );

      console.log("e2e-replan-smoke: ok");
    } finally {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  } finally {
    await poiMock.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
