# Version 2 — API contract (`POST /plan`)

> **Planner corridor source:** With **`POI_SERVICES_BASE_URL`** set, **POI Services** is the runtime source for corridor DC-fast chargers, hotels, and optional pairs/edges. Candidate **`source`** values may still include **`nrel`** for legacy id shape or non-POI deployments; product routing does **not** rely on live NREL when POI corridor is configured.

This document describes **additive** fields on `POST /plan`. Omitting them preserves **v1** behavior (`start` + `end` only).

## Request body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `start` | string | yes† | Start place text (geocoded). **Omitted** when `replanFrom` is set (Slice 2). |
| `end` | string | yes | End place text (geocoded). |
| `waypoints` | string[] | no | Ordered intermediate destinations (each geocoded). Empty/omitted = single leg (v1). With **Slice 2**, only **remaining** waypoints after the new start. Selected corridor POIs from the UI may be represented as ordered waypoints in this field. |
| `includeCandidates` | boolean | no | When `true`, successful **`ok`** responses may include `candidates` for map layers. |
| `lockedChargersByLeg` | string[][] | no | **Slice 1:** One array per **driving leg** (length = `max(1, waypoints.length + 1)`). Each inner array is an **ordered** list of charger **ids** that must be visited on that leg (hard constraint). Ids must exist in the current corridor’s candidate set (same universe as `candidates.chargers`). |
| `lockedHotelId` | string | no | **Slice 1:** Priority hotel candidate for overnight insertion — searched first using the same rules as other hotels (not a strict hard lock). Accepts **Overpass** ids from `candidates.hotels`, or **`poi_services:hotel:<numeric>`** when corridor hotels are POI-sourced. |
| `replanFrom` | `{ coords: { lat, lon } }` \| `{ stopId: string }` | no† | **Slice 2:** New plan start — device coordinates or a stop from the prior plan. **Mutually exclusive** with non-empty `start`. |
| `previousStops` | `ItineraryStop[]` | no‡ | **Slice 2:** Stops from the **immediately previous** successful `POST /plan` response. **Required** when `replanFrom.stopId` is set (stateless lookup; no server session). |
| `planJob` | boolean | no | When **`true`**, the API responds **`202 Accepted`** immediately with a **`jobId`** and runs the planner **in the background**. Poll **`GET /plan/jobs/:jobId`** for **`checkpoints`** (solver-attempt rows as they complete) and, when **`status` is `complete`**, the full plan body under **`result`**. Optionally use **`GET /plan/jobs/:jobId/stream`** (**NDJSON**) or **`GET /plan/jobs/:jobId/events`** (**SSE** / **`EventSource`**) for the same checkpoint payloads — see **Async plan** below. In-memory job store with TTL — not for cross-server durability. See **`docs/designs/range-leg-incremental-trust-adr.md`**. |
| `optimizeWaypointOrder` | boolean | no | **Multi-waypoint (≥2 intermediates):** when **`true`** and there are **no** per-leg locks or hotel lock and **no** **`replanFrom`**, the planner may **reorder** intermediate stops to minimize a **haversine leg-sum** proxy (**time-budgeted**, **`PLAN_WAYPOINT_REORDER_BUDGET_MS`**). Successful **`ok`** responses may include **`debug.waypointOrderOptimization`** (`applied`, `userOrder`, `chosenOrder`, scores). Ignored when locks are present (leg indices are fixed to user order). |

† Exactly one of **`start`** (non-empty) or **`replanFrom`** must be present.  
‡ Required for `replanFrom.stopId`; omit for `replanFrom.coords`.

### Limits
- `waypoints` length capped by **`V2_MAX_WAYPOINTS`** (default **12**; server schema allows up to **24** strings — the planner enforces the env cap).
- Each `lockedChargersByLeg` row length capped by **`V2_MAX_LOCKED_CHARGERS`** (default **8**).
- Strings are trimmed; empty lines ignored on the web client.
- `previousStops` capped at **200** entries (schema).

### Async plan (`planJob: true`)
- **`POST /plan`** with **`planJob: true`** → **`202`** JSON: **`jobId`**, **`requestId`**, **`responseVersion`**, **`status`: `"running"`**, **`pollUrl`**, **`streamUrl`** (NDJSON), **`eventsUrl`** (SSE).
- **`GET /plan/jobs/:jobId`** → **`200`**: **`status`** is **`running`** \| **`complete`** \| **`error`**; **`checkpoints`** is an array of **`{ t, legIndex, attempt }`**. Most **`attempt`** rows mirror **`debug.segmentsAttempted`** (solver segments as they finish). Some rows use **`attempt.kind === "partial_route"`** with **`attempt.partialSnapshot`** **`{ stops, legs, rangeLegs }`** — a consistent **partial itinerary** so the client can update the map/sidebar **before** **`complete`**. Blocking **`POST /plan`** remains atomic (no partial body). When **`complete`**, **`result`** matches the synchronous **`POST /plan`** body (including merged **`debug.providerCalls`**). When **`error`**, **`message`**, **`httpStatus`**, and optional **`debug`** mirror the synchronous error response.
- **`GET /plan/jobs/:jobId/stream`** → **`200`**, **`Content-Type: application/x-ndjson`**: newline-delimited JSON. Each line is one object: **`type: "checkpoint"`** with **`checkpoint`** **`{ t, legIndex, attempt }`** (same as poll), **`type: "heartbeat"`** with **`t`** (timestamp ms) to keep idle connections alive, **`type: "complete"`** with **`result`** (full plan body), or **`type: "error"`** with **`message`**, **`httpStatus`**, optional **`debug`**, **`lastPartialSnapshot`**. Lines include **`jobId`**, **`requestId`**, **`responseVersion`** on every event for correlation. If the job finished before the connection opens, the server **replays** all checkpoints then emits **`complete`** or **`error`** and closes the body. Heartbeat interval: **`PLAN_JOB_SSE_HEARTBEAT_MS`** (default **25000**; **`0`** disables).
- **`GET /plan/jobs/:jobId/events`** → **`200`**, **`Content-Type: text/event-stream`**: Server-Sent Events. **`data:`** lines carry the **same JSON objects** as NDJSON (`retry: 3000` is sent first for **`EventSource`** reconnection hints), including **`type: "heartbeat"`**. Use **`EventSource`** or parse **`data:`** lines like NDJSON. Same replay + terminal behavior as **`/stream`**.
- Omitting **`planJob`** or **`false`** keeps the usual blocking **`POST /plan`** (**200** / **400** / **408**).
- **Web map:** enable **`NEXT_PUBLIC_PLAN_USE_JOB=true`** (see **`WEB_SWITCHES.md`**) to use this flow from the UI client.

### Candidate surface (embed in `/plan` response)
Unless using **`planJob`** (see above), the web receives **`candidates` inside the `POST /plan` response** when `includeCandidates: true`:
- **`candidates.chargers`**: subset of corridor chargers used for planning (stable `id` strings; from **POI Services** when configured, otherwise legacy NREL/mirror-sourced pools).
- **`candidates.hotels`**: optional hotel preview near a corridor sample (**POI Services** when the corridor is POI-backed; otherwise Overpass), gated by **`V2_HOTEL_MAP_PREVIEW`** (see `.env.example`).

**Rule:** map markers should only offer picks that appear in `candidates` (or locked-ID fields), so the client cannot invent POIs the planner never saw.

### Lock semantics (Slice 1)
- **Chargers:** Implemented as a **hard** constraint via **chained** least-time segments: `start → lock₁ → … → lockₙ → end` within each leg. Does **not** run the overnight splitter; if the chained plan exceeds **`OVERNIGHT_THRESHOLD_MINUTES`**, the API returns **`LOCKED_ROUTE_TOO_LONG`**.
- **Hotels:** When the standard overnight path runs, **`lockedHotelId`** is searched first as the initial hotel candidate, then normal hotel search continues if needed (same pairing/detour rules as other candidates).

### Mid-journey replan (Slice 2)

User replans from **current** coordinates or a **planned stop** to **`end`** (and optional remainder **`waypoints`**). See **PRD.md** § *Mid-journey replan (Slice 2)* for product scenario and privacy.

- **`replanFrom.coords`:** Use as the new start point (no geocode). Structured logs use **`replanFrom: { mode: "coords" }`** — **raw lat/lon are not logged**.
- **`replanFrom.stopId`:** Resolved against **`previousStops`** (same `id` as a prior `stops[]` entry). Logs include **`stopId`** only.
- **`lockedChargersByLeg` / `lockedHotelId`:** Apply to **remainder** legs only (same row count as `max(1, waypoints.length + 1)` for the remainder trip).
- Successful responses may include **`debug.replan: true`** when the plan used mid-journey replan (`replanFrom`).
- **`debug.sourceRouting`** — **`sourceRoutingMode`**, **`effectiveSourceRoutingMode`**, and when the mirror tier is active: **`mirrorSnapshotId`**, **`mirrorSchemaVersion`**, **`mirrorCreatedAt`**, **`mirrorAgeHours`** (ROUTING_UX_SPEC §2 trust). Present on **`POST /plan`** and candidates-only **`POST /candidates`** success bodies when applicable.
- **`debug.providerCalls.poi_services`** — HTTP timing for POI Services **`POST /corridor/query`** when **`POI_SERVICES_BASE_URL`** is configured (see **[`docs/designs/data-plane-vs-application-plane-adr.md`](./designs/data-plane-vs-application-plane-adr.md)**). Other provider buckets may include **`valhalla`**, **`nrel`** (legacy path only), **`overpass`**, **`geocode`**.

## Response

`responseVersion` is **`mvp-1`** for legacy-shaped requests and **`v2-1`** when any v2 field is present (`waypoints`, `includeCandidates`, `lockedChargersByLeg`, `lockedHotelId`, **`replanFrom`**, **`planJob`**, or **`optimizeWaypointOrder`**).

### `PlanTripResponse` additions
- **`candidates?`**: `{ chargers, hotels, legIndex }` — when `includeCandidates` was requested and planning succeeded for at least one leg. Charger **`source`** is **`nrel`** \| **`poi_services`** (prefer **`poi_services`** when POI corridor is active); hotel **`source`** is **`overpass`** \| **`poi_services`** when POI Services supplies corridor hotels.
- **`rangeLegs?`** (presentation): on **`status: "ok"`**, optional array of **`RangeLegSummary`** — itinerary grouped at **charge** stops (rolling origin after each charge through the next charge or **end**). Derived from the existing least-time plan (optionally **range-biased** via **`PLAN_RANGE_LEG_CHARGE_STOP_PENALTY_MINUTES`** — **`debug.rangeLegOptimizer`** — and/or **tighter linear hop feasibility** via **`PLAN_RANGE_LEG_FEASIBILITY_MARGIN_FRAC`** — **`debug.rangeLegFeasibility`**). Mirrored under **`debug.rangeLegs`**. Optional **map** use (polyline split + sidebar) is **debug-only** — **`NEXT_PUBLIC_MAP_DEBUG_RANGE_LEGS`** in **`docs/WEB_SWITCHES.md`**. See **`docs/designs/range-based-segments-intent.md`**.
- **`debug.rangeLegOptimizer?`** (when **`PLAN_RANGE_LEG_CHARGE_STOP_PENALTY_MINUTES` > 0**): **`{ mode: "soft_penalty_charge_stop", chargeStopPenaltyMinutes }`** — see **`docs/designs/range-leg-incremental-trust-adr.md`** § Pillar 1 slice C.
- **`debug.rangeLegFeasibility?`** (when **`PLAN_RANGE_LEG_FEASIBILITY_MARGIN_FRAC` > 0**): **`{ mode: "margin_frac", marginFrac, feasibilityScale }`** — slice D in the same ADR.
- **`debug.socCarryChainedSegments?`** (locked **`lockedChargersByLeg`** plans when **`PLAN_SOC_CARRY_CHAINED_SEGMENTS`** is not **`false`**): array of **`{ chainIndex, initialDepartSocFraction }`** — slice E; linear SOC carried into each segment after the first.
- **`debug.socCarryOvernightSegments?`** (when **`PLAN_SOC_CARRY_OVERNIGHT_SEGMENTS`** is not **`false`** and carry applies): array of **`{ kind: "overnight_iteration" | "remainder", overnightIndex?, initialDepartSocFraction }`** — slice F; linear SOC carried into later overnight iterations and the remainder solve in **`planTripOneLeg`**.
- **`errorCode?`**: machine-readable failure (`INVALID_LOCK_LEGS`, `UNKNOWN_CHARGER_LOCK`, `INFEASIBLE_CHARGER_LOCK`, `LOCKED_ROUTE_TOO_LONG`, `UNKNOWN_HOTEL_LOCK`, **`UNKNOWN_REPLAN_STOP`**, **`MISSING_PREVIOUS_STOPS`**, **`MISSING_START`**, **`POI_SERVICES_CORRIDOR_FAILED`**, **`POI_SERVICES_NO_CHARGERS`**, …).
- Stop type **`waypoint`**: used for intermediate destinations in multi-leg trips.

### Errors (message + optional `errorCode`)
- **Too many waypoints:** `status: "error"` with message `Too many waypoints (max N).`
- **Lock shape:** `INVALID_LOCK_LEGS` if `lockedChargersByLeg.length` ≠ number of driving legs.
- **Too many locks per leg:** `TOO_MANY_LOCKED_CHARGERS`.
- **Duplicate id in a leg:** `DUPLICATE_CHARGER_LOCK`.
- **Unknown charger id:** `UNKNOWN_CHARGER_LOCK` (not in corridor candidate set).
- **Infeasible route with locks:** `INFEASIBLE_CHARGER_LOCK` (solver cannot connect locked sequence).
- **Locked single-day trip too long:** `LOCKED_ROUTE_TOO_LONG`.
- **Slice 2 — unknown stop id:** `UNKNOWN_REPLAN_STOP` when `replanFrom.stopId` is not found in `previousStops`.
- **Slice 2 — missing context:** `MISSING_PREVIOUS_STOPS` when `replanFrom.stopId` is used without a `previousStops` array (planner guard; prefer Zod validation first).
- **POI Services corridor (fail-closed):** **`POI_SERVICES_CORRIDOR_FAILED`** when the POI **`POST /corridor/query`** call fails (HTTP/network/timeout) and legacy NREL corridor fallback is not enabled; **`POI_SERVICES_NO_CHARGERS`** when POI returns no DC-fast chargers under the same policy. Same codes may appear on **`POST /candidates`** when the corridor step fails before pins are built.
- **Request shape (Zod):** e.g. both `start` and `replanFrom`, or neither — HTTP **400** with validation message.

### Privacy

- **`replanFrom.coords`:** Do **not** log or persist raw lat/lon in production analytics; server logs use **`mode: "coords"`** only.

### Testing

- **`TESTING.md`** — Slice 2 manual checks; **`node scripts/e2e-replan-smoke.mjs`** — automated coords + `stopId` + unknown id (spawns API; needs POI Services + Valhalla + geocode like other E2E, or legacy envs if testing remote-only paths).

---

---

## `POST /corridor/pois`

Returns POIs along a route corridor for the **POI Select** map mode. This is a direct client-facing endpoint (not a proxy through `/plan`) so the web UI can fetch corridor POIs independently of trip planning.

| | |
|--|--|
| **Method** | `POST /corridor/pois` |
| **`responseVersion`** | `v2-1-corridor-pois` |

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `shape` | `{ lat, lon }[]` | yes | Sampled route polyline. Max **5,000 points**. The client sends one section of the route per request (see client sectioning below). |
| `corridor_radius_mi` | number | yes | Corridor half-width in miles. Max **500**. |
| `poi_type` | `"accommodation"` \| `"charger"` \| `"all"` | yes | POI type filter. `"accommodation"` is mapped to `"hotel"` for the POI Service query and back on response. |
| `network` | string | no | Charger network filter (e.g. `"Tesla"`, `"ChargePoint"`). Ignored when `poi_type` is `"accommodation"`. |
| `limit` | number | no | Result cap **per request** (not a global total — see sectioning). Default enforced by the POI Service. The web UI default is **50 per section**. |

**Response:**

```json
{
  "status": "ok",
  "pois": [
    {
      "id": "poi_services:hotel:16247",
      "poi_type": "accommodation",
      "name": "Holiday Inn Express Mason City",
      "lat": 43.147,
      "lon": -93.246,
      "address": "4th St SW",
      "city": "Mason City",
      "state": "IA",
      "network": "IHG",
      "distance_from_route_mi": 0.3,
      "attributes": {
        "onsite_charger_level": "L2",
        "onsite_charger_power_kw": 7.7,
        "nearby_dcfc_distance_yd": 285,
        "rooms": 120
      }
    }
  ],
  "debug": { "count": 1, "poiServiceDurationMs": 45 }
}
```

`distance_from_route_mi` is the haversine distance from the POI to the nearest point in the provided `shape`.

**Error responses:** HTTP 400 for schema violations (shape too large, radius out of range); HTTP 500 with `status: "error"` and `message` if the POI Service call fails.

**Client sectioning strategy:** The POI Service fills `limit` from POIs nearest to the **start** of the shape. On long routes this causes all results to cluster near the origin. The web client avoids this by:

1. Distance-sampling the route shape at 1-mile intervals.
2. Splitting into **~150-mile sections** and calling `POST /corridor/pois` for each section **in parallel** with `limit = per-segment value`.
3. Merging and deduplicating results by `id` client-side.

This distributes results evenly across the full route. A Raleigh→Seattle route (~2,800 mi) produces ~19 sections; at 50 POIs/section that is up to ~950 candidates after deduplication.

**See also:** [`docs/designs/poi-route-overlay.md`](./designs/poi-route-overlay.md) §4.1 for full implementation details.

---

## Slice 3 — `POST /candidates`

**Design notes & rollout:** **[`docs/designs/slice3-get-candidates.md`](designs/slice3-get-candidates.md)**.

**Intent:** Return the **same** `PlanTripCandidates` id universe as **`POST /plan`** with `includeCandidates: true`, **without** running the least-time itinerary solver — for progressive map UX ([**ROUTING_UX_SPEC.md**](ROUTING_UX_SPEC.md) §3).

| | |
|--|--|
| **Method** | `POST /candidates` |
| **Body** | Same trip inputs as **`PlanTripRequest`** **except** omit `includeCandidates`, `lockedChargersByLeg`, and `lockedHotelId`: `end`, and either `start` or **`replanFrom`** (+ `previousStops` when using `stopId`); optional `waypoints`. |
| **Response** | `status`, `requestId`, `responseVersion` (**`v2-1-candidates`**), optional **`candidates`** (`PlanTripCandidates`), optional **`errorCode`** / `message` on failure. **No** `stops` / `legs` / `totals`. |

**Regression:** Baseline behavior unchanged: **`POST /plan`** with `includeCandidates` still returns candidates inside the plan response.

**Web map:** The **`/map`** page may call **`POST /candidates`** in parallel with **`POST /plan`** (see **`NEXT_PUBLIC_PREFETCH_CANDIDATES`** in **`WEB_SWITCHES.md`**) so pins can render before the full plan returns.

---

## Slice 4 — progressive ~60s first screen

**Product goals:** **[ROUTING_UX_SPEC.md](ROUTING_UX_SPEC.md)** §3–§5. **Design:** **[`docs/designs/slice4-progressive-first-screen.md`](designs/slice4-progressive-first-screen.md)**.

### `POST /route-preview` (Phase 1 — single leg)

Fast **Valhalla-only** preview: **no** EV least-time solver, **no** NREL/Overpass. Returns a **full-trip road polyline** plus a **time-budgeted** first-horizon maneuver list (see **`ROUTE_PREVIEW_*`** in **`.env.example`**).

| | |
|--|--|
| **Method** | `POST /route-preview` |
| **Body** | `{ "start": string, "end": string }` — **v1:** no `waypoints`, no `replanFrom` (omit multi-stop until a later phase). |
| **Response** | `requestId`, `responseVersion`: **`v2-1-route-preview`**, `status`, optional `message` / **`errorCode`**, optional **`preview`** on success. |
| **`preview` (ok)** | **`polyline`**: GeoJSON **LineString**; **`tripTimeMinutes`**, **`tripDistanceMiles`** (from Valhalla summary when present); **`horizon`**: `{ maxMinutes, maneuvers[], cumulativeTimeSeconds }` — first time-budgeted clip (§3 guardrails); optional **`nextHorizon`**: same shape — **second** clip from the **same** Valhalla maneuver list (§5 “next segment ready” without a second HTTP call). Omitted when the route ends within the first horizon. |

**Error codes (non-exhaustive):** `GEOCODE_FAILED`, `VALHALLA_ROUTE_PREVIEW_FAILED`, `ROUTE_PREVIEW_NO_GEOMETRY`, `ROUTE_PREVIEW_FAILED`; validation: waypoints in v1 → HTTP **400**.

**Testing:** `node scripts/e2e-route-preview-smoke.mjs` (spawn API; needs geocode + Valhalla like other E2E).

**Web / map:** **`/map`** calls **`POST /route-preview`** in parallel with **`POST /plan`** on **normal** trips (normal start, optional **waypoints** as separate hops — one request per consecutive pair) when **`NEXT_PUBLIC_PREFETCH_ROUTE_PREVIEW`** is not **`false`** (**`WEB_SWITCHES.md`**). Responses are **merged** into one preview line on the client. Teal **dashed** line + **first + second** horizon turn lists when Valhalla has enough maneuvers (merged across hops); replaced when **`POST /plan`** succeeds.
