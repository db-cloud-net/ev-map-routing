/**
 * E2E: Slice 4 `POST /route-preview` — single-leg Valhalla preview + horizon maneuvers (no EV solver).
 *
 *   node scripts/e2e-route-preview-smoke.mjs
 *
 * Env: API_PORT (default 3016), Nominatim, Valhalla — same as other planner E2E.
 */

import { execSync, spawn } from "node:child_process";
import process from "node:process";
import { killListenersOnPort } from "./e2e-kill-port.mjs";

const API_PORT = Number(process.env.API_PORT ?? "3016");
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
      PLAN_LOG_REQUESTS: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  proc.stderr.on("data", (d) => {
    // eslint-disable-next-line no-console
    console.error(String(d).trim());
  });

  return proc;
}

async function postRoutePreview(body) {
  const controller = new AbortController();
  const timeoutMs = 120000;
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${API_BASE}/route-preview`, {
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
  const proc = startServer();
  try {
    await waitForHealth({ timeoutMs: 60000 });

    const r = await postRoutePreview({
      start: "Raleigh, NC",
      end: "Greensboro, NC"
    });
    assert(r.json, "/route-preview returned JSON");
    assert(
      r.json.responseVersion === "v2-1-route-preview",
      `expected responseVersion v2-1-route-preview, got ${r.json.responseVersion}`
    );
    assert(
      r.json.status === "ok",
      `expected status ok, got ${r.json.status}: ${r.json.message ?? ""}`
    );
    assert(
      r.json.preview?.polyline?.type === "LineString" &&
        Array.isArray(r.json.preview.polyline.coordinates) &&
        r.json.preview.polyline.coordinates.length >= 2,
      "expected preview.polyline LineString with coordinates"
    );
    assert(
      Array.isArray(r.json.preview?.horizon?.maneuvers) &&
        r.json.preview.horizon.maneuvers.length >= 1,
      "expected at least one horizon maneuver"
    );
    const p = r.json.preview;
    if (p.nextHorizon) {
      assert(
        Array.isArray(p.nextHorizon.maneuvers),
        "when nextHorizon is present, maneuvers must be an array"
      );
      assert(
        p.nextHorizon.maneuvers.length >= 1,
        "expected nextHorizon to include at least one maneuver when present (Raleigh→Greensboro corridor)"
      );
    }

    const badWp = await postRoutePreview({
      start: "Raleigh, NC",
      end: "Greensboro, NC",
      waypoints: ["Durham, NC"]
    });
    assert(
      badWp.respStatus === 400,
      "waypoints should fail validation in v1"
    );

    console.log("e2e-route-preview-smoke: ok");
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
