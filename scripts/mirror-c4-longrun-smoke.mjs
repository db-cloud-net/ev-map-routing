/**
 * End-to-end smoke harness for C4 observability wiring.
 *
 * What it verifies (log-based, via stdout parsing):
 * - `plan_source_selection` always emitted
 * - `dual_read_compare` emits divergence + timings under `dual_read_compare`
 * - `mirror_staleness` is emitted (when mirror tier is consulted)
 * - `rollback_triggered` is emitted when `SOURCE_ROUTING_MODE_FORCE=remote_only`
 *
 * Usage:
 *   node scripts/mirror-c4-longrun-smoke.mjs
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
    await sleepMs(500);
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
    // ignore: build errors will surface in server stderr anyway
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
      // ignore non-JSON
    }
  });

  return { proc, rl, events };
}

async function runOneMode({ port, mode, forceMode, requestId }) {
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

    // Use coordinates-as-strings to reduce ambiguity. (Planner still geocodes via Nominatim.)
    const body = {
      start: "35.77937,-78.638203",
      end: "36.072,-78.907"
    };

    const resp = await fetch(planUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-request-id": requestId
      },
      body: JSON.stringify(body)
    });
    const json = await resp.json();

    if (json?.status !== "ok") {
      console.log(
        "mirror-c4-longrun-smoke: /plan returned non-ok (continuing log assertions).",
        "status=",
        json?.status,
        "requestId=",
        requestId,
        "message=",
        json?.message ?? ""
      );
    }

    // Wait until we observe plan completion logs for this requestId.
    const waitStart = Date.now();
    while (Date.now() - waitStart < 15000) {
      if (events.some((e) => e.event === "plan_request_end" && e.requestId === requestId)) break;
      await sleepMs(300);
    }

    const forThisReq = events.filter((e) => e.requestId === requestId);
    const mirrorAll = events.filter((e) => e.event === "mirror_staleness");

    return { proc, events: forThisReq, allEvents: events, mirrorAll, rawResponse: json };
  } finally {
    // best-effort stop server
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

async function main() {
  const dualPort = Number(process.env.C4_DUAL_PORT ?? "3013");
  const rollbackPort = Number(process.env.C4_ROLLBACK_PORT ?? "3014");

  const dualReqId = "c4-longrun-dual-1";
  const rollbackReqId = "c4-longrun-rollback-1";

  const dual = await runOneMode({
    port: dualPort,
    mode: "dual_read_compare",
    forceMode: undefined,
    requestId: dualReqId
  });

  const planSourceSel = dual.events.find((e) => e.event === "plan_source_selection");
  assert(planSourceSel, "Missing plan_source_selection in dual_read_compare mode");
  assert(typeof planSourceSel.deploymentEnv === "string", "plan_source_selection missing deploymentEnv");
  assert(planSourceSel.effectiveSourceRoutingMode === "dual_read_compare", "Unexpected effectiveSourceRoutingMode for dual mode");

  const mirrorStaleness = dual.events.find((e) => e.event === "mirror_staleness");
  if (!mirrorStaleness) {
    const hasMirror = dual.mirrorAll.length > 0;
    if (!hasMirror) {
      throw new Error("Missing mirror_staleness entirely in dual_read_compare mode");
    }
    // Provide context to help diagnose requestId propagation.
    console.log("mirror_staleness emitted but not under requestId filter. mirrorAllSample=", dual.mirrorAll.slice(0, 3));
  } else {
    assert(mirrorStaleness, "Missing mirror_staleness in dual_read_compare mode");
    assert(typeof mirrorStaleness.deploymentEnv === "string", "mirror_staleness missing deploymentEnv");
  }

  const dualRead = dual.events.find((e) => e.event === "dual_read_compare");
  assert(dualRead, "Missing dual_read_compare events in dual_read_compare mode");
  assert(typeof dualRead.deploymentEnv === "string", "dual_read_compare missing deploymentEnv");
  assert(typeof dualRead.mismatchSeverity === "string", "dual_read_compare missing mismatchSeverity");
  assert(typeof dualRead.mirrorDurationMs === "number", "dual_read_compare missing mirrorDurationMs");
  assert(typeof dualRead.remoteDurationMs === "number", "dual_read_compare missing remoteDurationMs");
  assert(typeof dualRead.compareDurationMs === "number", "dual_read_compare missing compareDurationMs");

  const rollback = await runOneMode({
    port: rollbackPort,
    mode: "dual_read_compare",
    forceMode: "remote_only",
    requestId: rollbackReqId
  });

  const rollbackTriggered = rollback.events.find((e) => e.event === "rollback_triggered");
  assert(rollbackTriggered, "Missing rollback_triggered under SOURCE_ROUTING_MODE_FORCE=remote_only");
  assert(typeof rollbackTriggered.deploymentEnv === "string", "rollback_triggered missing deploymentEnv");
  assert(rollbackTriggered.rollbackTriggered === true, "rollback_triggered.rollbackTriggered must be true");
  assert(rollbackTriggered.rollbackReason?.operatorOverride === "SOURCE_ROUTING_MODE_FORCE=remote_only", "Unexpected rollbackReason.operatorOverride");

  console.log("mirror-c4-longrun-smoke: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

