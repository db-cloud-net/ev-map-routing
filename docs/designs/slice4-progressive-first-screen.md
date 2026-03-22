# Slice 4 — progressive ~60s first screen (design)

**Status:** **Partially implemented** — **Phase 1** `POST /route-preview` + smoke; **Phase 2** map preview (teal line, merged multi-waypoint); **Phase 3** **shipped (MVP):** honest Plan button states; §5 **second horizon** (`preview.nextHorizon`); **Phase 4 (§4 MVP):** **`/map`** progressive refinement **checklist** + **refinement anchors** line from planner stops. **Still open:** server-side multi-round refinement loops + waypoint reorder. Normative product text remains **[ROUTING_UX_SPEC.md](../ROUTING_UX_SPEC.md)** §3–§5.  
**Normative product decisions** stay in **ROUTING_UX_SPEC**; this doc is **proposed** API + client shape until reviewed.

**Depends on:** **[Slice 3](./slice3-get-candidates.md)** (`POST /candidates` + optional map prefetch) — **shipped**.  
**Related:** **[MAP_AND_NAV.md](../MAP_AND_NAV.md)** (today’s map line is straight between **stops**, not full road geometry).

---

## 1. Problem

**Spec target ([ROUTING_UX_SPEC.md](../ROUTING_UX_SPEC.md) §3):** Within **~60s** of **Plan Trip**, the user should see:

1. **Approximate full-trip route** on the map (whole-journey context; may be coarse).
2. **Detailed** road geometry + **turn-by-turn** for an **initial horizon** defined by **time-on-route** (e.g. first **~8–12 minutes** or first **N** maneuvers, with guardrails — spec §3).
3. **No “stranded” state** ([§5](../ROUTING_UX_SPEC.md)): the **next** actionable segment after the horizon must be **in flight or ready**, not unknown.

**Today:**

- **`POST /plan`** returns the full least-time itinerary (charging + overnight) in one shot; latency often **exceeds** 60s on long or cold paths.
- Map route line is often **straight chords between stops** when `leg.geometry` is absent (**[MAP_AND_NAV.md](../MAP_AND_NAV.md)**).
- Sidebar “turn-by-turn” is **stop-to-stop** narrative, not Valhalla **maneuvers**.

So we need a **progressive pipeline**: a **fast path** for context + first horizon, then **refinements** (spec §4) without violating §5.

---

## 2. Guiding constraints (from spec)

| Topic | Constraint |
|--------|----------------|
| **60s budget** | If not met, **relax** coarser line, shorter horizon, tighter reorder bounds — **before** dropping progressive UX (spec §3). |
| **Reorder** | Waypoint order may change; phase-1 may ship **non-final** order — UI must **invalidate or relabel** when order changes (spec §4). |
| **Honest states** | e.g. Planning → Approximate route → Refining → Up to date (spec §7). |
| **Mirror / fail closed** | Provider reads follow **[ROUTING_UX_SPEC.md](../ROUTING_UX_SPEC.md) §2 when that policy is active. |

---

## 3. Proposed architecture (high level)

Three **logical** stages (may map to one or multiple HTTP calls):

| Stage | Purpose | Suggested content |
|-------|---------|-------------------|
| **A — Context** | Whole-trip **map context** quickly | Valhalla **road** route for **start → end** (and intermediate **waypoints** if fixed order for v1) **without** running the EV least-time/charging solver — *or* a dedicated “preview” polyline with documented coarseness. |
| **B — First horizon** | **Maneuvers + detailed geometry** for first **Δt** minutes or first **N** maneuvers | Slice Valhalla `directions` / maneuvers along the **same** baseline route (or trace), clipped to horizon rules in §3. |
| **C — Full plan** | Charging, sleep, reorder, locks | Existing **`POST /plan`** (possibly **time-boxed** reorder internally later). May **replace** or **refine** stage A line when final stops are known. |

**Parallelism:** Stage **A** can run **alongside** **`POST /candidates`** (already used for pins) — all three may be in flight after one user click.

**Safety (§5):** Before advertising “ready to drive first segment,” ensure **horizon B+1** is **queued or loaded** (prefetch next chunk, or block copy — product choice).

---

## 4. API surface options (open)

Pick one primary pattern in implementation; alternatives stay in ADRs.

| Option | Pros | Cons |
|--------|------|------|
| **4a — New endpoint** e.g. `POST /route-preview` or `POST /progressive/start` | Clear separation from full planner; easier caching / timeouts | Another contract to version (`responseVersion`) |
| **4b — Flags on `POST /plan`** e.g. `planPhase: "fast" \| "full"` or `returnPartial: true` | One URL | Risk of conflating validation, locks, and partial bodies |
| **4c — SSE or long-poll** for refinements | Natural for §4 loop | More moving parts (infra, reconnect) |

**Recommendation for spike:** **4a** — a read-only **preview** endpoint that accepts the **same trip shape** as **`POST /plan`** (minus locks, or with locks ignored in v1) and returns:

- `previewPolyline` (or encoded polyline + precision note),
- `horizon: { maneuvers, geometry?, cumulativeTimeMinutes }`,
- `refinementHint` / `requestId` to correlate with a later **`POST /plan`**,
- explicit **`status: "ok" | "error"`** and **`errorCode`** consistent with **[V2_API.md](../V2_API.md)** style.

Exact JSON belongs in **V2_API** once the spike is accepted.

---

## 5. Valhalla usage (sketch)

Today Valhalla is used for **corridor polylines** and **leg timings**; it does **not** generally return **per-leg geometry to the client** for the full itinerary (**[MAP_AND_NAV.md](../MAP_AND_NAV.md)**).

For Slice 4:

1. **Preview route** — likely **`/route`** (or equivalent) for **A → B** [→ waypoints …] with **directions** enabled where needed for horizon clipping.
2. **Horizon clip** — server-side: walk maneuvers until cumulative **time** (Valhalla-predicted) exceeds **Δt**, subject to **min maneuver count** / distance guardrails (spec §3).
3. **Full plan** — unchanged least-time solver; may **replace** preview line when `stops` are final (show “route updated” per spec §7).

**Cost:** Extra Valhalla calls vs today; must stay within **60s** end-to-end including geocode + network — tune timeouts (`PLAN_*`, Valhalla client) per environment.

---

## 6. Web (map + sidebar)

- **Map:** Render **preview polyline** first; optionally **crossfade** to **`POST /plan`** geometry when legs include `geometry`.
- **Itinerary / TBT panel:** First show **horizon maneuvers** from preview; append or swap as refinements arrive; never empty “next turn” without loading state (§5).
- **Copy:** Plain-language “**Approximate**” vs “**Refined**” per **[ROUTING_UX_SPEC.md](../ROUTING_UX_SPEC.md) §7.

---

## 7. Open questions (before coding)

1. **Waypoint order:** Does stage **A** assume **user order** only, or allow a **fast reorder** heuristic? (Spec §4: reorder must be time-boxed for phase-1.)
2. **Multi-leg preview:** Single Valhalla **multi-stop** route vs per-leg concat — trade latency vs fidelity.
3. **Relation to locks:** Ignore locks on preview in v1, or reject preview when locks are set?
4. **Id correlation:** How does `requestId` / `refinementHint` tie **`/route-preview`** to **`POST /plan`** for logging and UX?
5. **CI:** New smoke: preview returns polyline + maneuvers within **S** seconds on a short corridor (flaky-env tolerant like other E2Es).

---

## 8. Rollout phases (proposal)

| Phase | Deliverable |
|-------|-------------|
| **0** | This doc + pointer in **V2_API.md** / **README** (done when merged). |
| **1** | **Done (API)** — **`POST /route-preview`** (`api/src/planner/routePreview.ts`, **`v2-1-route-preview`**) + horizon clip + **`scripts/e2e-route-preview-smoke.mjs`** in **`npm run qa:smoke`**. **No map UI yet.** |
| **2** | **Done** — Map (`web/src/app/map/page.tsx`): **`POST /route-preview`** in parallel with **`/plan`** (single segment); teal dashed line + horizon TBT panel; cleared on successful plan. Env: **`NEXT_PUBLIC_PREFETCH_ROUTE_PREVIEW`**. |
| **3** | **Done (MVP)** — API: **`preview.nextHorizon`** (second clip from same Valhalla response). Web: merged second horizons, §5 “next segment” banner, “Refining…” line, Road directions + preview show first + next lists. **Not done:** §4 multi-round refinement loop (charge/sleep anchors). |
| **4** | **§4 MVP (web):** staged **Progressive refinement** checklist + **refinement anchors** line after a successful plan (honest copy: waypoint order fixed to user input; no automated reorder). **Not done:** iterative server-side refinement loops + reorder UX. *(Multi-waypoint preview merge already shipped.)* |

---

## 9. References

- [ROUTING_UX_SPEC.md](../ROUTING_UX_SPEC.md) — §3–§7 (normative)
- [MAP_AND_NAV.md](../MAP_AND_NAV.md) — current line + TBT limitations
- [V2_API.md](../V2_API.md) — `POST /plan`, `POST /candidates`
- [slice3-get-candidates.md](./slice3-get-candidates.md) — candidates prefetch
