require("dotenv").config();

async function main() {
  const rangeMiles = Number(process.env.EV_RANGE_MILES ?? "260");
  const bufferSoc = Number(process.env.CHARGE_BUFFER_SOC ?? "0.1");
  const radiusMiles = Number(process.env.NREL_RADIUS_MILES ?? "120");
  const sampleCount = Number(process.env.NREL_CORRIDOR_SAMPLE_POINTS ?? "5");
  const cap = Number(process.env.CANDIDATE_CHARGERS_CAP ?? "25");
  const key = process.env.NREL_API_KEY;
  const ua = "ev-map-routing-mvp/0.1";

  if (!key) throw new Error("Missing NREL_API_KEY");

  const geocodeBase = "https://nominatim.openstreetmap.org/search";
  const geocode = async (q) => {
    const r = await fetch(`${geocodeBase}?q=${encodeURIComponent(q)}&format=json&limit=1`, {
      headers: { "User-Agent": ua }
    });
    const j = await r.json();
    if (!j?.[0]?.lat || !j?.[0]?.lon) throw new Error(`No geocode for ${q}`);
    return { lat: Number(j[0].lat), lon: Number(j[0].lon) };
  };

  const haversineMiles = (p, q) => {
    const R = 3958.8;
    const dLat = ((q.lat - p.lat) * Math.PI) / 180;
    const dLon = ((q.lon - p.lon) * Math.PI) / 180;
    const lat1 = (p.lat * Math.PI) / 180;
    const lat2 = (q.lat * Math.PI) / 180;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  const interpolate = (a, b, t) => ({
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t
  });

  const startQ = "Raleigh, NC";
  const endQ = "Seattle, WA";
  const start = await geocode(startQ);
  const end = await geocode(endQ);

  const samplePoints = [];
  for (let i = 0; i < sampleCount; i++) {
    const t = sampleCount <= 1 ? 0 : i / (sampleCount - 1);
    samplePoints.push(interpolate(start, end, t));
  }

  const nrelBase = "https://developer.nrel.gov/api/alt-fuel-stations/v1.json";
  const chargers = [];
  const seen = new Set();

  for (const p of samplePoints) {
    const params = new URLSearchParams({
      api_key: key,
      location: `${p.lat},${p.lon}`,
      radius: String(radiusMiles),
      fuel_type: "ELEC",
      ev_station_type: "DC_FAST",
      status: "E",
      limit: "200",
      offset: "0"
    });

    const resp = await fetch(`${nrelBase}?${params.toString()}`, { headers: { "User-Agent": ua } });
    const json = await resp.json();
    const arr = json.fuel_stations || json.stations || [];

    for (const s of arr) {
      const lat = Number(s.latitude);
      const lon = Number(s.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const nm = String(s.station_name || s.name || "");
      const id = `${lat.toFixed(4)}:${lon.toFixed(4)}:${nm}`;
      if (seen.has(id)) continue;
      seen.add(id);
      chargers.push({ id, name: nm || id, coords: { lat, lon } });
    }
  }

  const endReachable = chargers.filter((c) => haversineMiles(c.coords, end) <= rangeMiles);
  const startSorted = chargers
    .map((c) => ({ c, d: haversineMiles(start, c.coords) }))
    .sort((a, b) => a.d - b.d)
    .map((x) => x.c);

  const combined = [];
  const used = new Set();
  const pushUnique = (c) => {
    if (used.has(c.id)) return;
    used.add(c.id);
    combined.push(c);
  };
  for (const c of endReachable) pushUnique(c);
  for (const c of startSorted) pushUnique(c);

  const candidates = combined.slice(0, cap);

  const maxInter = (1 - bufferSoc) * rangeMiles;
  const startReachable = candidates.filter((c) => haversineMiles(start, c.coords) <= rangeMiles).map((c) => c.id);
  const anyChargerWithinEnd = candidates.some((c) => haversineMiles(c.coords, end) <= rangeMiles);

  const adj = new Map();
  for (const c of candidates) adj.set(c.id, []);
  for (let i = 0; i < candidates.length; i++) {
    for (let j = 0; j < candidates.length; j++) {
      if (i === j) continue;
      const d = haversineMiles(candidates[i].coords, candidates[j].coords);
      if (d <= maxInter) adj.get(candidates[i].id).push(candidates[j].id);
    }
  }

  const q = [];
  const dist = new Map();
  for (const id of startReachable) {
    q.push(id);
    dist.set(id, 0);
  }

  const byId = new Map(candidates.map((c) => [c.id, c]));
  let found = false;

  while (q.length) {
    const id = q.shift();
    const node = byId.get(id);
    if (!node) continue;
    if (haversineMiles(node.coords, end) <= rangeMiles) {
      found = true;
      break;
    }
    for (const nb of adj.get(id) || []) {
      if (dist.has(nb)) continue;
      dist.set(nb, (dist.get(id) ?? 0) + 1);
      q.push(nb);
    }
  }

  console.log(
    JSON.stringify(
      {
        rangeMiles,
        bufferSoc,
        maxInterDistanceMiles: maxInter,
        totalChargersFromSamples: chargers.length,
        endReachableCount: endReachable.length,
        candidatesUsed: candidates.length,
        startReachableCount: startReachable.length,
        anyChargerWithinEndRange: anyChargerWithinEnd,
        reachableEndWithConstraints: found
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

