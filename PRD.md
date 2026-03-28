# PRD: EV Trip Planning QA-Driven Requirements

> **Planner corridor source:** With **`POI_SERVICES_BASE_URL`** set, **POI Services** is the runtime source for corridor DC-fast chargers, hotels, and related POI layers. Travel-Routing does **not** use live NREL for `/plan` in that configuration. Env vars named **`NREL_*`** below include **offline mirror refresh** and legacy paths.

**System map (implementation + ops):** see **[docs/V1_SYSTEM.md](docs/V1_SYSTEM.md)** and **[docs/README.md](docs/README.md)** for a minimal reconstruction path alongside this PRD.

## Overview
This document converts the existing QA “known invariants” in `TESTING.md` into a starter PRD. The goal is to make the expected behavior of the trip-planning feature explicit and repeatable.

## Problem Statement
The trip planner integrates multiple external services (**POI Services** for corridor data when configured, **Valhalla**, geocode, and optionally legacy NREL/Overpass or mirror tiers), which can be slow or flaky. Because exact itineraries are not stable, the product needs verification via invariant-based checks that confirm important behaviors (e.g., overnight + hotel insertion) without asserting precise routes.

## Goals
1. Produce a valid trip plan from a `start` and `end` pair.
2. Insert an overnight “sleep” stop when the trip duration crosses an overnight threshold.
3. Associate the sleep stop with a nearby hotel identified as “Holiday Inn Express”.
4. Enforce an upper bound on overnight stop count (max 8 days / <= 7 overnight segments).
5. Avoid inserting sleep stops when the trip is “direct-ish”.
6. Fail gracefully so the UI does not crash when planning fails.
7. Prefer selecting an overnight hotel that also has an EV charger, so charging and sleeping can occur together.

## Non-Goals
1. Exact itineraries, charger selections, and hotel coordinates are not expected to be deterministic across runs.
2. UI visual styling is not specified in this PRD beyond the QA checks described below.

## System / Components (at a glance)
1. API server
   - Required local service: `http://localhost:3001`
   - Endpoints referenced by QA:
     - `GET /health`
     - `POST /plan`
2. Web application
   - Required local service: `http://localhost:3000`
   - QA references the map page and a “Plan Trip” user action.

## Configuration Knobs (from `.env`)
These environment variables control the planner’s invariant-based behavior and the scope of external calls. Values below are the defaults currently present in your `.env` (additional implicit defaults exist in code when a variable is not set).

### Overnight + hotel insertion (directly tied to QA invariants)
- `OVERNIGHT_THRESHOLD_MINUTES=600`
  - Requirement linkage: drives whether an overnight (`sleep`) is expected to be inserted for the QA “Overnight + Hotel insertion” case.
  - Definition: the threshold is evaluated against driving + charging stops time (i.e., total time minutes), not driving-only.
- `SLEEP_MINUTES=480`
  - Requirement linkage: the `sleep` stop represents a fixed-duration sleep block (hours) once insertion occurs.
- `MAX_OVERNIGHT_STOPS=7`
  - Requirement linkage: caps how many overnight segments may appear; used for the “Max days cap” invariant.
- `HOTEL_RADIUS_METERS=365.76`
  - Requirement linkage: base proximity radius when searching for a hotel around an overnight anchor.
- `OVERNIGHT_HOTEL_RADIUS_METERS=1200`
  - Requirement linkage: expanded radius used during anchor evaluation / fallback hotel discovery.
- `OVERNIGHT_ANCHOR_CANDIDATE_LIMIT=2`
  - Requirement linkage: limits how many candidate charge stops are considered as overnight anchors.
- `OVERNIGHT_HOTEL_ANCHOR_CANDIDATE_LIMIT=3`
  - Requirement linkage: limits how many candidate chargers near the trip end are considered in the fallback flow when no hotel is found near initial anchors.

### EV / charging + corridor sampling (impacts whether overnight is reachable)
- `EV_RANGE_MILES=260`
  - Requirement linkage: controls how far the planner can travel between charging opportunities.
- `CHARGE_BUFFER_SOC=0`
  - Requirement linkage: adjusts effective reachable range by reserving SOC margin.
- `AVG_SPEED_MPH=60`
  - Requirement linkage: affects ETA/time modeling used to determine whether the overnight threshold is crossed.

### POI Services corridor (runtime — primary product path)
- `POI_SERVICES_BASE_URL` — base URL for **`POST /corridor/query`** (corridor DC-fast chargers, hotels, optional pairs/edges).
  - Requirement linkage: when set, corridor candidate pools for planning come from **POI Services**, not live NREL in Travel-Routing.
- `USE_POI_SERVICES_CORRIDOR`, `POI_SERVICES_USE_PAIRS`, `POI_SERVICES_USE_EDGES`, `POI_SERVICES_FALLBACK_TO_NREL`, `POI_SERVICES_TIMEOUT_MS` — see **`.env.example`** and **`TESTING.md`**.

### Corridor sampling geometry & caps (shared)
- `NREL_RADIUS_MILES=60` *(name retained; also informs corridor radius behavior alongside POI filters)*
  - Requirement linkage: radius around corridor samples when querying chargers/hotspots.
- `CORRIDOR_STEP_MILES=30`
  - Requirement linkage: spacing between corridor sample points for charger lookup.
- `CORRIDOR_MAX_SAMPLE_POINTS=10`
  - Requirement linkage: bounds how many corridor samples are queried.
- `CANDIDATE_CHARGERS_CAP=200`
  - Requirement linkage: caps total charger candidates used for planning.
- `NREL_INCLUDE_ALL_ELECTRIC_CHARGERS=true`
  - Requirement linkage: broadens the candidate charger set beyond “fast DC” when true (legacy NREL/mirror paths).
- `USE_NREL_NEARBY_ROUTE=false`
  - Requirement linkage: controls whether the corridor is sampled via route polyline vs straight/approx sampling.

### NREL HTTP / mirror refresh (not the POI-only `/plan` path)
- `NREL_API_KEY=<set in .env>`
  - Requirement linkage: required for **mirror refresh** and **legacy `remote_only`** charger queries — not for routine POI-backed planning.

### Valhalla leg modeling / feasibility (external integration tuning)
- `VALHALLA_BASE_URL` — e.g. `http://<nas-lan-ip>:8002` or `http://localhost:8002` (see **[docs/VALHALLA.md](docs/VALHALLA.md)**; default port is **8002**)
  - Requirement linkage: Valhalla is used to fetch route geometry for corridor sampling and/or leg timing.
- `USE_VALHALLA_DISTANCE_FEASIBILITY=false`
  - Requirement linkage: influences feasibility checks (distance vs other feasibility signals).
- `DISABLE_VALHALLA_LEG_TIME=true`
  - Requirement linkage: disables Valhalla leg time modeling (planner uses alternative timing).

### Overpass (hotel discovery)
- `OVERPASS_BASE_URL` (optional; default is `https://overpass-api.de/api/interpreter`)
  - Requirement linkage: controls the Overpass service used to find “Holiday Inn Express” hotels.

### NREL resiliency / rate limiting (legacy NREL HTTP client / refresh)
- `NREL_MAX_ATTEMPTS=3`
  - Requirement linkage: affects retries for flaky NREL calls when that client is used (mirror refresh or legacy routing).
- `NREL_INTER_REQUEST_DELAY_MS=250`
  - Requirement linkage: spacing between outbound NREL requests.
- `NREL_RETRY_BASE_DELAY_MS=500`
  - Requirement linkage: base backoff between retry attempts.
- `NREL_RETRY_JITTER_MS=150`
  - Requirement linkage: adds jitter to retry backoff to reduce synchronized retry storms.

## Requirements

### Functional Requirements (Backend)
1. Planning success response
   - When planning succeeds: `/plan` returns `status === "ok"`.
2. Overnight + hotel insertion
   - For the known QA case:
     - `start=Charleston, SC`
     - `end=<Holiday Inn Express Greensboro coordinate>`
   - Expected:
     - `stops` includes `start`, at least one `charge`, at least one `sleep`, and `end`
     - `sleep.name` includes `Holiday Inn Express`
     - `totals.overnightStopsCount >= 1`
   - Soft preference: when inserting a `sleep` stop at the chosen “Holiday Inn Express” location, prefer associating a nearby EV charger so the same stop can represent both “charging” and “sleeping” (if a charger is found within the configured hotel search radius).
   - When a charger is found, the API includes it on the `sleep` stop via `sleep.meta` (e.g. `sleep.meta.chargerFound=true` plus charger id/name/power/coords). Missing chargers must not cause planning to fail or the invariants to fail.
3. Max days cap
   - For the known QA case:
     - `start=Raleigh, NC`
     - `end=Seattle, WA`
   - Expected:
     - `status === "ok"`
     - `stops` includes `end`
     - `totals.overnightStopsCount <= 7`
4. Sanity: no sleep when direct-ish
   - For the known QA case:
     - `start=Raleigh, NC`
     - `end=Greensboro, NC`
   - Expected:
     - `status === "ok"`
     - `sleep` stops count is `0`
5. Fail gracefully
   - If planning fails:
     - `/plan` returns `status: "error"`
     - response includes a useful `message`
     - `debug` remains present when available

### Verification Requirements (UI)
When running UI QA via `gstack /qa` against the map page:
1. Page loads without console errors.
2. Clicking “Plan Trip” renders:
   - itinerary list
   - markers on the map
3. Error state does not crash:
   - if the planner fails, UI shows `message`
   - if `debug` is present, it is rendered

## Acceptance Criteria
1. Backend invariant set A (Overnight + Hotel insertion)
   - For the known “Charleston -> Holiday Inn Express Greensboro coordinate” inputs:
     - `status === "ok"`
     - `stops` includes `start`, at least one `charge`, at least one `sleep`, and `end`
     - `sleep.name` includes `Holiday Inn Express`
     - `totals.overnightStopsCount >= 1`
2. Backend invariant set B (Max days cap)
   - For the known “Raleigh -> Seattle” inputs:
     - `status === "ok"`
     - `stops` includes `end`
     - `totals.overnightStopsCount <= 7`
3. Backend invariant set C (Sanity no sleep)
   - For the known “Raleigh -> Greensboro” inputs:
     - `status === "ok"`
     - `sleep` stops count is `0`
4. UI QA checks pass without crashes and confirm basic rendering.

## Testing Plan

### Backend: Functional E2E Preflight
Use the dependency-free runner:
- `scripts/e2e-plan-functional.mjs`

Run modes:
1. Uses current `.env`
   - `node scripts/e2e-plan-functional.mjs`
2. Deterministic runner mode (spawns API with per-case env overrides)
   - `SPAWN_SERVER=true API_PORT=3001 node scripts/e2e-plan-functional.mjs`

### UI: Screenshot QA
Use `gstack /qa` targeting the map page.

Repo hygiene requirement (before running `/qa`):
- Git tree must be clean:
  - `git status --porcelain`
- Ensure build artifacts and ignored dirs are not tracked by QA:
  - `web/.next/`
  - `node_modules/`
  - `.cursor/`

### Manual Smoke Checklist (under 2 minutes)
1. Start:
   - `npm -w api run dev`
   - `npm -w web run dev`
2. Run backend preflight:
   - `node scripts/e2e-plan-functional.mjs`
3. UI sanity:
   - Open `http://localhost:3000/map`
   - Enter a known scenario
   - Click “Plan Trip”
   - Confirm itinerary renders and no JS errors appear

## Operational Notes / Flakiness
1. External services (NREL/Overpass/Valhalla) may return empty sets or time out.
2. Use the functional runner output and `debug.segmentsAttempted` when diagnosing intermittent failures.

## Open Questions
1. Should the overnight anchor selection logic be invariant to whether the threshold is crossed during/after the last charge segment, or is the current intended behavior acceptable?
2. Should the UI requirement include confirmation of `debug` rendering only when a failure occurs, or also in success cases?

---

## Version 2 (product / interactive planning)

**Normative API + types:** see **[docs/V2_API.md](docs/V2_API.md)**. **Optional** features: omitting v2 fields preserves **v1 A→B** behavior and existing QA invariants.

**Routing / UX direction (frozen):** **[docs/ROUTING_UX_SPEC.md](docs/ROUTING_UX_SPEC.md)** — optimization objectives, ~60s first screen, progressive refinements, local mirror + fail closed, confidence UX (not implementation detail).

**Document precedence:** If this PRD and **[docs/ROUTING_UX_SPEC.md](docs/ROUTING_UX_SPEC.md)** disagree on **routing behavior** or **progressive UX**, the routing UX spec **wins**. This PRD remains authoritative for **QA invariants**, **environment variables**, and **API contract** pointers to **[docs/V2_API.md](docs/V2_API.md)** unless the routing spec explicitly replaces a policy.

### V2 goals
1. **Along-route discovery:** users can see **charger** and **hotel** candidates on/near the corridor (map layers) using **server-returned candidate IDs** (same universe as planning). Picks reference IDs the planner consumes via **`lockedChargersByLeg`** / **`lockedHotelId`** on **`POST /plan`** — see **[docs/V2_API.md](docs/V2_API.md)** (Slice 1).
2. **Ordered multi-destination:** optional **`waypoints`** array (geocoded strings) between `start` and `end`. The planner **chains legs** sequentially; intermediate endpoints appear as **`waypoint`** stops in the itinerary.
3. **Interactive adjustments (roadmap):** user-selected charge + overnight hotel + replan (constraints API) — **not fully specified here**; see `docs/V2_API.md` for request/response extensions and **docs/V2_CHERRY_PICKS.md** for gated extras.

### Mid-journey replan (Slice 2 — design)

**User scenario:** User is en route. They’ve driven part of the trip (or deviated) and want to replan **from their current location** to the original destination. The remainder trip should be planned with the same semantics (charger selection, overnight, locks) as a fresh plan, but starting from “here” instead of the original `start`.

**Modes**

| Mode | Input | Description |
|------|-------|-------------|
| `replanFrom.coords` | `{ lat, lon }` | Use device geolocation as the new start. Client obtains coords via Geolocation API. |
| `replanFrom.stopId` | `{ stopId }` | Use a planned stop (charger, waypoint, hotel) from the previous plan as the new start. Coords derived from that stop. |

**Semantics**

- `end` and remaining `waypoints` stay as-is; `replanFrom` replaces `start` conceptually.
- `lockedChargersByLeg` / `lockedHotelId` apply to the **remainder** legs only (leg indices shifted).
- Response shape is the same (`stops`, `legs`, `totals`); it describes the remainder trip from the new start.
- If `replanFrom.stopId` references a stop from a different plan or an unknown id, the API returns `UNKNOWN_REPLAN_STOP`.

**Privacy**

- `replanFrom.coords` is **sensitive**. The API must not log or persist raw lat/lon by default. Document in `docs/V2_API.md` and future runbooks.
- Client must explicitly opt in (e.g. “Replan from my location” button) and obtain user consent before calling the Geolocation API.

**Not in scope (Slice 2)**

- Automatic “you’re off-route, replan?” prompts.
- Real-time position streaming or continuous replanning.
- SOC / battery state as input (future enhancement).

**Implementation:** **`replanFrom`** + **`previousStops`** (for `stopId`) — see **[docs/V2_API.md](docs/V2_API.md)** and **`TESTING.md`**.

### Slice 3 — dedicated candidates fetch

**Goal:** Allow the client to request **charger + hotel candidate pins** (same **id universe** as planning and locks) **without** running a full **`POST /plan`** solve — enabling **parallel** or **earlier** map layers on the way to the **~60s first screen** ([docs/ROUTING_UX_SPEC.md](docs/ROUTING_UX_SPEC.md) §3).

**Implemented:** **`POST /candidates`** — body aligned to **`PlanTripRequest`** (omit lock fields and `includeCandidates`); response **`responseVersion`: `v2-1-candidates`**, optional **`candidates`**, no `stops` / `legs`. **Normative contract:** **[docs/V2_API.md](docs/V2_API.md)** § Slice 3. Shared corridor logic: **`api/src/planner/corridorCandidates.ts`**.

**Design / follow-ups:** **[docs/designs/slice3-get-candidates.md](docs/designs/slice3-get-candidates.md)** — optional map prefetch, caching, rate limits.

### V2 non-goals (baseline)
1. Deterministic routes across replans (still non-goal).

### Routing optimization (precedence: ROUTING_UX_SPEC)

Waypoint **reordering** to minimize total time is **product direction** in **[docs/ROUTING_UX_SPEC.md](docs/ROUTING_UX_SPEC.md)** §1 and §4 — when implemented it must be **time-boxed** or **bounded** so early responses stay within the **~60s** / progressive model. Until then, **`waypoints`** remain **client-ordered** as in **[docs/V2_API.md](docs/V2_API.md)**. **Auto-reorder implementation** is **gated** — see **docs/V2_CHERRY_PICKS.md**.

### V2 configuration (environment)
| Variable | Purpose |
|----------|---------|
| `V2_MAX_WAYPOINTS` | Max intermediate waypoints (default `12`). |
| `V2_HOTEL_MAP_PREVIEW` | When not `false`, hotel candidate pins may query Overpass near a corridor sample (default enabled). |

### V2 verification
- **Regression:** v1 QA cases unchanged when **`waypoints` omitted** and behavior matches prior `mvp-1` responses.
- **Smoke:** `npm run qa:smoke` remains green; see `TESTING.md` § Version 2.

