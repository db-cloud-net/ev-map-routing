# Routing UX & objectives (frozen spec)

> **Planner corridor source:** With **`POI_SERVICES_BASE_URL`** set, **POI Services** is the runtime source for corridor DC-fast chargers, hotels, and optional pairs/edges. This app does **not** ship live NREL/Overpass clients or **`SOURCE_ROUTING_MODE`** (see **[`deprecate-nrel-overpass-mirror-travel-routing-adr.md`](./designs/deprecate-nrel-overpass-mirror-travel-routing-adr.md)**). **§2** still mentions mirror/NREL for **historical product policy** — the **current** API is **POI + Valhalla** for roads and **geocode** for user-entered addresses (not every location is modeled in POI).

This document captures **product and UX decisions** for EV trip planning with **Valhalla** (roads), **POI Services** (corridor chargers/hotels when configured), and **progressive** delivery of directions. It does **not** prescribe implementation tickets here.

**Related:** [VALHALLA.md](./VALHALLA.md) (base URL / port), [MAP_AND_NAV.md](./MAP_AND_NAV.md) (current MVP limitations), [TESTING.md](../TESTING.md) (env, QA, `debug.*`), [deprecate-nrel-overpass-mirror-travel-routing-adr.md](./designs/deprecate-nrel-overpass-mirror-travel-routing-adr.md) · [local-mirror-architecture.md](./local-mirror-architecture.md) *(archive — pre–POI-only corridor)*.

---

## 1. Optimization objective

- **Minimize total trip time** from source to destination, including:
  - **Driving** time (road-network, via Valhalla),
  - **Charging** time (modeled),
  - **Sleep** time (overnight / mandatory rest as defined by product rules).
- **Fixed inputs (v1 of this spec):**
  - **EV range:** 260 miles (or configurable; this spec assumes a single effective range).
  - **Travel day:** **10 hours** — caps or structures how driving + mandatory rest are applied (exact enforcement rule stays with planner math; this doc locks the **intent**).
- **Waypoints:** **May be reordered** to minimize total time (not fixed order only).
- **Scope:** **Cross-country** trips are in scope.

---

## 2. Data sources (chargers & hotels)

| Aspect | Decision |
|--------|----------|
| **POI Services (product default)** | When **`POI_SERVICES_BASE_URL`** is set, corridor **chargers**, **hotels**, optional **`pairs`** / **`edges`** come from **POI Services** — the runtime source for `/plan` and `/candidates`. Travel-Routing does **not** call live NREL or Overpass for corridor planning. |
| **Current API** | **`resolvePlanProviders`** is **POI-only** (`poi_only`). There is no **`SOURCE_ROUTING_MODE`**, mirror tier, or NREL/Overpass client in **`api/src/**`** — see **[`deprecate-nrel-overpass-mirror-travel-routing-adr.md`](./designs/deprecate-nrel-overpass-mirror-travel-routing-adr.md)** and **`TESTING.md`**. |
| **NREL / Overpass / local mirror (historical)** | Older **mirror + remote** operations were documented for corridor data **before** POI-only; that wiring is **not** shipped in this repo. **[`local-mirror-architecture.md`](./local-mirror-architecture.md)** remains for **archive / migration** context only. |
| **Refresh cadence** | **Monthly** **or** **user-initiated** update/download (POI ingest / offline jobs — outside this app’s hot path). |
| **Fallback** | **Fail closed** — if required corridor data is missing, corrupt, or unusable for the request, return a **clear, actionable error** (no silent switch to remote NREL/Overpass for `/plan` under this policy). |
| **POI corridor** | **Fail closed by default** — when **`POI_SERVICES_BASE_URL`** is configured and **`POI_SERVICES_FALLBACK_TO_NREL`** is not `true`, a failed or empty POI corridor query returns **`errorCode`** **`POI_SERVICES_CORRIDOR_FAILED`** or **`POI_SERVICES_NO_CHARGERS`** (no silent NREL corridor). See **[`poi-corridor-sleep-stops.md`](./designs/poi-corridor-sleep-stops.md)**. |
| **Trust** | Surface **data freshness** where the product exposes it (e.g. POI/manifest provenance, snapshot dates when relevant) so users can judge confidence. |

### 2.1 POI Select mode

When the map is in **POI Select** mode, the existing EV itinerary overlays are hidden while the active route polyline remains visible. Users can filter corridor POIs by type, distance from the route, and charger network (charger network filtering applies only to `charger` or `all` mode; it is unavailable for `accommodation`).

Selected POIs are highlighted on the map. The sidebar shows the candidate list with selected items sorted to the top. The UI does not replan automatically when POIs are selected; users switch to **EV Route** mode and click **Plan Trip** to convert selected POIs into ordered waypoints.

**POI fetch strategy:** Corridor POIs are fetched via `POST /corridor/pois`. The client splits long routes into ~150-mile sections (sampled at 1-mile spacing), queries each section in parallel with a per-segment limit (default **50**), and merges results by POI id client-side. This distributes results evenly across the full route rather than clustering near the origin.

**Paired hotel+charger markers:** Hotels and chargers within 400 yards of each other are marked **dark red** in the POI Select map view — the same 400-yard threshold used by the EV-route candidate display to identify `hasNearbyCharger`.

**Selected POI state persistence:**
- Toggling to EV Route (POI mode → `"off"`) and back: candidates and selections are **preserved**.
- Switching between POI types (e.g. Chargers → Hotels): candidates and selections are **cleared** so stale data cannot appear under a different filter.

If the plan request fails while carrying POI selections, the app preserves selections and returns an error state so the user can retry without losing progress.

*Implementation notes:* **`debug.sourceRouting`** carries **`sourceRoutingMode`** / **`effectiveSourceRoutingMode`** (both **`poi_only`**); legacy mirror snapshot fields were removed. Corridor sampling env: **`CORRIDOR_*`** (aliases include deprecated **`NREL_*`** names) — see **`TESTING.md`** and **`.env.example`**. On Synology Docker (**`prod-network`**), **`POI_SERVICES_BASE_URL=http://poi:8010`** — **[`d1-runbook.md`](./d1-runbook.md)**.

---

## 3. Time budget: first screen (≈60 seconds)

**Target:** From **Plan Trip** click until the user sees:

1. **Approximate full-trip route** on the map (whole-journey context; may be coarse or simplified polyline).
2. **Detailed** road geometry and **turn-by-turn** for an **initial horizon** measured in **time-on-route**, not miles-only.
3. **User must not** be left with only the first horizon **without** the **next** actionable segment being **in flight or ready** — see **§5**.

**Horizon rule (primary = time):**

- Use **cumulative travel time along the active route** (Valhalla-predicted times), e.g. **first ~8–12 minutes** of driving, **or** first **N** maneuvers — **whichever completes first**.
- **Guardrails:** minimum **maneuver count** (e.g. 2–3) so dense urban isn’t empty; optional **min/max distance** caps where needed.

If **60s** cannot be met in practice, **relax other constraints** (coarser global line, shorter horizon, tighter cap on reorder search, fewer refinements per round) — **before** abandoning the progressive model.

**Engineering decomposition (non-normative):** [`docs/designs/slice4-progressive-first-screen.md`](./designs/slice4-progressive-first-screen.md) — proposed API phases and Valhalla usage; does not change the decisions above until adopted by review.

---

## 4. Progressive refinements (after first screen)

- **Loop** refinement toward **next charge** or **next sleep**, then repeat until **final destination**.
- Each pass **increases fidelity** for the **leg to that anchor** (road geometry + maneuvers as needed).
- **User-visible:** show that refinement is **in progress** (status, progress, or staged checklist — implementation choice).

**Ordering constraint:** Waypoint **reorder** must be **time-boxed** or **bounded** so phase-1 can return within the **60s** budget; if the best order isn’t final yet, the UI must **invalidate or relabel** when the order changes.

*Implementation note (MVP):* **`/map`** shows a **three-stage checklist** (road preview → candidate pins → `/plan` itinerary), plus an ordered **refinement anchors** line from planner stops. With **`planJob: true`**, the API also emits **`partial_route`** checkpoints **after each timed segment hop** (toward the next charge or end) — **`reason`** **`segment_refine_hop_*`**, see **`docs/designs/range-leg-incremental-trust-adr.md`** § Slice 4. **Optional** **`optimizeWaypointOrder`** (time-budgeted haversine proxy) + map copy for segment hops and chosen order — further §4 fidelity remains in **`docs/designs/slice4-progressive-first-screen.md`** Phase **4** open rows.

---

## 5. Safety: never strand the driver on directions

- Do **not** present a state that implies “go” if the **next** required turn sequence **after** the current horizon is **unknown** and **not loading**.
- **Mitigations (any combination):**
  - **Prefetch** the following segment before the driver consumes the current one.
  - **Gate** “ready to navigate” until **segment 2** is at least **queued**.
  - **Blocking copy** when directions are still loading for the **next** decision.

---

## 6. Valhalla

- **Routing engine** for drive times, distances, polylines, and (with `directions`) maneuvers.
- **Base URL** and port: see [VALHALLA.md](./VALHALLA.md) (default **8002**).

---

## 6.5 Timeouts and “still working” (liveness)

- **Keep** maximum durations on **client** (`fetch` abort on `POST /plan`) and **server** (total wall clock around `planTrip`). **Why:** avoid a **stuck browser tab**, bound **API** work, and **surface failure** if Valhalla/POI/geocode/etc. hang instead of waiting forever.
- **Timeouts are not** the **§3** first-screen **target** (~60s). Long **multi-stop EV** solves may **legitimately** take **1–3+ minutes**; if users often hit the cap, **raise** env (see [TESTING.md](../TESTING.md)) rather than treating timeout as normal.
- **Without** streaming or job polling, **perceived** liveness is shown by: **elapsed time** in the UI, a **staged checklist** (road preview → pins → itinerary), and **parallel** work that can finish **before** `/plan` (teal `/route-preview` line, `/candidates` pins). **Optional:** enable **`NEXT_PUBLIC_PLAN_USE_JOB`** so **`GET /plan/jobs/:id`** delivers **checkpoints**; the map can show **partial** stops/legs before the job completes (real data — see §6.6). **Future:** SSE or NDJSON for finer-grained transport.
- **Planner-only debug** (e.g. `debug.segmentsAttempted`) on **blocking** `POST /plan` is **not** visible until the response returns. With **`planJob` + poll**, **`checkpoints`** (and partial snapshots) can surface **before** the final `result`; full **`debug.*`** still ships with **`result`** when **`complete`**.
- **Failures:** timeout copy should be **actionable** (raise limits, shorter trip, retry).

---

## 6.6 Progressive itinerary delivery (future — trust)

**Intent:** Show the **committed** route and **charge stops** being **assembled along the corridor** as the backend finishes work, so the user sees **real** progress—not a spinner guessing game.

| Decision | Choice |
|----------|--------|
| **Unit of progress** | **Driving leg** at **charge-stop granularity** (segment from current anchor to the **next charge** or **destination**)—the natural human unit for EV planning. |
| **Truth vs theater** | **Real only.** The UI may only advance when the **server** (or async job) returns **actual** partial itinerary data. **No** fake progress bars, **no** simulated milestones, **no** time-based “theater” that implies work completed when it has not. |
| **Partial failure** | **Retain** completed segments on the map/list. If a **later** segment fails or hits a timeout, offer **retry from the failed segment** (or replan forward from last good anchor)—**do not** wipe the whole trip by default. |
| **Implementation** | Requires **backend support**: e.g. **job id + poll** or **SSE** with checkpoints, or **multi-call** APIs that return **successive** partial `PlanTripResponse`-shaped slices. Not achievable with client-only animation over a single blocking `POST /plan`. |

**Related:** [TODOS.md](../TODOS.md) (*Plan job API + polling for `/plan` progress*).

---

## 7. UX principles (confidence & ease of use)

- **Honest states:** e.g. `Planning` → `Approximate route` → `Refining…` → `Up to date` / per-leg status.
- **Plain-language limits:** one line on what “approximate” vs “detailed” means on the map.
- **Assumptions visible:** range, travel-day rule, charging model — short “Assumptions” surface.
- **Actionable failures:** title → **why** (POI/corridor error, empty corridor, timeout) → **what to do** (refresh data, narrow trip, retry).
- **Route changed:** if refinement **changes** the plan, notify with **what changed** (e.g. order or one stop).
- **Disclaimer:** planning aid — follow **road signs** and **local laws**; not a substitute for in-vehicle navigation where required.
- **Explicitly out of scope for this spec:** comparison to third-party consumer mapping products.

---

## 8. Out of scope / follow-ons

- **Slice 2** `replanFrom` / mid-journey — see [V2_API.md](./V2_API.md) roadmap and PRD.
- **Shareable links**, accounts — see [V2_CHERRY_PICKS.md](./V2_CHERRY_PICKS.md).

---

## 9. Revision

When implementation choices diverge (e.g. SSE vs poll for refinements), update this doc or add an **ADR** and link it here.

*Frozen from product conversation; amend by PR with review.*
