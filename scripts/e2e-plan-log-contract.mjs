/**
 * Functional E2E: log contract for `deploymentEnv` + `requestId` correlation.
 *
 * Also performs a second `POST /plan` with `includeCandidates: true` and asserts `responseVersion: "v2-1"`
 * (and `candidates` when `status === "ok"`).
 *
 * It asserts that structured JSON log lines emitted during `/plan` include:
 * - `deploymentEnv` (string)
 * - `requestId` matching the header-provided requestId
 *
 * Run:
 *   node scripts/e2e-plan-log-contract.mjs
 *
 * Env overrides:
 *   API_PORT (default 3003)
 *   DEPLOYMENT_ENV (default dev-local)
 */

import { execSync, spawn } from "node:child_process";
import readline from "node:readline";
import process from "node:process";

const API_PORT = Number(process.env.API_PORT ?? "3010");
const API_BASE = process.env.API_BASE ?? `http://localhost:${API_PORT}`;
const expectedDeploymentEnv = (process.env.DEPLOYMENT_ENV ?? "dev-local").trim().toLowerCase();

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
  execSync("npm -w api run build", { stdio: "inherit" });

  const serverEntry = "api/dist/api/src/server.js";
  const proc = spawn("node", [serverEntry], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(API_PORT),
      DEPLOYMENT_ENV: expectedDeploymentEnv,
      SOURCE_ROUTING_MODE: "remote_only",
      PLAN_LOG_REQUESTS: "true"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  proc.stderr.on("data", (d) => {
    // eslint-disable-next-line no-console
    console.error(String(d).trim());
  });

  const rl = readline.createInterface({ input: proc.stdout });
  const events = [];
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && typeof obj.event === "string") events.push(obj);
    } catch {
      // ignore
    }
  });

  return { proc, events };
}

async function waitForEvent({ events, predicate, timeoutMs = 20000, pollMs = 200 }) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (events.some(predicate)) return true;
    await sleepMs(pollMs);
  }
  return false;
}

async function runPlan({ requestId }) {
  const body = { start: "Raleigh, NC", end: "Greensboro, NC" };
  const controller = new AbortController();
  const timeoutMs = 180000;
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${API_BASE}/plan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-request-id": requestId
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const json = await resp.json().catch(() => null);
    return { respStatus: resp.status, json };
  } finally {
    clearTimeout(t);
  }
}

async function runPlanV2({ requestId }) {
  const body = {
    start: "Raleigh, NC",
    end: "Greensboro, NC",
    includeCandidates: true
  };
  const controller = new AbortController();
  const timeoutMs = 180000;
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${API_BASE}/plan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-request-id": requestId
      },
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
  const requestId = `log-contract-${Date.now()}`;

  const { proc, events } = startServer();
  try {
    await waitForHealth({ timeoutMs: 60000 });

    const planResult = await runPlan({ requestId });
    if (!planResult?.json) {
      // eslint-disable-next-line no-console
      console.warn("e2e-plan-log-contract: /plan returned no JSON; assertions rely on log events only.");
    }

    const v2RequestId = `${requestId}-v2`;
    const v2Result = await runPlanV2({ requestId: v2RequestId });
    assert(v2Result.json, "v2 /plan returned no JSON");
    assert(
      v2Result.json.responseVersion === "v2-1",
      `v2 /plan expected responseVersion v2-1, got ${v2Result.json.responseVersion}`
    );
    if (v2Result.json.status === "ok") {
      assert(v2Result.json.candidates, "v2 /plan expected candidates when ok");
      assert(Array.isArray(v2Result.json.candidates.chargers), "v2 candidates.chargers must be an array");
      assert(Array.isArray(v2Result.json.candidates.hotels), "v2 candidates.hotels must be an array");
    }

    const ok = await waitForEvent({
      events,
      predicate: (e) => e.event === "plan_request_end" && e.requestId === requestId,
      timeoutMs: 20000
    });
    assert(ok, "Timed out waiting for plan_request_end log event");

    const thisEvents = events.filter((e) => e.requestId === requestId && typeof e.event === "string");
    assert(thisEvents.length > 0, "No structured JSON events captured for requestId");

    const byEvent = (eventName) => thisEvents.find((e) => e.event === eventName);

    const planStart = byEvent("plan_request_start");
    const planSel = byEvent("plan_source_selection");
    const planEnd = byEvent("plan_request_end");

    assert(planStart, "Missing plan_request_start");
    assert(planSel, "Missing plan_source_selection");
    assert(planEnd, "Missing plan_request_end");

    for (const e of [planStart, planSel, planEnd]) {
      assert(typeof e.deploymentEnv === "string", `Missing deploymentEnv on ${e.event}`);
      assert(
        e.deploymentEnv === expectedDeploymentEnv,
        `deploymentEnv mismatch on ${e.event}: expected=${expectedDeploymentEnv} got=${e.deploymentEnv}`
      );
      assert(e.requestId === requestId, `requestId mismatch on ${e.event}`);
    }

    // At least one provider_* event should also contain the tag.
    const providerEvent = thisEvents.find((e) => String(e.event).startsWith("provider_"));
    assert(providerEvent, "Missing any provider_* event");
    assert(providerEvent.deploymentEnv === expectedDeploymentEnv, "provider_* deploymentEnv mismatch");

    // Contract: every captured event for this request must include both fields.
    for (const e of thisEvents) {
      assert(typeof e.deploymentEnv === "string", `Contract violation: missing deploymentEnv on ${e.event}`);
      assert(e.requestId === requestId, `Contract violation: requestId mismatch on ${e.event}`);
    }

    console.log("e2e-plan-log-contract: ok");
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

