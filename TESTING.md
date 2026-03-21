# Testing (QA + E2E)

This project has two complementary verification layers:

1. **Backend functional E2E invariants** (fast fail, no screenshots)
2. **UI screenshot QA** (via gstack `/qa`) for visual/interaction regressions

The backend functional layer is especially important because external services (NREL/Overpass/Valhalla) can be slow or flaky. We assert invariants instead of exact itineraries.

---

## 0) Prerequisites

### Required local services

- API server running on **`http://localhost:3001`**
- Web app running on **`http://localhost:3000`**

**Default manual dev:** from repo root, two terminals: `npm run dev:api` then `npm run dev:web`. Set **`DEPLOYMENT_ENV=dev-local`** in `.env` (default) so the API reflects the browser `Origin` header; `CORS_ORIGIN` is mainly a fallback (see `.env.example`).

`api/dist/` is not committed; run **`npm -w api run build`** before **`npm -w api run start`** (production-style). For local dev, **`npm -w api run dev`** runs TypeScript directly.

### Environment variable source

Keep secrets in `.env` (already supported by `api/src/server.ts`).
Do **not** commit `.env` to git.

For non-secret QA defaults, prefer documenting them in this file and/or using the runner script env overrides.

**Planner timeouts (optional)**

| Variable | Default | Role |
|----------|---------|------|
| `PLAN_TOTAL_TIMEOUT_MS` | `120000` | API: hard cap on `planTrip` wall time; responds with HTTP **408** + `debug.reason: planner_timeout` when exceeded |
| `NEXT_PUBLIC_PLAN_CLIENT_TIMEOUT_MS` | `130000` | Web: `fetch` abort so the UI does not hang past ~client limit (should be ≥ API cap + slack) |

**Per-stage `/plan` budgets (server-side)** — enforced inside `planTrip` / clients; tune if a stage dominates latency or hits upstream limits.

| Variable | Default | Stage |
|----------|---------|--------|
| `PLAN_GEOCODE_TIMEOUT_MS` | `30000` | Nominatim fetch per start/end geocode (`api/src/services/geocode.ts`) |
| `PLAN_VALHALLA_POLYLINE_TIMEOUT_MS` | `60000` | First Valhalla `/route` for corridor polyline (`getRoutePolyline`) |
| `PLAN_VALHALLA_LEG_TIMEOUT_MS` | `30000` | Each Valhalla `/route` in the segment solver (`getTravelTimeMinutes` / `getTravelDistanceMiles`) |
| `NREL_FETCH_TIMEOUT_MS` | `60000` | Each NREL nearest-point / route request (`RemoteNrelAdapter`; passed as abort budget per call) |
| `OVERPASS_FETCH_TIMEOUT_MS` | `60000` | Each Overpass hotel query (`RemoteOverpassAdapter`) |

### Production (public URL + CORS)

When the API is reached via **HTTPS on a Cloudflare (or other) hostname**, browsers send `Origin: https://your-app.example.com`. The API must treat that as **production** CORS:

- Set **`DEPLOYMENT_ENV=production`** (or `prod`) on the planner process.
- Set **`CORS_ORIGIN`** to the **exact** public origin string the browser uses (scheme + host + port if non-default), e.g. `https://your-app.example.com`. In production the API **does not** reflect arbitrary origins; a mismatch surfaces as a browser CORS failure on `POST /plan`.

**Quick checks**

1. **Preflight:** `curl -i -X OPTIONS "https://<your-api-host>/plan" -H "Origin: https://<your-web-origin>" -H "Access-Control-Request-Method: POST"` — expect `204` or `200` and `Access-Control-Allow-Origin` matching your web origin when configured correctly.
2. **POST:** From the deployed web app open DevTools → Network and confirm `/plan` succeeds (no CORS error). Or `curl` with same `Origin` header if you send JSON manually.

Tunnel/network layout (Docker `prod-network`, `cloudflared`, etc.): **[docs/CLOUDFLARE.md](docs/CLOUDFLARE.md)**.

---

## Version 2 smoke (automated + manual)

**Automated:** `npm run qa:smoke` runs `npm -w api run build` plus existing E2E scripts (CORS + log contract). Those scripts must stay green after v2 changes.

**Manual quick check (2–3 minutes):**
1. Start API + web (`3001` / `3000`).
2. `POST /plan` with `{ "start": "Raleigh, NC", "end": "Greensboro, NC", "includeCandidates": true }` — expect `status: "ok"`, `responseVersion: "v2-1"`, and `candidates.chargers.length >= 1` when NREL returns data.
3. Open `/map`, enable **Show charger candidates**, run **Plan Trip** — green markers should appear for candidates; itinerary markers still render.
4. **Waypoints:** set start `Raleigh, NC`, waypoint `Charlotte, NC`, end `Atlanta, GA` — expect `status: "ok"` and at least one `waypoint` stop in `stops` when the chain succeeds.
5. **Locks (Slice 1):** With **no** waypoints, run a plan with `includeCandidates: true`, then `POST` again with `lockedChargersByLeg: [[ "<id from candidates.chargers[0].id>" ]]` — expect `ok` or `INFEASIBLE_CHARGER_LOCK` / `LOCKED_ROUTE_TOO_LONG` (never a bare 500). Unknown ids: `lockedChargersByLeg: [[ "definitely-not-a-real-id" ]]` → `UNKNOWN_CHARGER_LOCK` + HTTP 400.

**Regression:** Omitting `waypoints` + `includeCandidates` should match prior v1 behavior (`responseVersion: "mvp-1"` when neither is sent).

---

## Phase 1 exit verification (manual)

Use this when closing **Phase 1 exit criteria** in [`TODOS.md`](TODOS.md).

1. **Re-plan map 5x:** On `/map`, run **Plan Trip** five times in one session (change start/end at least twice). Confirm prior route lines and charger markers do not accumulate (see `clearMapPlanArtifacts` behavior in `web/src/app/map/page.tsx`).
2. **Short route sanity:** With API + web per [`README.md`](README.md) (`3000`/`3001`, `DEPLOYMENT_ENV=dev-local`, clean `web/.next` if needed), plan **Raleigh, NC → Greensboro, NC** and confirm a normal `status: "ok"` response or a clear, classified error (not a bare `Failed to fetch`).
3. Check off the corresponding rows in `TODOS.md` when satisfied.

---

## 1) Repo hygiene requirement (for gstack `/qa`)

Before running `/qa`, ensure the git tree is clean:

```bash
git status --porcelain
```

The `qa` skill requires **no untracked/modified files** (i.e., output should be empty).

Also ensure build artifacts are ignored:

- `web/.next/`
- `node_modules/`
- `.cursor/`

If `web/.next` is already tracked from earlier commits, untrack it once:

```bash
git rm -r --cached web/.next
git commit -m "Stop tracking Next.js build artifacts"
```

---

## 2) Backend functional E2E (recommended “preflight”)

This repo includes a dependency-free functional runner:

- `scripts/e2e-plan-functional.mjs`

### Run it (quick smoke against your already-running API)

```bash
node scripts/e2e-plan-functional.mjs
```

**Important:** In this mode the runner **does not** apply each case’s `envOverrides` from `e2e-plan-functional.mjs`—only the API process’s real environment (e.g. `.env`) is used. Scenarios such as **overnight + HIE** are written with tight `EV_RANGE_MILES` / threshold overrides; without them, you may see **false failures** (e.g. “expected at least one charge stop”). Treat this command as a smoke test only unless your `.env` already matches those constraints.

### Run it deterministically (recommended for QA / CI)

Spawns a fresh API per case so **per-case `envOverrides` actually apply**:

```bash
SPAWN_SERVER=true API_PORT=3001 node scripts/e2e-plan-functional.mjs
```

Use a free port if `3001` is taken by your dev server, or stop the dev API first.

**PowerShell (Windows)** — set env vars separately; `set FOO=bar` is not the same as in `cmd.exe`:

```powershell
$env:SPAWN_SERVER = 'true'
$env:API_PORT = '3002'   # or 3001 if nothing is listening there
node scripts/e2e-plan-functional.mjs
```

---

## 2.5) Additional automated checks (fast)

**One command (API build + CORS + log contract):**

```bash
npm run qa:smoke
```

Runs [`scripts/qa-smoke-all.mjs`](../scripts/qa-smoke-all.mjs) (`npm -w api run build`, then `e2e-cors-functional.mjs`, then `e2e-plan-log-contract.mjs`). See [`docs/CI_SCOPE.md`](docs/CI_SCOPE.md) for suggested CI gating.

These scripts are also listed individually below — they keep critical “plumbing” stable while you add new functionality:

- CORS header behavior across `dev-local` vs `production`:
  - `node scripts/e2e-cors-functional.mjs`
- JSON log contract includes `deploymentEnv` and preserves `requestId` correlation:
  - `node scripts/e2e-plan-log-contract.mjs`
- Browser-level smoke check that the UI renders the `Itinerary` panel and shows no CORS/preflight console errors:
  - `node scripts/ui-plan-trip-smoke.mjs`

For browser evidence from gstack runs, screenshots are saved under:
- `.gstack/qa-reports/screenshots/`

---

## 3) Known QA scenarios (invariants to preserve)

The following “known cases” are what the QA process should validate repeatedly.
The backend runner asserts these invariants automatically; the UI QA should confirm they *render* correctly.

### A) Overnight + Hotel insertion (sleep stop appears)

- **Request:** `start=Charleston, SC`
- **Request:** `end=<Holiday Inn Express Greensboro coordinate>`

**Expected invariants**

- `status === "ok"`
- `stops` includes:
  - `start`
  - at least one `charge`
  - at least one `sleep`
  - `end`
- `sleep.name` includes **`Holiday Inn Express`**
- `totals.overnightStopsCount >= 1`
- Soft preference: when inserting the `sleep` stop at the Holiday Inn Express location, prefer associating a nearby EV charger (so the hotel stop can represent both “charging” and “sleeping”).
- If a charger is found, it is surfaced on the `sleep` stop via `sleep.meta` (e.g. `sleep.meta.chargerFound=true`). If no charger is found nearby, it should not fail this invariant set.

### B) Max days cap (max 8 days)

- **Request:** `start=Raleigh, NC`
- **Request:** `end=Seattle, WA`

**Expected invariants**

- `status === "ok"`
- `stops` includes `end`
- `totals.overnightStopsCount <= 7`

### C) Sanity check (no sleep when direct-ish)

- **Request:** `start=Raleigh, NC`
- **Request:** `end=Greensboro, NC`

**Expected invariants**

- `status === "ok"`
- `sleep` stops count is `0`

---

## 4) UI screenshot QA expectations (gstack `/qa`)

When `/qa` runs against the map page, it should check:

1. Page loads (no console errors)
2. Clicking **Plan Trip** renders:
   - itinerary list
   - markers on the map
3. Error state doesn’t crash:
   - if planner fails, UI still shows `message` and (if present) `debug`

If you add/modify planning logic, preserve the invariants above or update the runner + expected invariants accordingly.

---

## 5) Manual smoke checklist (under 2 minutes)

1. Start API + web:
   - `npm -w api run dev`
   - `npm -w web run dev`
2. Run functional preflight:
   - `node scripts/e2e-plan-functional.mjs`
3. Sanity check UI:
   - Open `http://localhost:3000/map`
   - Enter a known scenario
   - Click **Plan Trip**
   - Verify itinerary renders and no JS errors appear

### Windows + WSL repeatable startup (recommended)

Use this flow when running web/API on Windows Node while driving QA from WSL/browser tools.

1. Kill stale listeners first:
   - `cmd.exe /c "netstat -ano | findstr :3000"`
   - `cmd.exe /c "netstat -ano | findstr :3001"`
   - `cmd.exe /c "taskkill /PID <pid> /F"` (if needed)
2. Start API in `dev-local` mode (reflects browser Origin):
  - `cmd.exe /c "cd /d C:\Users\david\Dev\Projects\Travel-Routing && set PORT=3001&& set DEPLOYMENT_ENV=dev-local&& set CORS_ORIGIN=http://localhost:3000&& C:\Progra~1\nodejs\node.exe api\dist\api\src\server.js"`
3. Build web with explicit API base:
   - `cmd.exe /c "cd /d C:\Users\david\Dev\Projects\Travel-Routing && set NEXT_PUBLIC_API_BASE=http://172.22.16.1:3001&& npm -w web run build"`
4. Start web in production mode:
   - `cmd.exe /c "cd /d C:\Users\david\Dev\Projects\Travel-Routing && npm -w web run start -- -p 3000"`
5. Verify from WSL:
   - `curl -sS -m 8 -o /dev/null -w "%{http_code}\n" http://172.22.16.1:3000/map` (expect `200`)
   - `curl -sS -m 5 -o /dev/null -w "%{http_code}\n" http://172.22.16.1:3001/health` (expect `200`)

Notes:

- Prefer `next build` + `next start` for QA stability. `next dev` can hang or produce inconsistent chunk state during repeated stashing/restarts.
- In WSL, use the Windows gateway (`172.22.16.1`) rather than `localhost` for browser QA routes.
- Always pin `NEXT_PUBLIC_API_BASE`. In `dev-local`, `CORS_ORIGIN` is mainly a fallback; in `production`, it must match your web origin.
- In `cmd.exe`, do not put a space before `&&` after `set VAR=...`; that trailing space becomes part of the env value.

### Browse runtime fallback (when `browse.exe` only prints "Starting server...")

If packaged `browse.exe` cannot maintain state in WSL, run the source CLI directly with Bun:

```bash
export LD_LIBRARY_PATH="/home/david/playwright-libs/full/usr/lib/x86_64-linux-gnu"
cd "/mnt/c/Users/david/.cursor/skills/gstack"
bun run browse/src/cli.ts goto http://172.22.16.1:3000/map
bun run browse/src/cli.ts snapshot -i -a -o /tmp/qa-map-before.png
bun run browse/src/cli.ts click @e3
sleep 8
bun run browse/src/cli.ts snapshot -i -a -o /tmp/qa-map-after.png
bun run browse/src/cli.ts text -o /tmp/qa-map-after.txt
```

Important:

- `browse/src/cli.ts wait` expects a selector or page event (for example `--networkidle`), not milliseconds. Use shell `sleep` for fixed delays.
- `snapshot -o` is sandboxed; write outputs to `/tmp` or inside the gstack skill directory.

---

## 6) Notes on flakiness

- NREL/Overpass requests can return empty sets or time out.
- The planner should **fail gracefully**:
  - `/plan` returns `status: "error"` with a useful `message`
  - `debug` remains present when available

If you see intermittent failures, rely on:

- the functional runner output
- the `/plan` `debug.segmentsAttempted` payload

---

## 7) Blank map / DevTools shows `400` on `/_next/static/chunks/*.js`

If the **map area stays white** and the **Network** tab shows **`400 Bad Request`** (or 404) for files like `webpack-….js` or `page-….js`, the browser is asking for chunk hashes that **don’t match** the current Next.js build (stale cache, interrupted dev server, or mixed `dev` / `build` runs).

**Fix**

1. Stop `npm -w web run dev` (and any `next start` on the same port).
2. Delete the web build output: remove the `web/.next/` folder.
3. Start dev again: `npm -w web run dev`.
4. In the browser: hard refresh (**Ctrl+Shift+R**) or clear site data for `localhost:3000`.

After chunks load with **200**, **Plan Trip** can reach the API; failures that mention the planner will show in the UI or on the `/plan` request, not on static `.js` chunks.

