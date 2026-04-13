# EV travel routing (monorepo)

> **Planner corridor source:** With **`POI_SERVICES_BASE_URL`** set, **POI Services** supplies corridor DC-fast chargers, hotels, and optional pairs/edges for `/plan` and `/candidates`.

> **Deprecated:** The **local mirror Docker stack** (`docker-compose.mirror.yml`, mirror refresh, NREL/Overpass mirror tiers) was **removed**. Do not pull an old revision and run that compose file — see **[`docs/DEPRECATED_MIRROR_STACK.md`](./docs/DEPRECATED_MIRROR_STACK.md)** and git tag **`deprecated/mirror-stack-removed`**.

## Documentation (v1 handoff → v2)

| Doc | Use |
|-----|-----|
| **[docs/V1_SYSTEM.md](./docs/V1_SYSTEM.md)** | Minimal map to **reconstruct** the system: layout, flow, run, verify. |
| **[docs/README.md](./docs/README.md)** | Index of all docs. |
| **[PRD.md](./PRD.md)** | Product requirements + QA-linked env knobs. |
| **[TESTING.md](./TESTING.md)** | QA runners, timeouts, troubleshooting. |
| **[docs/WEB_SWITCHES.md](./docs/WEB_SWITCHES.md)** | Map app **`NEXT_PUBLIC_*`** switches (`web/.env.local`). |
| **[docs/VALHALLA.md](./docs/VALHALLA.md)** | Valhalla **`VALHALLA_BASE_URL`** (port **8002**, NAS vs Docker). |
| **[docs/MAP_AND_NAV.md](./docs/MAP_AND_NAV.md)** | Map line vs highways; turn-by-turn limits; path to road geometry. |
| **[docs/designs/poi-route-overlay.md](./docs/designs/poi-route-overlay.md)** | POI Select overlay UX (shipped 2026-04-12) — corridor POI filters, hotel+charger pairing markers, selected POI waypoints, and replan integration. |
| **[docs/ROUTING_UX_SPEC.md](./docs/ROUTING_UX_SPEC.md)** | **Routing/UX spec** — objectives, ~60s first screen, progressive refinements, mirror + fail closed. |
| **[docs/CLOUDFLARE.md](./docs/CLOUDFLARE.md)** | Public HTTPS via Cloudflare Tunnel + CORS (production). |

## Manual testing (default: web **3000**, API **3001**)

1. **Copy env** (once): `cp .env.example .env` — set **`POI_SERVICES_BASE_URL`** for corridor planning. See **[`docs/d1-runbook.md`](./docs/d1-runbook.md)** for deploy networking (POI + API on Docker).

2. **Set `DEPLOYMENT_ENV` + CORS.** For the default local dev setup, `.env` should include:

   ```env
   DEPLOYMENT_ENV=dev-local
   CORS_ORIGIN=http://localhost:3000
   ```

   In `dev-local`, the API reflects the browser `Origin` header, so WSL/host IP origins work without you hardcoding `CORS_ORIGIN` to the WSL IP.
   `CORS_ORIGIN` matters mainly in `DEPLOYMENT_ENV=production` where the API uses a strict allowlist.

3. **Two terminals** from the repo root:

   ```bash
   npm run dev:api
   ```

   ```bash
   npm run dev:web
   ```

4. Open **`http://localhost:3000/map`**, use **Plan Trip**.

5. More detail, E2E, and troubleshooting: **[TESTING.md](./TESTING.md)**.

## Scripts

| Command           | Description              |
|-------------------|--------------------------|
| `npm run dev:api` | API on port **3001**     |
| `npm run dev:web` | Next.js on port **3000** |
| `npm run build`   | Build API + web          |
| `npm run qa:smoke` | API `tsc` + CORS + `/plan` log contract E2E ([TESTING.md](./TESTING.md)) |
