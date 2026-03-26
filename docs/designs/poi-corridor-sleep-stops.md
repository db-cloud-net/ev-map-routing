# Design: POI corridor for sleep stops, hotels, and hotel↔charger pairs

**Status:** Implemented (Travel-Routing side).  
**Related:** [data-plane-vs-application-plane-adr.md](./data-plane-vs-application-plane-adr.md) · [ROUTING_UX_SPEC.md](../ROUTING_UX_SPEC.md) §2 · [V2_API.md](../V2_API.md)

## Problem

Overnight planning needs **hotels near anchor chargers** and **DCFC near the chosen sleep hotel**. Duplicate sources (Overpass + NREL near-point) conflict with the **data-plane** goal: POI shards already expose **corridor hotels**, **chargers**, and **`pairs`** (precomputed hotel↔DCFC proximity).

## POI layers (single `POST /corridor/query`)

| Layer | Use in Travel-Routing |
|-------|------------------------|
| `charger` | Corridor DC-fast pool for least-time segment |
| `hotel` | Sleep-stop **candidates** (filter: within overnight radius of anchor) |
| `edges` | Optional precomputed road times between corridor chargers |
| `pairs` | Optional enrich / redundancy: map **`poi_services:hotel:<id>`** → DCFC when layer is requested |

Corridor request may include **`filters.pairs_max_distance_yd`**, aligned with **`OVERNIGHT_HOTEL_RADIUS_METERS`** (converted to yards). POI Services enforces server-side caps (see sibling repo `shardReader` / `proximity_sweep` docs).

### Confirmed POI hotel row (data plane)

Hotel POIs returned by POI Services (e.g. **`GET /pois/nearby?...&poi_type=hotel`**) and the **`hotel`** layer on **`POST /corridor/query`** carry the same shard-backed fields Travel-Routing already models in `PoiServicesPoi`:

| Field | Meaning |
|-------|--------|
| **`nearby_dcfc_id`** | Integer FK to the nearest DCFC in the shard’s pairing logic; **`0` means no DCFC within the configured proximity** (same as “no pair” for sleep meta). |
| **`nearby_dcfc_distance_yd`** | Straight-line distance (yards) to that DCFC; **`0`** when there is no paired DCFC. |
| **`onsite_charger_level`**, **`onsite_charger_power_kw`**, **`onsite_charger_ports`**, **`onsite_charger_network`** | Onsite EV amenity at the hotel (e.g. L2/DCFC); may be empty when none. |

Example: a hotel with `nearby_dcfc_id: 1943` and `nearby_dcfc_distance_yd: 358` has a shard-attested nearby DCFC; another with **`nearby_dcfc_id: 0`** and **`nearby_dcfc_distance_yd: 0`** should **not** be treated as having a POI “pair” for overnight charger meta (unless product explicitly falls back to live NREL search).

## Planner behavior

1. **`fetchCorridorChargersForLeg`** requests `charger`, `hotel`, optional `edges` and `pairs` when env allows.
2. When **`POI_SERVICES_BASE_URL`** is set and **`USE_POI_SERVICES_CORRIDOR`** is not `false`, corridor **chargers** come from POI; **default** is **fail-closed** if the POI call fails or returns no DCFC (**`POI_SERVICES_FALLBACK_TO_NREL=false`** by default). Set **`POI_SERVICES_FALLBACK_TO_NREL=true`** only for dev/legacy.
3. Overnight hotel discovery uses **POI corridor hotels** (not Overpass) when that leg used POI for the corridor.
4. **`sleepChargerMeta`**: **Primary:** use **`nearby_dcfc_id`** / **`nearby_dcfc_distance_yd`** on the **same `hotel` row** already in the corridor response. Resolve the DCFC via the corridor **`charger`** list by **integer `id`** (then map to canonical charger id). **If `nearby_dcfc_id` is `0` (or non-positive), skip POI-attested pairing** — assume no close DCFC per POI; optionally use **`pairs`** layer only as secondary enrich, and **`findChargersNearPoint`** only if the product keeps a weaker live fallback. **Onsite** fields are for future UX (e.g. “L2 at hotel”) and are separate from **`nearby_dcfc_*`**.

**Corridor coverage gap** — `nearby_dcfc_id` may point at a DCFC outside the corridor `charger` bbox/radius; join fails → planner uses live NREL and writes `sleep_dcfc_corridor_miss` review line. POI can use logs on periodic updates; run **`node scripts/poi-review-log-summary.mjs`** to aggregate events and `resolvedVia` outcomes.

## Errors (user-visible)

Stable **`errorCode`** values include:

- **`POI_SERVICES_CORRIDOR_FAILED`** — HTTP/network/timeout or non-OK from POI.
- **`POI_SERVICES_NO_CHARGERS`** — POI returned no corridor chargers while POI was the configured source (no silent NREL fallback).

Clients should show **`message`** to the user.

## Env flags (see `.env.example` and `TESTING.md`)

- **`POI_SERVICES_BASE_URL`**, **`USE_POI_SERVICES_CORRIDOR`**, **`POI_SERVICES_USE_EDGES`**, **`POI_SERVICES_USE_PAIRS`**, **`POI_SERVICES_FALLBACK_TO_NREL`**, **`OVERNIGHT_HOTEL_RADIUS_METERS`**, **`POI_REVIEW_LOG`** (optional NDJSON for join/coverage QA — see **`TESTING.md`**).

## Locks

**`lockedHotelId`** may be **`poi_services:hotel:<numeric>`** when corridor hotels are POI-sourced (same id universe as **`candidates.hotels`**).
