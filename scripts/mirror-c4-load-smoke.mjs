/**
 * Extended load smoke for C4 observability.
 *
 * Runs (2x by default) multiple /plan requests per routing mode while keeping
 * the server process alive, and asserts the required C4 log events appear for
 * each requestId.
 *
 * Usage:
 *   node scripts/mirror-c4-load-smoke.mjs
 * Env:
 *   C4_ITERATIONS=2
 *   C4_DUAL_PORT=3015
 *   C4_ROLLBACK_PORT=3016
 */

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";

const REPO_ROOT = process.cwd();

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth({ baseUrl, timeoutMs = 60000 }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`${baseUrl}/health`);
      const json = await resp.json();
      if (json?.ok) return;
    } catch {
      // ignore
    }
    await sleepMs(400);
  }
  throw new Error(`Timed out waiting for ${baseUrl}/health`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function startServer({ port, sourceRoutingMode, forceMode, planLogRequests }) {
  // Ensure compiled dist exists.
  try {
    execSync("npm -w api run build", { stdio: "ignore" });
  } catch {
    // ignore
  }

  const serverEntry = "api/dist/api/src/server.js";
  const proc = spawn("node", [serverEntry], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SOURCE_ROUTING_MODE: sourceRoutingMode,
      ...(forceMode ? { SOURCE_ROUTING_MODE_FORCE: forceMode } : {}),
      MIRROR_ROOT:
        process.env.MIRROR_ROOT ??
        (fs.existsSync("mirror/current/manifest.json")
          ? "mirror"
          : fs.existsSync("api/mirror/current/manifest.json")
            ? "api/mirror"
            : "mirror"),
      PLAN_LOG_REQUESTS: planLogRequests ? "true" : "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
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

async function planOnce({ planUrl, requestId, body }) {
  const resp = await fetch(planUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-request-id": requestId },
    body: JSON.stringify(body)
  });
  const json = await resp.json();
  return json;
}

async function waitForEvent({ events, predicate, timeoutMs = 20000, pollMs = 250 }) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (events.some(predicate)) return true;
    await sleepMs(pollMs);
  }
  return false;
}

async function runMode({ port, mode, forceMode, iterations, kind, body }) {
  const baseUrl = `http://localhost:${port}`;
  const planUrl = `${baseUrl}/plan`;

  const { proc, events } = startServer({
    port,
    sourceRoutingMode: mode,
    forceMode,
    planLogRequests: true
  });

  try {
    await waitForHealth({ baseUrl, timeoutMs: 60000 });

    for (let i = 0; i < iterations; i++) {
      const requestId = `${kind}-${i + 1}`;

      const json = await planOnce({ planUrl, requestId, body });
      if (json?.status !== "ok") {
        console.log(
          "mirror-c4-load-smoke: /plan returned non-ok (continuing log assertions).",
          "requestId=",
          requestId,
          "status=",
          json?.status,
          "message=",
          json?.message ?? ""
        );
      }

      // Wait for at least plan_request_end so logs for this request have landed.
      const ok = await waitForEvent({
        events,
        predicate: (e) => e.event === "plan_request_end" && e.requestId === requestId,
        timeoutMs: 20000
      });
      assert(ok, `Timed out waiting for plan_request_end for ${requestId}`);

      const thisEvents = events.filter((e) => e.requestId === requestId);

      const planSourceSel = thisEvents.find((e) => e.event === "plan_source_selection");
      assert(planSourceSel, `Missing plan_source_selection for ${requestId}`);
      assert(typeof planSourceSel.deploymentEnv === "string", `plan_source_selection missing deploymentEnv for ${requestId}`);

      if (forceMode === "remote_only") {
        assert(
          planSourceSel.effectiveSourceRoutingMode === "remote_only",
          `Expected effectiveSourceRoutingMode=remote_only for ${requestId}`
        );
        const rollbackTriggered = thisEvents.find((e) => e.event === "rollback_triggered");
        assert(rollbackTriggered, `Missing rollback_triggered for ${requestId}`);
        assert(typeof rollbackTriggered.deploymentEnv === "string", `rollback_triggered missing deploymentEnv for ${requestId}`);
        assert(rollbackTriggered.rollbackTriggered === true, `rollbackTriggered must be true for ${requestId}`);
      } else {
        const mirrorStaleness = thisEvents.find((e) => e.event === "mirror_staleness");
        assert(mirrorStaleness, `Missing mirror_staleness for ${requestId}`);
        assert(typeof mirrorStaleness.deploymentEnv === "string", `mirror_staleness missing deploymentEnv for ${requestId}`);

        const dualRead = thisEvents.find((e) => e.event === "dual_read_compare");
        assert(dualRead, `Missing dual_read_compare for ${requestId}`);
        assert(typeof dualRead.deploymentEnv === "string", `dual_read_compare missing deploymentEnv for ${requestId}`);
        assert(typeof dualRead.mismatchSeverity === "string", `dual_read_compare missing mismatchSeverity for ${requestId}`);
        assert(typeof dualRead.mirrorDurationMs === "number", `dual_read_compare missing mirrorDurationMs for ${requestId}`);
        assert(typeof dualRead.remoteDurationMs === "number", `dual_read_compare missing remoteDurationMs for ${requestId}`);
        assert(typeof dualRead.compareDurationMs === "number", `dual_read_compare missing compareDurationMs for ${requestId}`);
      }
    }
  } finally {
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

async function main() {
  const iterations = Number(process.env.C4_ITERATIONS ?? "2");
  const dualPort = Number(process.env.C4_DUAL_PORT ?? "3015");
  const rollbackPort = Number(process.env.C4_ROLLBACK_PORT ?? "3016");

  const body = {
    // coordinates-as-strings reduce ambiguity; planner still geocodes these strings via Nominatim
    start: "35.77937,-78.638203",
    end: "36.072,-78.907"
  };

  await runMode({
    port: dualPort,
    mode: "dual_read_compare",
    forceMode: undefined,
    iterations,
    kind: "c4-load-dual",
    body
  });

  await runMode({
    port: rollbackPort,
    mode: "dual_read_compare",
    forceMode: "remote_only",
    iterations,
    kind: "c4-load-rollback",
    body
  });

  console.log("mirror-c4-load-smoke: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

