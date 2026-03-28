/**
 * Functional E2E: async `POST /plan` with `planJob: true` → 202 + poll `GET /plan/jobs/:id`.
 *
 * Run: node scripts/e2e-plan-job.mjs
 * Env: API_PORT (default 3011), DEPLOYMENT_ENV (default dev-local)
 */

import { execSync, spawn } from "node:child_process";
import process from "node:process";
import { killListenersOnPort } from "./e2e-kill-port.mjs";
import { startPoiCorridorMock } from "./e2e-poi-corridor-mock.mjs";

const API_PORT = Number(process.env.API_PORT ?? "3011");
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
      DEPLOYMENT_ENV: (process.env.DEPLOYMENT_ENV ?? "dev-local").trim(),
      POI_SERVICES_BASE_URL: poiBaseUrl,
      PLAN_LOG_REQUESTS: "false"
    },
    stdio: ["ignore", "inherit", "inherit"]
  });

  return { proc };
}

async function pollJob(jobId) {
  const resp = await fetch(`${API_BASE}/plan/jobs/${jobId}`, { method: "GET" });
  const json = await resp.json().catch(() => null);
  return { respStatus: resp.status, json };
}

async function main() {
  const requestId = `plan-job-${Date.now()}`;
  const poiMock = await startPoiCorridorMock();
  try {
    const { proc } = startServer(poiMock.baseUrl);
    try {
      await waitForHealth({ timeoutMs: 60000 });

    const postResp = await fetch(`${API_BASE}/plan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-request-id": requestId
      },
      body: JSON.stringify({
        start: "Raleigh, NC",
        end: "Greensboro, NC",
        planJob: true
      })
    });
    const postJson = await postResp.json().catch(() => null);
    assert(postResp.status === 202, `POST /plan planJob expected 202, got ${postResp.status}`);
    assert(postJson?.jobId, "expected jobId in 202 body");
    assert(
      postJson?.responseVersion === "v2-1",
      `expected responseVersion v2-1 for planJob, got ${postJson?.responseVersion}`
    );
    assert(postJson?.status === "running", "expected status running in 202 body");
    assert(
      typeof postJson?.pollUrl === "string" && postJson.pollUrl.includes(postJson.jobId),
      "expected pollUrl containing jobId"
    );
    assert(
      typeof postJson?.streamUrl === "string" && postJson.streamUrl.includes(postJson.jobId),
      "expected streamUrl containing jobId"
    );
    assert(
      typeof postJson?.eventsUrl === "string" && postJson.eventsUrl.includes(postJson.jobId),
      "expected eventsUrl containing jobId"
    );

    const jobId = postJson.jobId;
    let last;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const { respStatus, json } = await pollJob(jobId);
      assert(respStatus === 200, `GET /plan/jobs/:id expected 200, got ${respStatus}`);
      assert(json?.status, "poll missing status");
      last = json;
      if (json.status === "complete" || json.status === "error") break;
      assert(json.status === "running", `unexpected job status ${json.status}`);
      await sleepMs(400);
    }

    assert(last, "no poll response");
    assert(
      last.status === "complete" || last.status === "error",
      `job did not finish in time, last status=${last.status}`
    );

    if (last.status === "complete") {
      assert(last.result, "complete job missing result");
      assert(Array.isArray(last.checkpoints), "checkpoints must be an array");
      assert(
        last.result.status === "ok",
        `expected result.status ok, got ${last.result.status}`
      );
    }

    const streamResp = await fetch(`${API_BASE}/plan/jobs/${jobId}/stream`, { method: "GET" });
    assert(streamResp.ok, `GET /plan/jobs/:id/stream expected 200, got ${streamResp.status}`);
    const streamText = await streamResp.text();
    const streamLines = streamText
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    assert(streamLines.length >= 1, "NDJSON stream expected at least one line");
    const lastStream = JSON.parse(streamLines[streamLines.length - 1]);
    assert(
      lastStream.type === "complete" || lastStream.type === "error",
      `stream terminal event expected complete|error, got ${lastStream.type}`
    );

    const sseResp = await fetch(`${API_BASE}/plan/jobs/${jobId}/events`, { method: "GET" });
    assert(sseResp.ok, `GET /plan/jobs/:id/events expected 200, got ${sseResp.status}`);
    assert(
      String(sseResp.headers.get("content-type") || "").includes("text/event-stream"),
      "SSE expected Content-Type text/event-stream"
    );
    const sseText = await sseResp.text();
    const sseData = [];
    for (const line of sseText.split("\n")) {
      if (line.startsWith("data: ")) {
        sseData.push(JSON.parse(line.slice(6)));
      }
    }
    assert(sseData.length >= 1, "SSE expected at least one data: line");
    const lastSse = sseData[sseData.length - 1];
    assert(
      lastSse.type === "complete" || lastSse.type === "error",
      `SSE terminal event expected complete|error, got ${lastSse.type}`
    );

      console.log("e2e-plan-job: ok");
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
  console.error(err);
  process.exit(1);
});
