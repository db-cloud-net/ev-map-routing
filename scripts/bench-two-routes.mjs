/**
 * Two-route plan benchmark: wall time + legs / rangeLegs / stop breakdown.
 * Usage: node scripts/bench-two-routes.mjs
 * Env: API_BASE (default http://localhost:3001)
 */
import process from "node:process";

const API_BASE = (process.env.API_BASE ?? "http://localhost:3001").replace(/\/$/, "");
const POLL_MS = 2000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function summarizeStops(stops) {
  const by = {};
  for (const s of stops ?? []) {
    by[s.type] = (by[s.type] ?? 0) + 1;
  }
  return by;
}

async function runPlan(label, body) {
  const t0 = Date.now();
  const requestId = `bench-${label}-${Date.now()}`;
  const post = await fetch(`${API_BASE}/plan`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId
    },
    body: JSON.stringify({
      ...body,
      planJob: true,
      includeCandidates: true
    })
  });
  const postJson = await post.json().catch(() => null);
  if (post.status !== 202) {
    return {
      label,
      error: `POST expected 202, got ${post.status}`,
      postBody: postJson
    };
  }
  const { jobId } = postJson;
  let last;
  const deadline = Date.now() + 60 * 60 * 1000; // 1h max
  while (Date.now() < deadline) {
    const pr = await fetch(`${API_BASE}/plan/jobs/${jobId}`);
    last = await pr.json().catch(() => null);
    if (!last) {
      await sleep(POLL_MS);
      continue;
    }
    if (last.status === "complete" || last.status === "error") break;
    await sleep(POLL_MS);
  }
  const wallMs = Date.now() - t0;

  if (!last || (last.status !== "complete" && last.status !== "error")) {
    return {
      label,
      error: "job did not finish in time",
      wallMs,
      jobId,
      lastStatus: last?.status
    };
  }

  if (last.status === "error") {
    return {
      label,
      error: last.message ?? "job error",
      httpStatus: last.httpStatus,
      wallMs,
      jobId,
      checkpointsCount: Array.isArray(last.checkpoints) ? last.checkpoints.length : 0
    };
  }

  const result = last.result;
  const stops = result?.stops ?? [];
  const legs = result?.legs ?? [];
  const rangeLegs = result?.rangeLegs ?? result?.debug?.rangeLegs ?? [];
  const dbg = result?.debug ?? {};
  const multiLeg = dbg.multiLeg === true;
  const autoWp = dbg.autoWaypoints;

  return {
    label,
    wallMs,
    wallMinutes: Math.round((wallMs / 60000) * 100) / 100,
    jobId,
    requestId,
    resultStatus: result?.status,
    message: result?.message ?? null,
    checkpointsCount: Array.isArray(last.checkpoints) ? last.checkpoints.length : 0,
    legsCount: legs.length,
    rangeLegsCount: Array.isArray(rangeLegs) ? rangeLegs.length : 0,
    stopsCount: stops.length,
    stopsByType: summarizeStops(stops),
    totals: result?.totals ?? null,
    multiLeg,
    autoWaypoints: autoWp ?? null,
    legCountDebug: dbg.legCount ?? null
  };
}

async function main() {
  console.log(`API_BASE=${API_BASE}\n`);

  const run1 = await runPlan("A_direct", {
    start: "Raleigh, NC",
    end: "Seattle, WA"
  });
  console.log("=== Run A: Raleigh, NC → Seattle, WA (no waypoints) ===");
  console.log(JSON.stringify(run1, null, 2));

  const run2 = await runPlan("B_waypoints", {
    start: "Raleigh, NC",
    end: "Seattle, WA",
    waypoints: ["Sioux Falls, SD", "Bozeman, MT"]
  });
  console.log("\n=== Run B: Raleigh, NC → Sioux Falls, SD → Bozeman, MT → Seattle, WA ===");
  console.log(JSON.stringify(run2, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
