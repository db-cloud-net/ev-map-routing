/**
 * D1 runnable verification: Docker-compose mirror refresh + planner consumption.
 *
 * What it verifies:
 * - `docker-compose.mirror.yml` can start:
 *   - planner-api
 *   - mirror-refresh-once (one-shot refresh)
 * - After refresh, `api/mirror/current/manifest.json` exists and schemaVersion is `1.0.0`
 * - A short `/plan` request runs with `SOURCE_ROUTING_MODE=local_primary_fallback_remote`
 *   and the API emits required routing/mirror log events (via docker logs):
 *     - `plan_source_selection` (tiers should be `mirror`)
 *     - `mirror_staleness` (mirror was consulted)
 *
 * Usage:
 *   node scripts/d1-verify-mirror.mjs
 *
 * Env:
 *   - NREL_API_KEY must be set (refresh needs it)
 *   - KEEP_RUNNING=true keeps containers running (default false)
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const COMPOSE_FILE = "docker-compose.mirror.yml";
const DOT_ENV_PATH = path.join(REPO_ROOT, ".env");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function dockerComposeBase() {
  // Prefer `docker compose` but fall back to `docker-compose` if needed.
  try {
    execSync("docker compose version", { stdio: "ignore" });
    return "docker compose";
  } catch {
    return "docker-compose";
  }
}

function parseJsonLines(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    const idx = line.indexOf("{");
    if (idx < 0) continue;
    const candidate = line.slice(idx).trim();
    if (!candidate.endsWith("}")) continue;
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object" && typeof obj.event === "string") out.push(obj);
    } catch {
      // ignore
    }
  }
  return out;
}

function loadManifest() {
  const manifestPath = path.join(REPO_ROOT, "api", "mirror", "current", "manifest.json");
  assert(fs.existsSync(manifestPath), `Missing mirror manifest at ${manifestPath}`);
  const raw = fs.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  assert(manifest?.schemaVersion === "1.0.0", `Unexpected manifest.schemaVersion=${manifest?.schemaVersion}`);
  return { manifestPath, manifest };
}

function loadEnvVarFromDotenv(varName) {
  if (!fs.existsSync(DOT_ENV_PATH)) return undefined;
  const raw = fs.readFileSync(DOT_ENV_PATH, "utf8");
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    if (k !== varName) continue;
    const v = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1);
    }
    return v;
  }
  return undefined;
}

async function waitForManifest({ timeoutMs = 180000 } = {}) {
  const t0 = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return loadManifest();
    } catch (e) {
      if (Date.now() - t0 > timeoutMs) throw e;
      await sleepMs(1000);
    }
  }
}

async function main() {
  const keepRunning = (process.env.KEEP_RUNNING ?? "false").toLowerCase() === "true";
  const deploymentEnv = (process.env.DEPLOYMENT_ENV ?? loadEnvVarFromDotenv("DEPLOYMENT_ENV") ?? "production")
    .trim()
    .toLowerCase();

  const nrelApiKey = process.env.NREL_API_KEY ?? loadEnvVarFromDotenv("NREL_API_KEY");
  assert(
    nrelApiKey && nrelApiKey.length > 0,
    "NREL_API_KEY is required to run mirror refresh via docker-compose (set via environment or .env)."
  );

  const compose = dockerComposeBase();
  const composeArgs = `-f ${COMPOSE_FILE}`;

  // Bring up planner.
  console.log("d1-verify-mirror: starting planner-api...");
  execSync(`${compose} ${composeArgs} up -d planner-api`, { stdio: "inherit" });

  // Wait for planner /health.
  const baseHealthUrl = "http://localhost:3001/health";
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    try {
      const r = await fetch(baseHealthUrl, { method: "GET" });
      if (r.ok) break;
    } catch {
      // ignore
    }
    await sleepMs(500);
  }

  // Run refresh job once.
  console.log("d1-verify-mirror: running mirror-refresh-once...");
  execSync(`${compose} ${composeArgs} run --rm mirror-refresh-once`, { stdio: "inherit" });

  console.log("d1-verify-mirror: validating manifest...");
  const { manifestPath } = await waitForManifest();
  console.log(`d1-verify-mirror: manifest ok at ${manifestPath}`);

  // Make a plan call and correlate by requestId.
  const requestId = `d1-verify-${Date.now()}`;
  const planUrl = "http://localhost:3001/plan";
  const body = {
    // Short-ish route; planner still geocodes these strings.
    start: "Raleigh, NC",
    end: "Greensboro, NC"
  };

  console.log("d1-verify-mirror: calling /plan...", planUrl, "requestId=", requestId);
  const resp = await fetch(planUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-request-id": requestId
    },
    body: JSON.stringify(body)
  });
  const json = await resp.json().catch(() => null);
  console.log("d1-verify-mirror: /plan response status=", json?.status ?? resp.status);

  // Inspect logs for correlating events.
  console.log("d1-verify-mirror: inspecting planner-api logs...");
  const logsText = execSync(
    `${compose} ${composeArgs} logs --no-color --tail 2000 planner-api`,
    { encoding: "utf8" }
  );
  const events = parseJsonLines(logsText).filter((e) => e.requestId === requestId);

  const planSourceSel = events.find((e) => e.event === "plan_source_selection");
  assert(planSourceSel, "Missing plan_source_selection for requestId in planner-api logs.");
  assert(
    planSourceSel.deploymentEnv === deploymentEnv,
    `Unexpected deploymentEnv on plan_source_selection: expected=${deploymentEnv} got=${planSourceSel.deploymentEnv}`
  );
  assert(
    planSourceSel.effectiveSourceRoutingMode === "local_primary_fallback_remote",
    `Expected effectiveSourceRoutingMode=local_primary_fallback_remote, got ${planSourceSel.effectiveSourceRoutingMode}`
  );
  assert(planSourceSel.chargersTier === "mirror", "Expected chargersTier=mirror for local-primary mode.");
  assert(planSourceSel.poisTier === "mirror", "Expected poisTier=mirror for local-primary mode.");

  const mirrorStaleness = events.find((e) => e.event === "mirror_staleness");
  assert(mirrorStaleness, "Missing mirror_staleness for requestId (mirror not consulted).");
  assert(typeof mirrorStaleness.ageHours === "number", "mirror_staleness missing numeric ageHours.");

  console.log("d1-verify-mirror: ok");

  if (!keepRunning) {
    console.log("d1-verify-mirror: stopping containers...");
    try {
      execSync(`${compose} ${composeArgs} down -v`, { stdio: "inherit" });
    } catch {
      // ignore
    }
  } else {
    console.log("d1-verify-mirror: KEEP_RUNNING=true; leaving containers up.");
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

