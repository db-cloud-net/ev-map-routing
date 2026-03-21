/**
 * E2E: Multi-leg `POST /plan` + `lockedChargersByLeg` (P1 — API contract; map UI is single-segment for locks).
 *
 *   node scripts/e2e-multileg-locks-smoke.mjs
 *
 * Env: API_PORT (default 3015), NREL / Valhalla / geocode — same as other planner E2E.
 */

import { execSync, spawn } from "node:child_process";
import process from "node:process";
import { killListenersOnPort } from "./e2e-kill-port.mjs";

const API_PORT = Number(process.env.API_PORT ?? "3015");
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

function startServer() {
  killListenersOnPort(API_PORT, { verbose: process.env.E2E_VERBOSE === "1" });
  execSync("npm -w api run build", { stdio: "inherit" });

  const serverEntry = "api/dist/api/src/server.js";
  const proc = spawn("node", [serverEntry], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(API_PORT),
      DEPLOYMENT_ENV: "dev-local",
      SOURCE_ROUTING_MODE: "remote_only",
      PLAN_LOG_REQUESTS: "false",
      /** Multi-leg + candidates can exceed default 120s on cold NREL/Valhalla. */
      PLAN_TOTAL_TIMEOUT_MS: process.env.PLAN_TOTAL_TIMEOUT_MS ?? "240000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  proc.stderr.on("data", (d) => {
    // eslint-disable-next-line no-console
    console.error(String(d).trim());
  });

  return proc;
}

async function postPlan(body) {
  const controller = new AbortController();
  const timeoutMs = 240000;
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

/** Short NC triangle: two driving legs, chargers along I-40 / Triangle corridor. */
const MULTI_LEG = {
  start: "Cary, NC",
  waypoints: ["Raleigh, NC"],
  end: "Durham, NC"
};

async function main() {
  const proc = startServer();
  try {
    await waitForHealth({ timeoutMs: 60000 });

    const baseline = await postPlan({
      ...MULTI_LEG,
      includeCandidates: true
    });
    assert(baseline.json, "baseline /plan returned JSON");
    assert(
      baseline.json.responseVersion === "v2-1",
      `expected responseVersion v2-1, got ${baseline.json.responseVersion}`
    );
    assert(
      baseline.json.status === "ok",
      `baseline multi-leg expected ok, got ${baseline.json.status}: ${baseline.json.message ?? ""}`
    );
    const chargers = baseline.json.candidates?.chargers;
    assert(
      Array.isArray(chargers) && chargers.length >= 1,
      "expected at least one candidate charger for baseline multi-leg"
    );
    const lockId = String(chargers[0].id);

    const locked = await postPlan({
      ...MULTI_LEG,
      includeCandidates: true,
      lockedChargersByLeg: [[lockId], []]
    });
    assert(locked.json, "locked /plan returned JSON");
    assert(
      locked.json.responseVersion === "v2-1",
      `expected responseVersion v2-1, got ${locked.json.responseVersion}`
    );
    if (locked.json.status !== "ok") {
      const ec = locked.json.errorCode ?? "";
      assert(
        ec === "INFEASIBLE_CHARGER_LOCK" ||
          ec === "LOCKED_ROUTE_TOO_LONG" ||
          ec === "UNKNOWN_CHARGER_LOCK",
        `locked plan: expected ok or known lock error, got status=${locked.json.status} errorCode=${ec} msg=${locked.json.message ?? ""}`
      );
    }

    const badShape = await postPlan({
      ...MULTI_LEG,
      includeCandidates: true,
      lockedChargersByLeg: [[lockId]]
    });
    assert(badShape.json, "bad-shape /plan returned JSON");
    assert(
      badShape.respStatus === 400,
      `expected HTTP 400 for INVALID_LOCK_LEGS, got ${badShape.respStatus}`
    );
    assert(
      badShape.json.status === "error",
      "expected status error for wrong lock row count"
    );
    assert(
      badShape.json.errorCode === "INVALID_LOCK_LEGS",
      `expected INVALID_LOCK_LEGS, got ${badShape.json.errorCode}`
    );

    console.log("e2e-multileg-locks-smoke: ok");
  } finally {
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
