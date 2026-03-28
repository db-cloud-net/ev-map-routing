#!/usr/bin/env node
/**
 * Sweep GET /pois/hotel-charger-pairs max_distance_yd against a POI Services base URL.
 * Usage: POI_SERVICES_BASE_URL=http://host:8010 node scripts/poi-hotel-charger-distance-sweep.mjs
 */

const base = (process.env.POI_SERVICES_BASE_URL ?? "http://192.168.86.38:8010").trim().replace(/\/$/, "");

/** Broad bbox — adjust if your shards are regional */
const BBOX = {
  south: Number(process.env.SWEEP_SOUTH ?? "33"),
  west: Number(process.env.SWEEP_WEST ?? "-90"),
  north: Number(process.env.SWEEP_NORTH ?? "37"),
  east: Number(process.env.SWEEP_EAST ?? "-75")
};

const distances = [80, 100, 200, 300, 400, 500, 600, 1000, 1320, 2640];

async function main() {
  const health = await fetch(`${base}/health`);
  console.log(`GET ${base}/health → ${health.status}`);
  console.log(await health.text());
  console.log("");

  const probe = await fetch(
    `${base}/pois/nearby?lat=35.77&lon=-78.63&radius_mi=200&limit=3`
  );
  console.log(`Nearby probe (Raleigh 200mi): ${probe.status}`, await probe.text());
  console.log("");

  console.log(`Bbox:`, BBOX);
  console.log(`GET /pois/hotel-charger-pairs — max_distance_yd (OpenAPI max often 1000)`);
  console.log("");

  const rows = [];
  for (const yd of distances) {
    const u = new URL(`${base}/pois/hotel-charger-pairs`);
    u.searchParams.set("south", String(BBOX.south));
    u.searchParams.set("west", String(BBOX.west));
    u.searchParams.set("north", String(BBOX.north));
    u.searchParams.set("east", String(BBOX.east));
    u.searchParams.set("max_distance_yd", String(yd));
    u.searchParams.set("limit", "5000");
    const r = await fetch(u);
    const txt = await r.text();
    let j;
    try {
      j = JSON.parse(txt);
    } catch {
      rows.push({ max_distance_yd: yd, http: r.status, error: txt.slice(0, 120) });
      continue;
    }
    if (!r.ok) {
      rows.push({ max_distance_yd: yd, http: r.status, error: j.error || txt.slice(0, 120) });
      continue;
    }
    const pairs = j.pairs ?? [];
    const hotelIds = new Set(pairs.map((p) => p.hotel?.id).filter((x) => x != null));
    rows.push({
      max_distance_yd: yd,
      http: r.status,
      pairCount: j.count ?? pairs.length,
      uniqueHotels: hotelIds.size
    });
  }
  console.table(rows);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
