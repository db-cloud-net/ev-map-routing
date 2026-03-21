# Version 2 — API contract (`POST /plan`)

This document describes **additive** fields on `POST /plan`. Omitting them preserves **v1** behavior (`start` + `end` only).

## Request body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `start` | string | yes | Start place text (geocoded). |
| `end` | string | yes | End place text (geocoded). |
| `waypoints` | string[] | no | Ordered intermediate destinations (each geocoded). Empty/omitted = single leg (v1). |
| `includeCandidates` | boolean | no | When `true`, successful **`ok`** responses may include `candidates` for map layers. |
| `lockedChargersByLeg` | string[][] | no | **Slice 1:** One array per **driving leg** (length = `max(1, waypoints.length + 1)`). Each inner array is an **ordered** list of charger **ids** that must be visited on that leg (hard constraint). Ids must exist in the current corridor’s candidate set (same universe as `candidates.chargers`). |
| `lockedHotelId` | string | no | **Slice 1:** When an overnight stop is inserted, prefer this **Overpass** hotel id if it appears near an anchor charger. |

### Limits
- `waypoints` length capped by **`V2_MAX_WAYPOINTS`** (default **8**; server schema allows up to **24** strings — the planner enforces the env cap).
- Each `lockedChargersByLeg` row length capped by **`V2_MAX_LOCKED_CHARGERS`** (default **8**).
- Strings are trimmed; empty lines ignored on the web client.

### Candidate surface (embed in `/plan` response)
v2 **does not** add a separate `GET` endpoint in the baseline implementation. The web receives **`candidates` inside the `POST /plan` response** when `includeCandidates: true`:
- **`candidates.chargers`**: subset of NREL-derived chargers used for corridor planning (stable `id` strings).
- **`candidates.hotels`**: optional Holiday Inn Express preview near a corridor sample (Overpass), gated by **`V2_HOTEL_MAP_PREVIEW`** (see `.env.example`).

**Rule:** map markers should only offer picks that appear in `candidates` (or locked-ID fields), so the client cannot invent POIs the planner never saw.

### Lock semantics (Slice 1)
- **Chargers:** Implemented as a **hard** constraint via **chained** least-time segments: `start → lock₁ → … → lockₙ → end` within each leg. Does **not** run the overnight splitter; if the chained plan exceeds **`OVERNIGHT_THRESHOLD_MINUTES`**, the API returns **`LOCKED_ROUTE_TOO_LONG`**.
- **Hotels:** When the standard overnight path runs, **`lockedHotelId`** selects that hotel when it appears in Overpass results near a candidate anchor; otherwise **`UNKNOWN_HOTEL_LOCK`**.

## Response

`responseVersion` is **`mvp-1`** for legacy-shaped requests and **`v2-1`** when any v2 field is present (`waypoints`, `includeCandidates`, `lockedChargersByLeg`, or `lockedHotelId`).

### `PlanTripResponse` additions
- **`candidates?`**: `{ chargers, hotels, legIndex }` — when `includeCandidates` was requested and planning succeeded for at least one leg.
- **`errorCode?`**: machine-readable failure (`INVALID_LOCK_LEGS`, `UNKNOWN_CHARGER_LOCK`, `INFEASIBLE_CHARGER_LOCK`, `LOCKED_ROUTE_TOO_LONG`, `UNKNOWN_HOTEL_LOCK`, …).
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

## Roadmap (not implemented yet)
- **`replanFrom` / mid-journey** modes — document when added; keep **`TESTING.md`** in sync.
