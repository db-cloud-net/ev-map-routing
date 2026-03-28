# Testing (QA + E2E)

> **Planner corridor source:** With **`POI_SERVICES_BASE_URL`** set, **POI Services** is the runtime source for corridor DC-fast chargers, hotels, and optional pairs/edges. This app does **not** ship live NREL/Overpass clients or **`SOURCE_ROUTING_MODE`** (see **[`docs/designs/deprecate-nrel-overpass-mirror-travel-routing-adr.md`](docs/designs/deprecate-nrel-overpass-mirror-travel-routing-adr.md)**). Some paragraphs below still mention mirror/NREL for **historical** QA notes — prefer POI + Valhalla.

This project has two complementary verification layers:

1. **Backend functional E2E invariants** (fast fail, no screenshots)
2. **UI screenshot QA** (via gstack `/qa`) for visual/interaction regressions

The backend functional layer is especially important because external services (POI Services, Valhalla, geocode) can be slow or flaky. We assert invariants instead of exact itineraries.

---

## 0) Prerequisites

### Required local services

- API server running on **`http://localhost:3001`**
- Web app running on **`http://localhost:3000`**

**Default manual dev:** from repo root, two terminals: `npm run dev:api` then `npm run dev:web`. Set **`DEPLOYMENT_ENV=dev-local`** in `.env` (default) so the API reflects the browser `Origin` header; `CORS_ORIGIN` is mainly a fallback (see `.env.example`).

`api/dist/` is not committed; run **`npm -w api run build`** before **`npm -w api run start`** (production-style). For local dev, **`npm -w api run dev`** runs TypeScript directly.

### gstack browse (interactive `/qa` + screenshots)

Use this when you want **headless UI QA** (gstack `/qa`) or to drive the map from the **`browse.exe`** CLI instead of only a normal browser.

**One-time setup**

| OS | Command | Requires |
|----|---------|----------|
| **Windows** | `powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\skills\gstack\setup.ps1"` | [Bun](https://bun.sh/) (`bun --version`), Git |
| **macOS / Linux** | `bash ~/.claude/skills/gstack/setup` (from repo: same path under your home dir) | Bun, Git |

The script builds **`browse`** and installs **Playwright Chromium**. After setup, the binary is:

- **Windows:** `%USERPROFILE%\.claude\skills\gstack\browse\dist\browse.exe`
- **Unix:** `~/.claude/skills/gstack/browse/dist/browse`

**Each QA session (before `/qa` or browse)**

1. **`.env`** at repo root: copy from **`.env.example`**, set **`POI_SERVICES_BASE_URL`** for corridor planning, **`CORS_ORIGIN=http://localhost:3000`**, **`DEPLOYMENT_ENV=dev-local`** (see below for planner URLs if you use Valhalla).
2. **Two terminals** from repo root: **`npm run dev:api`** (port **3001**) and **`npm run dev:web`** (port **3000**).
3. **Sanity check:** open **`http://localhost:3000/map`** in a browser or run browse:
   - PowerShell: `& "$env:USERPROFILE\.claude\skills\gstack\browse\dist\browse.exe" goto http://localhost:3000/map`
4. **Git:** `/qa` expects a **clean working tree** (`git status` empty) — commit or stash before running the skill.
5. **Automated layer (no UI):** `npm run qa:smoke` — should stay green before you rely on manual/browse QA.

**Full manual pass:** follow **§ Version 2 smoke** below (map, candidates, waypoints, locks). **Planner E2E (optional):** `node scripts/e2e-plan-functional.mjs` (or `SPAWN_SERVER=true` per that script) — separate from `qa:smoke`.

### Environment variable source

Keep secrets in **`.env` at the repo root** (same folder as the root `package.json`). The API resolves this file whether you run `npm -w api run start` from the repo root or `npm run start` from `api/` — compiled output lives under `api/dist/...`, so older single-path fallback could miss `.env` and leave expected keys unset (see `findEnvFilePath` in `api/src/server.ts`).

On **Windows**, if the key still looks missing, check for a **user/system** env var set to empty (the server uses `override: true` when loading `.env` so file values win over stale empty vars).

**Valhalla:** `.env.example` may use `VALHALLA_BASE_URL=http://valhalla:8002` for Docker. On the host use **`http://localhost:8002`** (or your LAN IP) unless the hostname `valhalla` resolves (e.g. inside Compose).

Do **not** commit `.env` to git.

For non-secret QA defaults, prefer documenting them in this file and/or using the runner script env overrides.

**Planner timeouts (optional)**

| Variable | Default | Role |
|----------|---------|------|
| `PLAN_SEGMENT_TIMEOUT_MS` | `180000` | API: per-segment solver budget for `planTrip` (default **3 min**). No global `planTrip` wall-clock timeout; timeout errors surface as segment-level failures. |
| `PLAN_RANGE_LEG_CHARGE_STOP_PENALTY_MINUTES` | `0` | **Pillar 1 slice C:** add this many **minutes** to the segment solver’s cost for **each** departure from a charger (after charging). Default **0** preserves previous path selection. When **`> 0`**, **`debug.rangeLegOptimizer`** is set. See **`docs/designs/range-leg-incremental-trust-adr.md`**. |
| `PLAN_RANGE_LEG_FEASIBILITY_MARGIN_FRAC` | `0` | **Pillar 1 slice D:** multiply all **linear** SOC distance budgets by **`(1 − margin)`** (clamped to **`0…0.999`**). Default **0** = unchanged feasibility. When **`> 0`**, **`debug.rangeLegFeasibility`** is set. Large values can make **`No feasible itinerary`** more likely. Same ADR as slice C. |
| `PLAN_SOC_CARRY_CHAINED_SEGMENTS` | `true` | **Pillar 1 slice E:** for **locked** charger chains, pass **`initialDepartSocFraction`** into each **`planLeastTimeSegment`** after the first (linear replay from the previous segment). Set **`false`** for legacy “full pack at every lock boundary.” **`debug.socCarryChainedSegments`** when active. |
| `PLAN_SOC_CARRY_OVERNIGHT_SEGMENTS` | `true` | **Pillar 1 slice F:** for **`planTripOneLeg`** overnight iterations after the first and the **remainder** solve, pass **`initialDepartSocFraction`** from replay of the itinerary so far toward **`end`**. Set **`false`** for legacy full pack at each overnight boundary. **`debug.socCarryOvernightSegments`** when active. |
| **Web (`NEXT_PUBLIC_*`)** | — | **Full table:** **[`docs/WEB_SWITCHES.md`](docs/WEB_SWITCHES.md)** — set in **`web/.env.local`** (build-time). Includes **`NEXT_PUBLIC_PLAN_CLIENT_TIMEOUT_MS`**, prefetch toggles, **`NEXT_PUBLIC_PLAN_USE_JOB`**, optional **`NEXT_PUBLIC_API_BASE`**. In `planJob` mode, `NEXT_PUBLIC_PLAN_CLIENT_TIMEOUT_MS` is an **idle timeout** (resets on checkpoints and on SSE **`heartbeat`** events from the API). On client abort, no response body (including `debug.providerCalls`) is read. |

**Pillar 1 manual compare:** On a fixed long-corridor trip, run once with **`PLAN_RANGE_LEG_CHARGE_STOP_PENALTY_MINUTES=0`** and again with a small positive value (for example **5–15**); compare **`debug.rangeLegs`** (row counts, max hop) and **`debug.socReplay`** (infeasibility flags). Fewer intermediate charges appear only when the penalty is large enough relative to travel-time differences—do not assume a larger penalty is always better.

**Async `planJob` QA:** With **`NEXT_PUBLIC_PLAN_USE_JOB=true`**, **`GET /plan/jobs/:id`** may emit **`attempt.kind === "partial_route"`** checkpoints (**`partialSnapshot`**: **`stops`**, **`legs`**, **`rangeLegs`**) so the map/itinerary **updates while `running`**; the final plan still arrives only in **`result`** when **`complete`**. **`GET /plan/jobs/:id/stream`** (**NDJSON**) and **`GET /plan/jobs/:id/events`** (**SSE**) replay the same **JSON** payloads until **`type: "complete"`** or **`type: "error"`**; **`202`** includes **`streamUrl`** and **`eventsUrl`**. Contract: **[`docs/V2_API.md`](docs/V2_API.md)** · **[`docs/MAP_AND_NAV.md`](docs/MAP_AND_NAV.md)**.

**Corridor + POI (API / `planTrip`):** **`resolvePlanProviders`** is **POI-only** (`poi_only`). There is no **`SOURCE_ROUTING_MODE`** or mirror tier in current **`api/src/**`**. Corridor radius and sampling: **`CORRIDOR_SEARCH_RADIUS_MILES`** (deprecated alias **`NREL_RADIUS_MILES`**), **`CORRIDOR_STEP_MILES`**, **`CORRIDOR_MAX_SAMPLE_POINTS`**, **`CANDIDATE_CHARGERS_CAP`** — see **`.env.example`**.

**Per-stage `/plan` budgets (server-side)** — enforced inside `planTrip` / clients; tune if a stage dominates latency or hits upstream limits.

| Variable | Default | Stage |
|----------|---------|--------|
| `PLAN_GEOCODE_TIMEOUT_MS` | `30000` | Nominatim fetch per start/end geocode (`api/src/services/geocode.ts`) |
| `PLAN_VALHALLA_POLYLINE_TIMEOUT_MS` | `60000` | First Valhalla `/route` for corridor polyline (`getRoutePolyline`) |
| `PLAN_VALHALLA_LEG_TIMEOUT_MS` | `30000` | Each Valhalla `/route` in the segment solver (`getTravelTimeMinutes` / `getTravelDistanceMiles`) |
| `VALHALLA_BASE_URL` | `http://valhalla:8002` (code default) | Valhalla origin (port usually **8002**). See **[docs/VALHALLA.md](docs/VALHALLA.md)**. |
| `POI_SERVICES_BASE_URL` | *(unset)* | When set, corridor chargers/hotels use POI Services **`POST /corridor/query`** (see **`.env.example`** for **`USE_POI_SERVICES_CORRIDOR`**, **`POI_SERVICES_USE_PAIRS`**, **`POI_SERVICES_USE_EDGES`**). On Docker NAS (**`prod-network`**), e.g. **`http://poi:8010`** (**[`docs/d1-runbook.md`](docs/d1-runbook.md)**). |
| `POI_SERVICES_USE_PAIRS` | `true` | When POI corridor is enabled, request the **`pairs`** layer (hotel↔DCFC) unless set to **`false`**. |
| `POI_SERVICES_TIMEOUT_MS` | `30000` | HTTP budget for each **`/corridor/query`** call (`api/src/services/poiServicesClient.ts`). |

With `POI_REVIEW_LOG=true`, tail `logs/poi-corridor-review.ndjson` to review POI corridor sleep-stop join coverage (e.g. `sleep_dcfc_corridor_miss`), or run `node scripts/poi-review-log-summary.mjs` for event and `resolvedVia` rollups.

**`debug.providerCalls` (MVP):** On successful and many error responses, `debug` includes **`providerCalls`** — **`valhalla`**, **`geocode`** (Nominatim), **`poi_services`**: **`calls`**, **`totalMs`**, **`avgMs`**, and **`durationsMs`** (truncated after 200 entries with a tail marker). Implemented in **`api/src/services/providerCallMetrics.ts`** and merged in **`api/src/server.ts`**.

**Planner error: “No feasible itinerary for segment”** — the least-time segment solver could not chain **start → DC chargers → end** under the current **EV range / buffer** and **corridor charger pool** (common on **very long** legs or **sparse** corridor coverage). The API response **`message`** includes the feasibility model line (Valhalla road-distance vs haversine). Inspect **`debug.noFeasibleItinerary`** for **`chargerNodesCount`**, **`reachableEdgeCount`**, **`endWithinRangeCount`**, etc. Mitigations: raise **`EV_RANGE_MILES`** (or lower **`CHARGE_BUFFER_SOC`** slightly), increase corridor sampling (**`CORRIDOR_SEARCH_RADIUS_MILES`**, **`CORRIDOR_MAX_SAMPLE_POINTS`**, **`CANDIDATE_CHARGERS_CAP`** in **`api/src/planner/corridorCandidates.ts`** / env), ensure **POI Services** returns enough DC-fast sites along the corridor, or **split** the trip with **waypoints** so each segment is shorter.

**Planner stdout (when `PLAN_LOG_REQUESTS` is not `false`):** Corridor sampling logs **`provider_valhalla_polyline`** on success. If Valhalla’s `/route` fails, **`provider_valhalla_polyline_failed`** includes **`durationMs`** (real attempt time) and **`error`**; then **`provider_valhalla_polyline_fallback`** includes **`valhallaAttemptMs`** (same as failed attempt), **`fallbackBuildMs`** (local straight-line sampling only, usually under 1 ms), **`corridorSamplesUsed`**, and **`approxMiles`**. See **`api/src/planner/planTripOneLeg.ts`**.

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

**Automated:** `npm run qa:smoke` runs `npm -w api run build` plus E2E scripts (CORS + log contract + **Slice 2 replan** + **Slice 3 `/candidates`** + **Slice 4 `POST /route-preview`** via `e2e-route-preview-smoke.mjs` + **multi-leg + `lockedChargersByLeg`** via `e2e-multileg-locks-smoke.mjs`). Those scripts must stay green after v2 changes.

**Manual quick check (2–3 minutes):**
1. Start API + web (`3001` / `3000`).
2. `POST /plan` with `{ "start": "Raleigh, NC", "end": "Greensboro, NC", "includeCandidates": true }` — expect `status: "ok"`, `responseVersion: "v2-1"`, and `candidates.chargers.length >= 1` when **POI Services** (or your configured corridor source) returns data.
3. Open `/map`, enable **Show charger candidates**, run **Plan Trip** — green markers should appear for candidates; itinerary markers still render.
4. **Waypoints:** set start `Raleigh, NC`, waypoint `Charlotte, NC`, end `Atlanta, GA` — expect `status: "ok"` and at least one `waypoint` stop in `stops` when the chain succeeds.
5. **Locks (Slice 1):** With **no** waypoints, run a plan with `includeCandidates: true`, then `POST` again with `lockedChargersByLeg: [[ "<id from candidates.chargers[0].id>" ]]` — expect `ok` or `INFEASIBLE_CHARGER_LOCK` / `LOCKED_ROUTE_TOO_LONG` (never a bare 500). Unknown ids: `lockedChargersByLeg: [[ "definitely-not-a-real-id" ]]` → `UNKNOWN_CHARGER_LOCK` + HTTP 400.
6. **Slice 2 (`replanFrom`):** On `/map`, use **Slice 2 — replan start** → **Replan from lat/lon**, set coords near the corridor, **End** unchanged → **Plan Trip** — expect `responseVersion: "v2-1"`, `debug.replan: true` on success. Then **Replan from prior itinerary stop**, pick a stop, **Plan Trip** — same. Requires a successful plan first for the stop dropdown.

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

Runs [`scripts/qa-smoke-all.mjs`](../scripts/qa-smoke-all.mjs) (`npm -w api run build`, then `e2e-cors-functional.mjs`, `e2e-plan-log-contract.mjs`, `e2e-replan-smoke.mjs`, `e2e-candidates-smoke.mjs`, `e2e-route-preview-smoke.mjs`, `e2e-multileg-locks-smoke.mjs`). See [`docs/CI_SCOPE.md`](docs/CI_SCOPE.md) for suggested CI gating.

These scripts are also listed individually below — they keep critical “plumbing” stable while you add new functionality:

- CORS header behavior across `dev-local` vs `production`:
  - `node scripts/e2e-cors-functional.mjs`
- JSON log contract includes `deploymentEnv` and preserves `requestId` correlation:
  - `node scripts/e2e-plan-log-contract.mjs`
- Browser-level smoke check that the UI renders the `Itinerary` panel and shows no CORS/preflight console errors:
  - `node scripts/ui-plan-trip-smoke.mjs`

**`Timed out waiting for http://localhost:…/health` in `qa:smoke`:** these scripts **spawn a fresh API** (they do **not** attach to your already-running `dev:api`). Each script uses its own default **`API_PORT`** (e.g. CORS **`3002`**, log contract **`3010`** — see each file’s header). Spawns set **`E2E_SPAWN_PORT`** alongside **`PORT`** so repo **`.env`** `PORT=3001` does not win over **`dotenv` `override: true`** (see **`api/src/server.ts`**). If the child never listens: check **console output** (startup errors, `EADDRINUSE`, missing **`POI_SERVICES_BASE_URL`** / **`VALHALLA_BASE_URL`** as needed). Free the port or set **`API_PORT`** / **`API_BASE`**. *Note:* piping spawned `stdout` without draining it used to **deadlock** the API on Windows; scripts that don’t parse JSON logs use **inherited** stdio.

**Port already in use (`EADDRINUSE`) when E2E spawns the API:** a previous run may have left a `node` process listening on the same `API_PORT`. The scripts [`e2e-cors-functional.mjs`](../scripts/e2e-cors-functional.mjs), [`e2e-plan-log-contract.mjs`](../scripts/e2e-plan-log-contract.mjs), [`e2e-plan-functional.mjs`](../scripts/e2e-plan-functional.mjs) (when `SPAWN_SERVER=true`), [`e2e-replan-smoke.mjs`](../scripts/e2e-replan-smoke.mjs), [`e2e-candidates-smoke.mjs`](../scripts/e2e-candidates-smoke.mjs), [`e2e-route-preview-smoke.mjs`](../scripts/e2e-route-preview-smoke.mjs), and [`e2e-multileg-locks-smoke.mjs`](../scripts/e2e-multileg-locks-smoke.mjs) call [`e2e-kill-port.mjs`](../scripts/e2e-kill-port.mjs) first to **best-effort kill listeners** on that port (default ports **3011–3016** depending on script). If it still fails, manually end the process (Task Manager / `taskkill`, or `Get-NetTCPConnection -LocalPort <port>` on Windows).

**`npm run dev:api` / ts-node-dev:** On save, the watcher can start a new process before the old one releases `PORT`. For non-production `DEPLOYMENT_ENV`, the API **best-effort frees** listeners on `PORT` before `listen()` (Windows: `Get-NetTCPConnection -State Listen` plus a `netstat`/`taskkill` fallback; see `API_FREE_PORT_BEFORE_LISTEN` in [`.env.example`](.env.example)). After a kill on **retry** attempts, Windows may need a **short delay** before rebinding (`API_AFTER_FREE_PORT_MS_WIN`; set `API_ALWAYS_SLEEP_AFTER_FREE=true` to delay after every free). If bind still hits `EADDRINUSE`, it **retries** a few times with **backoff** (`API_LISTEN_MAX_ATTEMPTS`) after `close()` — not a tight `listen()` loop (that stacked listeners and triggered `MaxListenersExceededWarning`). If bind still fails, stop duplicate dev servers or change `PORT`.

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

## 5.5) Multi-waypoint vs single-leg (why one works and the other fails)

**Terminology:** Use **waypoint leg** for start→waypoint→end hops, **solver attempt** for each `debug.segmentsAttempted` row (overnight / least-time solve). **`rangeLegs`** on successful **`POST /plan`** = **presentation** grouping at charge boundaries (also **`debug.rangeLegs`**); a **true** range-optimizer remains future work. See **[`docs/designs/range-based-segments-intent.md`](docs/designs/range-based-segments-intent.md)**.

**How waypoints are planned:** `planTripMultiLeg` (`api/src/planner/planTrip.ts`) runs **`planTripOneLegFromCoords` once per driving hop** — e.g. Start→WP1, then WP1→End — and **stops on the first failing leg** (returns that leg’s error; no merged success).

**How that differs from “one route all at once”:** With **no** waypoints, **one** leg covers the **full** origin→destination. The corridor builder (`fetchCorridorChargersForLeg`) walks the **entire** Valhalla polyline (or chord fallback), samples it, unions **POI Services** corridor hits, then **`CANDIDATE_CHARGERS_CAP`** (default **25**) picks evenly spaced candidates along **progress** for **that** long corridor.

**Why adding a waypoint can flip success→failure:**

| Effect | Detail |
|--------|--------|
| **Separate pools** | Each sub-leg gets its **own** polyline, samples, and deduped charger set — then **each** is capped again (default 25). A charger that matters for connectivity might appear on the **full** trip’s union but be **dropped** on a **short** leg’s cap or **missing** if that leg’s corridor is sparse (mountains, rural DCFC gaps). |
| **First failure wins** | If **any** hop returns `status: "error"` (no corridor chargers, **`NoFeasibleItineraryError`**, timeout, etc.), the **whole** multi-leg plan fails — you may see **no completed `segmentsAttempted`** in the response for legs that never ran. |
| **Not battery chaining** | Each leg is solved with a **full battery** at that leg’s start (MVP). That **does not** make multi-leg **harder** than one long leg; if anything it’s **optimistic** per hop. Failures are usually **corridor + solver** on that hop, not SOC reset. |

**Manual observations (reported QA):**

- **Raleigh → Asheville → Lexington (KY):** failed (no segments / plan error).
- **Raleigh → Lexington (no waypoint):** succeeded (single corridor + solver).
- **Raleigh → St Louis:** succeeded (single leg).
- **Raleigh → Nashville → St Louis:** failed.

**What to inspect when a waypoint trip fails:**

1. **Response JSON** — `debug.multiLeg`, `debug.legCount`, and **`debug.legs`** (array per leg). The **first** `undefined` or error-shaped leg aligns with the failing hop.
2. **API message** — e.g. `"No EV charging stops for the trip"` (corridor empty), **No feasible itinerary** (solver), geocode/Valhalla errors.
3. **Tune / env** — `CANDIDATE_CHARGERS_CAP`, `CORRIDOR_SEARCH_RADIUS_MILES` (or legacy `NREL_RADIUS_MILES`), `CORRIDOR_STEP_MILES`, `CORRIDOR_MAX_SAMPLE_POINTS`, Valhalla up (`VALHALLA_BASE_URL`), **`POI_SERVICES_BASE_URL`**.

**Docs:** Corridor + cap + solver behavior — **`api/src/planner/corridorCandidates.ts`**, **`planTripOneLeg.ts`**, **`leastTimeSegment.ts`**.

---

## 6) Notes on flakiness

- **POI Services** requests can return empty sets or time out (depending on configuration and network).
- The planner should **fail gracefully**:
  - `/plan` returns `status: "error"` with a useful `message`
  - `debug` remains present when available

If you see intermittent failures, rely on:

- the functional runner output
- the `/plan` `debug.segmentsAttempted` payload (on **`/map`**, **Debug (MVP)** also lists each segment attempt in a purple card; multi-leg plans show **Leg N (segment attempts)** from `debug.legs[]`)

---

## 7) Blank map / DevTools shows `400` on `/_next/static/chunks/*.js`

If the **map area stays white** and the **Network** tab shows **`400 Bad Request`** (or 404) for files like `webpack-….js` or `page-….js`, the browser is asking for chunk hashes that **don’t match** the current Next.js build (stale cache, interrupted dev server, or mixed `dev` / `build` runs).

**Fix**

1. Stop `npm -w web run dev` (and any `next start` on the same port).
2. Delete the web build output: remove the `web/.next/` folder.
3. Start dev again: `npm -w web run dev`.
4. In the browser: hard refresh (**Ctrl+Shift+R**) or clear site data for `localhost:3000`.

After chunks load with **200**, **Plan Trip** can reach the API; failures that mention the planner will show in the UI or on the `/plan` request, not on static `.js` chunks.

