#!/usr/bin/env node
/**
 * Validate POI Services HTTP responses: hotels, DCFC vs L2 chargers (by power_kw), hotel↔DCFC pairs.
 *
 * Usage:
 *   POI_SERVICES_BASE_URL=http://poi:8010 node scripts/poi-container-data-validation.mjs
 *   POI_SERVICES_BASE_URL=http://192.168.x.x:8010 node scripts/poi-container-data-validation.mjs
 *
 * Classification (chargers only): power_kw >= 50 → DCFC; 0 < power_kw < 50 → L2 (typical NREL/L2 band).
 * Adjust thresholds in this file if your pipeline tags differ.
 */

const base = (process.env.POI_SERVICES_BASE_URL ?? "http://localhost:8010").trim().replace(/\/$/, "");

/** Wide US bbox — must intersect populated shards */
const BBOX = {
  south: Number(process.env.POI_VALIDATE_SOUTH ?? "24.5"),
  west: Number(process.env.POI_VALIDATE_WEST ?? "-124.5"),
  north: Number(process.env.POI_VALIDATE_NORTH ?? "49.5"),
  east: Number(process.env.POI_VALIDATE_EAST ?? "-66.5")
};

const DCFC_MIN_KW = Number(process.env.POI_DCFC_MIN_KW ?? "50");

function classifyCharger(p) {
  const kw = p.power_kw;
  if (kw == null || kw === "" || !Number.isFinite(Number(kw)) || Number(kw) <= 0) {
    return "unknown";
  }
  const k = Number(kw);
  if (k >= DCFC_MIN_KW) return "dcfc";
  return "l2";
}

async function getJson(url, init) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
    ...init
  });
  const t = await r.text();
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    throw new Error(`Non-JSON ${r.status}: ${t.slice(0, 200)}`);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${j.error || t.slice(0, 200)}`);
  return j;
}

async function main() {
  console.log(`POI_SERVICES_BASE_URL=${base}\n`);

  const health = await getJson(`${base}/health`);
  console.log("GET /health");
  console.log(JSON.stringify(health, null, 2));
  console.log("");

  const lim = 25000;
  const hotelUrl = new URL(`${base}/pois`);
  hotelUrl.searchParams.set("south", String(BBOX.south));
  hotelUrl.searchParams.set("west", String(BBOX.west));
  hotelUrl.searchParams.set("north", String(BBOX.north));
  hotelUrl.searchParams.set("east", String(BBOX.east));
  hotelUrl.searchParams.set("poi_type", "hotel");
  hotelUrl.searchParams.set("limit", String(lim));

  const chUrl = new URL(`${base}/pois`);
  chUrl.searchParams.set("south", String(BBOX.south));
  chUrl.searchParams.set("west", String(BBOX.west));
  chUrl.searchParams.set("north", String(BBOX.north));
  chUrl.searchParams.set("east", String(BBOX.east));
  chUrl.searchParams.set("poi_type", "charger");
  chUrl.searchParams.set("limit", String(lim));

  const hotels = await getJson(hotelUrl.toString());
  const chargers = await getJson(chUrl.toString());

  console.log(`GET /pois poi_type=hotel  bbox=`, BBOX);
  console.log(`  count=${hotels.count}  returned=${hotels.pois?.length ?? 0}`);
  if (hotels.pois?.length) {
    const h = hotels.pois[0];
    console.log(
      `  sample: id=${h.id} name=${String(h.name).slice(0, 50)} lat=${h.lat} lon=${h.lon} onsite=${h.onsite_charger_level || "—"}`
    );
  }

  console.log("");
  console.log(`GET /pois poi_type=charger  (DCFC: power_kw>=${DCFC_MIN_KW} kW)`);
  console.log(`  count=${chargers.count}  returned=${chargers.pois?.length ?? 0}`);
  let dcfc = 0;
  let l2 = 0;
  let unk = 0;
  for (const p of chargers.pois ?? []) {
    const c = classifyCharger(p);
    if (c === "dcfc") dcfc++;
    else if (c === "l2") l2++;
    else unk++;
  }
  console.log(`  classified: dcfc=${dcfc}  l2=${l2}  unknown_power=${unk}`);
  const ch = (chargers.pois ?? []).find((p) => classifyCharger(p) === "dcfc");
  const ch2 = (chargers.pois ?? []).find((p) => classifyCharger(p) === "l2");
  if (ch) {
    console.log(
      `  sample DCFC: id=${ch.id} ${String(ch.name).slice(0, 45)} ${ch.power_kw}kW ${ch.city || ""}`
    );
  }
  if (ch2) {
    console.log(
      `  sample L2:  id=${ch2.id} ${String(ch2.name).slice(0, 45)} ${ch2.power_kw}kW ${ch2.city || ""}`
    );
  }

  const pairsUrl = new URL(`${base}/pois/hotel-charger-pairs`);
  pairsUrl.searchParams.set("south", String(BBOX.south));
  pairsUrl.searchParams.set("west", String(BBOX.west));
  pairsUrl.searchParams.set("north", String(BBOX.north));
  pairsUrl.searchParams.set("east", String(BBOX.east));
  pairsUrl.searchParams.set("max_distance_yd", "400");
  pairsUrl.searchParams.set("limit", "5000");
  const pairs = await getJson(pairsUrl.toString());

  console.log("");
  console.log("GET /pois/hotel-charger-pairs max_distance_yd=400");
  console.log(`  pair count=${pairs.count}  returned=${pairs.pairs?.length ?? 0}`);
  if (pairs.pairs?.length) {
    const p0 = pairs.pairs[0];
    console.log(
      `  sample: hotel=${String(p0.hotel?.name).slice(0, 40)} | DCFC=${String(p0.nearby_dcfc?.name).slice(0, 40)} | ${p0.distance_yd} yd`
    );
  }

  const shape = [
    { lat: 35.77, lon: -78.63 },
    { lat: 36.0, lon: -79.0 }
  ];
  const pairsMaxYd = Math.min(500, Math.max(1, Math.round(Number(process.env.OVERNIGHT_HOTEL_RADIUS_METERS ?? "366") / 0.9144)));
  const corridor = await getJson(`${base}/corridor/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      shape,
      corridor_radius_mi: 30,
      layers: ["charger", "hotel", "pairs"],
      filters: { pairs_max_distance_yd: pairsMaxYd }
    })
  });

  console.log("");
  console.log(
    `POST /corridor/query (NC sample shape, 30mi layers charger+hotel+pairs, pairs_max_distance_yd=${pairsMaxYd})`
  );
  console.log(`  warnings: ${JSON.stringify(corridor.warnings)}`);
  console.log(`  chargers: ${corridor.charger?.length ?? 0}  hotels: ${corridor.hotel?.length ?? 0}  pairs: ${corridor.pairs?.length ?? 0}`);

  const manifestHotels = health.total_hotels;
  const manifestChargers = health.total_chargers;
  const spatialDead =
    (hotels.count ?? 0) === 0 &&
    (chargers.count ?? 0) === 0 &&
    manifestHotels > 0 &&
    manifestChargers > 0;

  console.log("");
  if (spatialDead) {
    console.log(
      "DIAGNOSIS: /health shows total_hotels/total_chargers from manifest, but /pois returned no rows."
    );
    console.log(
      "  → API container likely missing populated SQLite files under DATA_DIR (e.g. /data/shards/*.db)."
    );
    console.log(
      "  → Fix: mount the same poi_data volume as pipeline/updater; see docs/d1-runbook.md (POI on NAS)."
    );
    process.exitCode = 2;
  } else if ((hotels.count ?? 0) > 0 && (chargers.count ?? 0) > 0) {
    console.log("OK: Spatial queries returned data.");
    process.exitCode = 0;
  } else {
    console.log("PARTIAL: Check bbox or shard coverage.");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
