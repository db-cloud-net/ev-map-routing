# Slice 3 — dedicated candidates endpoint (design spike)

**Status:** **Implemented** — `POST /candidates` on the API; see **[../V2_API.md](../V2_API.md)** § Slice 3.  
**Normative contract:** **[../V2_API.md](../V2_API.md)** (Slice 3 section).  
**Product context:** **[PRD.md](../../PRD.md)** § Version 2 · Slice 3; **[ROUTING_UX_SPEC.md](../ROUTING_UX_SPEC.md)** §3 (~60s first screen) and progressive delivery.

---

## 1. Problem

Today, **charger + hotel candidates** for map layers are returned **only** inside a successful **`POST /plan`** response when `includeCandidates: true` ([V2_API.md](../V2_API.md)). The planner must run (Valhalla polyline, corridor sampling, least-time segment solve, …) before the client can show **candidate pins**.

For **progressive UX** (rough route + map context early, refinements later), we want the option to **fetch the same candidate universe** the planner uses **without** completing a full plan — or **in parallel** with planning — so the UI can paint pins while `/plan` is still working.

**Constraints:**

- Candidate **ids** must stay in the **same universe** as `POST /plan` + locks (`lockedChargersByLeg` / `lockedHotelId`) so users cannot pick unknown ids.
- **Mirror / fail-closed** policy ([ROUTING_UX_SPEC.md](../ROUTING_UX_SPEC.md) §2) applies to provider reads used for candidates; no silent fallback where the spec says fail closed.

---

## 2. Proposed surface (API)

**Recommendation:** **`POST /candidates`** (not `GET`) for parity with **`POST /plan`**: same JSON body shape for `start` / `end` / `waypoints` / **Slice 2** `replanFrom` + `previousStops`, without lock fields. Long waypoint lists and structured bodies are awkward in query strings.

| Aspect | Proposal |
|--------|----------|
| **Method / path** | `POST /candidates` |
| **Body** | Subset of `PlanTripRequest`: `end` (required), `start` **or** `replanFrom`, optional `waypoints`, optional `previousStops` when using `replanFrom.stopId`. **Omit** `lockedChargersByLeg`, `lockedHotelId`, and **`includeCandidates`** (always implied true for this route). |
| **Response** | `{ requestId, responseVersion, status: "ok" \| "error", message?, errorCode?, candidates? }` where `candidates` matches **`PlanTripCandidates`** (single combined surface for multi-leg — same aggregation rules as `/plan`, or **per-leg** array — **open**: see §5). |
| **Errors** | Reuse validation and planner guard semantics where applicable: geocode failures, `UNKNOWN_REPLAN_STOP`, `MISSING_PREVIOUS_STOPS`, mirror/provider failures with clear messages. |

**Optional later:** `GET /candidates?start=…&end=…` for simple A→B only (cache-friendly); add only if we need CDN caching and accept URL-length limits.

---

## 3. Server behavior (implementation sketch)

1. **Geocode / replan resolve** — Same entry path as `planTrip` (reuse shared helpers: geocode strings, `replanFrom` + `previousStops` resolution).
2. **Corridor geometry** — Valhalla route polyline per leg (or shared polyline builder used today).
3. **NREL + Overpass sampling** — Same corridor charger + optional hotel preview logic as **`planTripOneLeg`** candidate construction (**not** the full least-time overnight / charge graph).
4. **Return** `candidates` (and **no** `stops` / `legs` / `totals`), or `status: "error"` with `errorCode` where applicable.

**Performance:** Still **Valhalla + NREL (+ Overpass if hotels)** — not “free.” The win is **skipping** the expensive **energy / least-time / overnight** solver when we only need pins.

**Refactor:** Extract a **`fetchCorridorCandidates(...)`** (name TBD) from **`planTripOneLeg.ts`** so `/plan` and **`POST /candidates`** share one code path for **id-stable** `CandidateCharger` / `CandidateHotel` lists.

---

## 4. Client (map) usage (future)

- Call **`POST /candidates`** when the user has committed **start/end/waypoints** (or replan inputs) but **before** or **alongside** **`POST /plan`**.
- Keep **lock** interactions tied to ids returned here or from a prior **`POST /plan`** with `includeCandidates: true`.
- Show loading / error states consistent with **[ROUTING_UX_SPEC.md](../ROUTING_UX_SPEC.md)** §3–§5.

---

## 5. Open questions

1. **Per-leg vs merged `candidates`:** `/plan` merges chargers/hotels across legs in **`planTrip`**; **`POST /candidates`** should document whether it returns **one** `PlanTripCandidates` (merged + `legIndex` meaning) or **`candidatesByLeg[]`** for clarity in multi-waypoint trips.
2. **Caching:** Short TTL cache keyed by normalized `(start,end,waypoints)` hash? **Only** if privacy + product approve; default **none** in v1 of the endpoint.
3. **Rate limiting / abuse:** Same expectations as **`POST /plan`**; document in ops runbook when exposed publicly ([V2_CHERRY_PICKS.md](../V2_CHERRY_PICKS.md) public API row).
4. **CI:** Add a smoke script **`e2e-candidates-smoke.mjs`** (spawn API, `POST /candidates`, assert `status` + non-empty or explicit empty) once implemented; wire into **`qa:smoke`** when stable.

---

## 6. Rollout

| Phase | Deliverable |
|-------|-------------|
| **0** | This doc + **V2_API.md** / **PRD** pointers (**spike complete**). |
| **1** | **Done** — shared **`fetchCorridorChargersForLeg`** in **`api/src/planner/corridorCandidates.ts`** (used by **`planTripOneLeg`** and **`planTripCandidatesOnly`**). |
| **2** | **Done** — **`POST /candidates`** + Zod + **`e2e-candidates-smoke.mjs`** in **`qa:smoke`**. |
| **3** | **Done** — Map page (`web/src/app/map/page.tsx`) fires **`POST /candidates`** in parallel with **`POST /plan`** when **`NEXT_PUBLIC_PREFETCH_CANDIDATES`** is not `false`. |

---

## 7. References

- [V2_API.md](../V2_API.md) — baseline `includeCandidates` on **`POST /plan`**
- [ROUTING_UX_SPEC.md](../ROUTING_UX_SPEC.md) — ~60s first screen, progressive refinements
- [V2_CHERRY_PICKS.md](../V2_CHERRY_PICKS.md) — gates for unrelated v2 extras
