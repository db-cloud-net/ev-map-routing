/**
 * E2E: Slice 3 `POST /candidates` — corridor pins without full `/plan` solve.
 *
 *   node scripts/e2e-candidates-smoke.mjs
 *
 * Env: API_PORT (default 3014), NREL_API_KEY, Valhalla — same as other planner E2E.
 */

import { execSync, spawn } from "node:child_process";
import process from "node:process";
import { killListenersOnPort } from "./e2e-kill-port.mjs";

const API_PORT = Number(process.env.API_PORT ?? "3014");
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
      E2E_SPAWN_PORT: String(API_PORT),
      DEPLOYMENT_ENV: "dev-local",
      SOURCE_ROUTING_MODE: "remote_only",
      PLAN_LOG_REQUESTS: "false"
    },
    stdio: ["ignore", "inherit", "inherit"]
  });

  return proc;
}

async function postCandidates(body) {
  const controller = new AbortController();
  const timeoutMs = 180000;
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${API_BASE}/candidates`, {
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

    const r = await postCandidates({
      start: "Raleigh, NC",
      end: "Greensboro, NC"
    });
    assert(r.json, "/candidates returned JSON");
    assert(
      r.json.responseVersion === "v2-1-candidates",
      `expected responseVersion v2-1-candidates, got ${r.json.responseVersion}`
    );
    assert(
      r.json.status === "ok",
      `expected status ok, got ${r.json.status}: ${r.json.message ?? ""}`
    );
    assert(
      Array.isArray(r.json.candidates?.chargers) &&
        r.json.candidates.chargers.length >= 1,
      "expected at least one charger candidate"
    );

    const bad = await postCandidates({
      end: "Greensboro, NC"
    });
    assert(bad.json?.status === "error" || bad.respStatus === 400, "missing start+replan should fail");

    console.log("e2e-candidates-smoke: ok");
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
