# Version 2 — API contract (`POST /plan`)

This document describes **additive** fields on `POST /plan`. Omitting them preserves **v1** behavior (`start` + `end` only).

## Request body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `start` | string | yes† | Start place text (geocoded). **Omitted** when `replanFrom` is set (Slice 2). |
| `end` | string | yes | End place text (geocoded). |
| `waypoints` | string[] | no | Ordered intermediate destinations (each geocoded). Empty/omitted = single leg (v1). With **Slice 2**, only **remaining** waypoints after the new start. |
| `includeCandidates` | boolean | no | When `true`, successful **`ok`** responses may include `candidates` for map layers. |
| `lockedChargersByLeg` | string[][] | no | **Slice 1:** One array per **driving leg** (length = `max(1, waypoints.length + 1)`). Each inner array is an **ordered** list of charger **ids** that must be visited on that leg (hard constraint). Ids must exist in the current corridor’s candidate set (same universe as `candidates.chargers`). |
| `lockedHotelId` | string | no | **Slice 1:** When an overnight stop is inserted, prefer this **Overpass** hotel id if it appears near an anchor charger. |
| `replanFrom` | `{ coords: { lat, lon } }` \| `{ stopId: string }` | no† | **Slice 2:** New plan start — device coordinates or a stop from the prior plan. **Mutually exclusive** with non-empty `start`. |
| `previousStops` | `ItineraryStop[]` | no‡ | **Slice 2:** Stops from the **immediately previous** successful `POST /plan` response. **Required** when `replanFrom.stopId` is set (stateless lookup; no server session). |

† Exactly one of **`start`** (non-empty) or **`replanFrom`** must be present.  
‡ Required for `replanFrom.stopId`; omit for `replanFrom.coords`.

### Limits
- `waypoints` length capped by **`V2_MAX_WAYPOINTS`** (default **8**; server schema allows up to **24** strings — the planner enforces the env cap).
- Each `lockedChargersByLeg` row length capped by **`V2_MAX_LOCKED_CHARGERS`** (default **8**).
- Strings are trimmed; empty lines ignored on the web client.
- `previousStops` capped at **200** entries (schema).

### Candidate surface (embed in `/plan` response)
v2 **does not** add a separate `GET` endpoint in the baseline implementation. The web receives **`candidates` inside the `POST /plan` response** when `includeCandidates: true`:
- **`candidates.chargers`**: subset of NREL-derived chargers used for corridor planning (stable `id` strings).
- **`candidates.hotels`**: optional Holiday Inn Express preview near a corridor sample (Overpass), gated by **`V2_HOTEL_MAP_PREVIEW`** (see `.env.example`).

**Rule:** map markers should only offer picks that appear in `candidates` (or locked-ID fields), so the client cannot invent POIs the planner never saw.

### Lock semantics (Slice 1)
- **Chargers:** Implemented as a **hard** constraint via **chained** least-time segments: `start → lock₁ → … → lockₙ → end` within each leg. Does **not** run the overnight splitter; if the chained plan exceeds **`OVERNIGHT_THRESHOLD_MINUTES`**, the API returns **`LOCKED_ROUTE_TOO_LONG`**.
- **Hotels:** When the standard overnight path runs, **`lockedHotelId`** selects that hotel when it appears in Overpass results near a candidate anchor; otherwise **`UNKNOWN_HOTEL_LOCK`**.

### Mid-journey replan (Slice 2)

User replans from **current** coordinates or a **planned stop** to **`end`** (and optional remainder **`waypoints`**). See **PRD.md** § *Mid-journey replan (Slice 2)* for product scenario and privacy.

- **`replanFrom.coords`:** Use as the new start point (no geocode). Structured logs use **`replanFrom: { mode: "coords" }`** — **raw lat/lon are not logged**.
- **`replanFrom.stopId`:** Resolved against **`previousStops`** (same `id` as a prior `stops[]` entry). Logs include **`stopId`** only.
- **`lockedChargersByLeg` / `lockedHotelId`:** Apply to **remainder** legs only (same row count as `max(1, waypoints.length + 1)` for the remainder trip).
- Successful responses may include **`debug.replan: true`** when the plan used mid-journey replan (`replanFrom`).

## Response

`responseVersion` is **`mvp-1`** for legacy-shaped requests and **`v2-1`** when any v2 field is present (`waypoints`, `includeCandidates`, `lockedChargersByLeg`, `lockedHotelId`, or **`replanFrom`**).

### `PlanTripResponse` additions
- **`candidates?`**: `{ chargers, hotels, legIndex }` — when `includeCandidates` was requested and planning succeeded for at least one leg.
- **`errorCode?`**: machine-readable failure (`INVALID_LOCK_LEGS`, `UNKNOWN_CHARGER_LOCK`, `INFEASIBLE_CHARGER_LOCK`, `LOCKED_ROUTE_TOO_LONG`, `UNKNOWN_HOTEL_LOCK`, **`UNKNOWN_REPLAN_STOP`**, **`MISSING_PREVIOUS_STOPS`**, **`MISSING_START`**, …).
- Stop type **`waypoint`**: used for intermediate destinations in multi-leg trips.

### Errors (message + optional `errorCode`)
- **Too many waypoints:** `status: "error"` with message `Too many waypoints (max N).`
- **Lock shape:** `INVALID_LOCK_LEGS` if `lockedChargersByLeg.length` ≠ number of driving legs.
- **Too many locks per leg:** `TOO_MANY_LOCKED_CHARGERS`.
- **Duplicate id in a leg:** `DUPLICATE_CHARGER_LOCK`.
- **Unknown charger id:** `UNKNOWN_CHARGER_LOCK` (not in corridor candidate set).
- **Infeasible route with locks:** `INFEASIBLE_CHARGER_LOCK` (solver cannot connect locked sequence).
- **Locked single-day trip too long:** `LOCKED_ROUTE_TOO_LONG`.
- **Unknown / unplaceable hotel lock:** `UNKNOWN_HOTEL_LOCK`.
- **Slice 2 — unknown stop id:** `UNKNOWN_REPLAN_STOP` when `replanFrom.stopId` is not found in `previousStops`.
- **Slice 2 — missing context:** `MISSING_PREVIOUS_STOPS` when `replanFrom.stopId` is used without a `previousStops` array (planner guard; prefer Zod validation first).
- **Request shape (Zod):** e.g. both `start` and `replanFrom`, or neither — HTTP **400** with validation message.

### Privacy

- **`replanFrom.coords`:** Do **not** log or persist raw lat/lon in production analytics; server logs use **`mode: "coords"`** only.

### Testing

- **`TESTING.md`** — Slice 2 manual checks; **`node scripts/e2e-replan-smoke.mjs`** — automated coords + `stopId` + unknown id (spawns API; needs NREL/Valhalla/geocode like other E2E).

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
