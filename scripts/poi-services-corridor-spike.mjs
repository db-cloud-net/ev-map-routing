#!/usr/bin/env node
/**
 * Spike: measure POST /corridor/query latency (POI Services v2).
 * Requires POI_SERVICES_BASE_URL (e.g. http://localhost:8010).
 *
 * Usage:
 *   POI_SERVICES_BASE_URL=http://localhost:8010 node scripts/poi-services-corridor-spike.mjs
 */

const base = (process.env.POI_SERVICES_BASE_URL ?? "").trim().replace(/\/$/, "");
if (!base) {
  console.error("Set POI_SERVICES_BASE_URL to the POI Services base URL.");
  process.exit(1);
}

/** Short I-40-ish corridor in NC (lat/lon), min 2 points */
const shape = [
  { lat: 35.7796, lon: -78.6382 },
  { lat: 35.96, lon: -79.1 },
  { lat: 36.0726, lon: -79.792 }
];

async function main() {
  const body = {
    shape,
    corridor_radius_mi: Number(process.env.SPIKE_CORRIDOR_RADIUS_MI ?? "30"),
    layers: ["charger", "hotel", "edges"]
  };

  const t0 = performance.now();
  const res = await fetch(`${base}/corridor/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body)
  });
  const ms = Math.round(performance.now() - t0);

  const text = await res.text();
  if (!res.ok) {
    console.error(`HTTP ${res.status} in ${ms}ms\n${text.slice(0, 800)}`);
    process.exit(1);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error("non-JSON response");
    process.exit(1);
  }

  const nCh = json.charger?.length ?? 0;
  const nHot = json.hotel?.length ?? 0;
  const nEdge = json.edges?.length ?? 0;
  const warn = json.warnings?.length ?? 0;

  console.log(
    JSON.stringify(
      {
        ok: true,
        poiServicesMs: ms,
        chargers: nCh,
        hotels: nHot,
        edges: nEdge,
        warnings: warn,
        corridor: json.corridor
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
