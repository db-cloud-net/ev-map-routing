/**
 * Minimal HTTP stub for POI Services `POST /corridor/query` so E2E does not need
 * live NREL or a real POI container. Returns DC-fast chargers along a Raleigh→Greensboro line.
 *
 *   import { startPoiCorridorMock } from "./e2e-poi-corridor-mock.mjs";
 *   const mock = await startPoiCorridorMock();
 *   // env: POI_SERVICES_BASE_URL=mock.baseUrl
 *   await mock.close();
 */

import http from "node:http";

function buildMockChargers() {
  const out = [];
  // Approximate Raleigh → Greensboro corridor for planner sampling
  const lat0 = 35.78;
  const lon0 = -78.64;
  const lat1 = 36.07;
  const lon1 = -79.79;
  for (let i = 0; i < 32; i++) {
    const t = i / 31;
    out.push({
      id: 9000 + i,
      poi_type: "dc_fast",
      name: `E2E mock DC ${i}`,
      lat: lat0 + (lat1 - lat0) * t,
      lon: lon0 + (lon1 - lon0) * t,
      power_kw: 150,
      source: "poi_services"
    });
  }
  return out;
}

const MOCK_CHARGERS = buildMockChargers();

/** One hotel with nearby_dcfc join for overnight / sleep-stop functional tests. */
const MOCK_HOTELS = [
  {
    id: 5001,
    poi_type: "hotel",
    name: "Holiday Inn Express E2E",
    lat: 35.9,
    lon: -79.5,
    nearby_dcfc_id: 9010,
    nearby_dcfc_distance_yd: 120
  }
];

/**
 * @returns {Promise<{ baseUrl: string, close: () => Promise<void> }>}
 */
export function startPoiCorridorMock() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/corridor/query") {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const payload = {
            corridor: { radius_mi: 30, shape_points: 2 },
            shape: [],
            charger: MOCK_CHARGERS,
            hotel: MOCK_HOTELS,
            warnings: []
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("mock server address"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((r, rej) => {
            server.close((err) => (err ? rej(err) : r()));
          })
      });
    });
    server.on("error", reject);
  });
}
