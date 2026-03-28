# ADR — Range-leg planning + incremental trust

**Canonical decision record** for this theme. **`TODOS.md`** (*Current — in review*) links here; do not duplicate the table below in other docs.

**Related intent & terminology:** [`range-based-segments-intent.md`](./range-based-segments-intent.md) · **ROUTING_UX** timing / liveness: [`ROUTING_UX_SPEC.md`](../ROUTING_UX_SPEC.md) §3 / §6.5–6.6 · **Manual QA:** [`TESTING.md`](../../TESTING.md) §5.5.

**Status (rolling):** **Pillar 1 — v1** (slices A–F below) is **shipped and paused** — observability, linear SOC tooling, and SOC carry; the **range-window optimizer** remains **backlog**. **Pillar 2 — incremental trust** transport (**poll**, **NDJSON `/stream`**, **SSE `/events`**, heartbeats, client reconnect) is **shipped** with a **stable stream shape**. **Pillar 3 — web consumer** §3a–c is **shipped**, plus **§4 companion UI** in **[§ Slice 4](#slice-4--progressive-refinement-loops)** (segment-hop copy + waypoint-order banner). **Active engineering focus:** remaining **ROUTING_UX §4** items not yet shipped (see Slice 4 **Open** table) · optional map **`rangeLegs`** road geometry (**`NEXT_PUBLIC_MAP_DEBUG_RANGE_LEGS`**). **Pick up Pillar 1 again** from **[§ Pillar 1 v1 handoff](#pillar-1-v1-handoff-paused)** (below).

---

## Slice 1 (shipped) — `planJob` + poll

- **`POST /plan`** accepts **`planJob: true`** → **`202`** + **`jobId`**; **`GET /plan/jobs/:jobId`** returns **`checkpoints`** (solver attempts) and final **`result`**. Contract: **`docs/V2_API.md`** · E2E: **`scripts/e2e-plan-job.mjs`**.

## Slice 2 (shipped) — web poll + live Debug

- Map page: set **`NEXT_PUBLIC_PLAN_USE_JOB=true`** (see **`docs/WEB_SWITCHES.md`**) to poll job checkpoints and show **Debug (MVP) — live** until the job completes; final **`debug.*`** still comes from **`result`**. Blocking **`POST /plan`** remains the default when unset.
- **`partial_route`** job checkpoints (**`attempt.partialSnapshot`**: **`stops`**, **`legs`**, **`rangeLegs`**) let the client **grow** partial itinerary state while **`status === running`**. **Map:** optional **`NEXT_PUBLIC_MAP_DEBUG_RANGE_LEGS`** may use **`rangeLegs`** for a polyline split + sidebar — not standard product UI.

## Slice 2b (shipped) — user-visible partial itinerary (map MVP)

- When **`NEXT_PUBLIC_PLAN_USE_JOB=true`**, the map page treats checkpoint snapshots (**`debug.planJobPartialRoute`**) as **in progress**: refinement stage **3** stays **active** (not ✓) until the job completes; the **Plan Trip** button and status line reflect **stop count**; a **green** callout explains that the route is **real server data**, not theater (see **ROUTING_UX_SPEC** §6.6).

## Slice 3 (shipped) — presentation `rangeLegs`

- Successful **`POST /plan`** responses may include **`rangeLegs`** (mirrored under **`debug.rangeLegs`**): itinerary grouped at **charge** stops — **API / presentation layer only**; same least-time solver. See **`docs/designs/range-based-segments-intent.md`** · **`docs/V2_API.md`**. **Standard map** uses a single blue route line; optional **`NEXT_PUBLIC_MAP_DEBUG_RANGE_LEGS`** enables the split + debug sidebar (**`docs/WEB_SWITCHES.md`**). A future **Pillar 1** optimizer that emits **true range-window** legs is **backlog** (see [§ Pillar 1 v1 handoff](#pillar-1-v1-handoff-paused)); ship order for that heavy change remains **after** Pillar 2–3 transport/UX.

## Pillar 1 — slice A (shipped) — `rangeLegs` metrics

- **`PLAN_RANGE_LEG_METRICS`** (default **on**; set **`false`** to omit): each **`rangeLegs[]`** row may include **`maxHopChordMilesApprox`**, **`usableRangeMiles`**, **`maxHopExceedsRangeBudget`** — largest straight-line sub-hop inside the chunk vs **`EV_RANGE_MILES * (1 − CHARGE_BUFFER_SOC)`**. Same least-time plan; this is **observability + sanity** before a solver that optimizes explicit range windows. **`debug.rangeLegMetrics`** summarizes constants when present.

## Pillar 1 — slice B (shipped) — SOC replay

- **`PLAN_SOC_REPLAY`** (default **on**; set **`false`** to omit **`debug.socReplay`**): forward linear SOC trace along the itinerary (maneuver road miles when present, else chord), using the same hop rules as **`leastTimeSegment`** (to **end**: `d/range`; to any other stop: `d/range + buffer`). Charge/sleep stops assume charging up to the SOC needed for the next leg (capped at 1). See **`api/src/planner/socReplay.ts`**.

## Pillar 1 — slice C (shipped) — soft preference in `leastTimeSegment`

- **`PLAN_RANGE_LEG_CHARGE_STOP_PENALTY_MINUTES`** (default **`0`** = off): adds a fixed **minutes** penalty to the Dijkstra cost each time the itinerary **leaves a charger after charging** (toward another charger or the segment end). Biases the solver toward **fewer** intermediate charge stops when total time is similar; **does not** hard-cap per-leg distance. Leg **`chargeTimeMinutes`** and **`totals`** remain **real** modeled charge time (penalty affects path choice only). When **`> 0`**, **`debug.rangeLegOptimizer`** includes **`{ mode: "soft_penalty_charge_stop", chargeStopPenaltyMinutes }`**. Applies per **`planLeastTimeSegment`** call (overnight outer loop and locked chains may run multiple segment solves).
- **Non-goals (Pillar 1 v1):** no guaranteed global optimum across multi-day merges; no hard max miles per range leg. **Partial-SOC** behavior is addressed by **slices E–F** (carry across segment boundaries); a **range-window optimizer** is still **out of scope** until [§ Pillar 1 v1 handoff](#pillar-1-v1-handoff-paused).

## Pillar 1 — slice D (shipped) — harder linear SOC feasibility (margin)

- **`PLAN_RANGE_LEG_FEASIBILITY_MARGIN_FRAC`** (default **`0`** = off): requires **slack** against the solver’s **linear** distance budgets on **every** hop: multiply **`EV_RANGE_MILES`**-based caps by **`(1 − margin)`**. Concretely: charger–charger max hop becomes **`rangeMiles × (1 − CHARGE_BUFFER_SOC) × (1 − margin)`**; start→charger, start→end, and charger→end hops use **`rangeMiles × (1 − margin)`** for the distance feasibility check. **Does not** change the charging-time model on the returned legs (still uses the same linear fractions for **`chargeTimeMinutes`**); margin only **prunes** Dijkstra transitions that would sit too close to a nominal “100% pack used” bound. When **`> 0`**, **`debug.rangeLegFeasibility`** includes **`{ mode: "margin_frac", marginFrac, feasibilityScale }`** (`feasibilityScale = 1 − marginFrac`). Large margins can eliminate feasible paths—raise **`EV_RANGE_MILES`**, lower **`CHARGE_BUFFER_SOC`**, or reduce **`margin`** if plans fail.

## Pillar 1 — slice E (shipped) — SOC carry for chained locked segments

- **`PLAN_SOC_CARRY_CHAINED_SEGMENTS`** (default **`true`**): for **`lockedChargersByLeg`** chained **`planLeastTimeSegment`** solves, the **next** segment’s **`initialDepartSocFraction`** is derived from a **linear replay** of the **previous** segment (same rules as **`socReplay`**): departure SOC leaving the lock stop toward the **next** lock or **end** is **`min(1, max(socArrive, needNextHop))`**. The segment solver’s **`initialDepartSocFraction`** (default **1**) tightens start-side distance feasibility and first-hop arrival SOC instead of assuming a full pack whenever the prior segment only “charged to minimum.” Set to **`false`** to restore the legacy assumption (full pack at each chain boundary). **`debug.socCarryChainedSegments`** on successful locked plans lists **`{ chainIndex, initialDepartSocFraction }`** per segment after the first. **`segmentSocCarryDebug`** may appear on per-segment artifacts when fraction **< 1**.

## Pillar 1 — slice F (shipped) — SOC carry for overnight / remainder in `planTripOneLeg`

- **`PLAN_SOC_CARRY_OVERNIGHT_SEGMENTS`** (default **`true`**): for **`planTripOneLeg`**’s **overnight outer loop** (iterations after the first) and the **remainder** segment solve to **`end`**, **`initialDepartSocFraction`** is derived by **linear replay** of **`overallStops` / `overallLegs`** built so far toward **`finalEnd.coords`** with **`"end"`** as the next hop target (same helper as slice E: **`departSocFractionAfterSegmentForNextHop`**). Set to **`false`** to restore the legacy assumption (full pack at each overnight iteration boundary and at the remainder solve). When active, **`debug.socCarryOvernightSegments`** lists **`{ kind: "overnight_iteration" \| "remainder", overnightIndex?, initialDepartSocFraction }`** entries for applied carries. Other **fallback** segment solves in the same file (e.g. anchor fallback) may remain on the default full-pack assumption until explicitly extended.

---

## Pillar 1 v1 handoff (paused)

**Pillar 1 v1** = everything in **slices A–F** above: **metrics**, **SOC replay**, **soft penalty**, **feasibility margin**, **SOC carry** (locked chains + overnight/remainder). Same **least-time** core; **`rangeLegs`** remains **presentation** grouping.

| Topic | Where to continue |
|--------|-------------------|
| **Range-window optimizer** | New design: objective (min stops vs min time vs explicit miles cap), interaction with **`leastTimeSegment`** / Dijkstra, tests. **`PLAN_RANGE_LEG_METRICS`** + **`debug.socReplay`** are the baseline observability. |
| **SOC carry gaps** | **`api/src/planner/planTripOneLeg.ts`**: anchor / other **fallback** segment solves still default to **full pack** unless extended like slice F. |
| **Deeper multi-day** | Global coupling across days (not per-segment replay only) — separate from linear carry. |
| **Key modules** | **`api/src/planner/leastTimeSegment.ts`**, **`socReplay.ts`**, **`planTripOneLeg.ts`**, **`planTripOneLegLocked.ts`**, **`rangeLegs.ts`** |
| **Env / debug index** | **`PLAN_RANGE_LEG_METRICS`**, **`PLAN_SOC_REPLAY`**, **`PLAN_RANGE_LEG_CHARGE_STOP_PENALTY_MINUTES`**, **`PLAN_RANGE_LEG_FEASIBILITY_MARGIN_FRAC`**, **`PLAN_SOC_CARRY_CHAINED_SEGMENTS`**, **`PLAN_SOC_CARRY_OVERNIGHT_SEGMENTS`** → matching **`debug.*`** in **`docs/V2_API.md`** · **`TESTING.md`** |

**Suggested first task when reopening Pillar 1:** spike **range-window** semantics on paper (or a branch), then decide whether to extend **`leastTimeSegment`** or add a layered optimizer.

---

## Pillar 2 incremental trust (transport shipped)

**Goal:** clients get **trustworthy partial state** (checkpoints) **without** blocking on the full plan JSON — **push** via **SSE** / **NDJSON**, with **poll** fallback.

| State | What |
|-------|------|
| **Shipped** | **`POST /plan`** with **`planJob: true`** → **`202`** includes **`pollUrl`**, **`streamUrl`**, **`eventsUrl`**. **`GET /plan/jobs/:jobId`** — **`checkpoints`**, **`result`**. **`GET /plan/jobs/:jobId/stream`** — **`application/x-ndjson`** (one JSON per line). **`GET /plan/jobs/:jobId/events`** — **`text/event-stream`**; **`data:`** lines carry the **same** JSON objects as NDJSON (**`retry:`** first), **`EventSource`**-friendly, plus periodic **`type: "heartbeat"`** (**`PLAN_JOB_SSE_HEARTBEAT_MS`**, default **25s**). **Replay** + **push** until terminal (same TTL as poll). **`partial_route`** checkpoints include **`partialSnapshot`** (**`stops`**, **`legs`**, **`rangeLegs`**). Web: **`NEXT_PUBLIC_PLAN_USE_JOB`**, **`/events`** with **reconnect backoff** on errors, live Debug, partial itinerary UX (**Slice 1 / 2 / 2b** above). |
| **Next (backlog)** | Optional **resume** semantics beyond replay-on-reconnect · finer **`segmentsAttempted`** in payloads if needed. Details: **`TODOS.md`**. |
| **Ties to Pillar 3** | Pillar 2 defines **what** arrives incrementally; Pillar 3 updates the **map and primary UI** to consume it as a **first-class** experience (not only Debug / stagger). |

---

## Pillar 3 — Web consumer (active focus)

**Goal:** treat **plan-job checkpoints** as the main source of progressive truth: users see **liveness** and **partial itinerary + geometry** in product surfaces, not only in **Debug — plan-job checkpoints**.

**Status:** **§3a–c shipped** (see table below). **§4-aligned map copy** (segment-hop refinements + waypoint-order banner) is **shipped** — see **[§ Slice 4](#slice-4--progressive-refinement-loops)**. Normative product text for refinements remains **ROUTING_UX_SPEC** §4.

| Slice | Intent |
|-------|--------|
| **3a — Primary progress** | Surface **checkpoint liveness** in the **Progressive refinement** strip and **partial itinerary** callout (e.g. **checkpoint count** from SSE/poll) while **`planJob`** runs — not only under Debug. When checkpoints include **`segment_prefix`** refinements, the strip also shows **segment-hop refinement** count (see Slice 4). |
| **3b — Map geometry** | **Shipped:** When **`planJob`** partial snapshots accumulate **≥20** LineString coordinates across **`legs`**, the map **prefers that solid line** over merged **`/route-preview`** and **hides the dashed preview** to avoid double lines; otherwise unchanged (preview + chord fallbacks). See **`countLegLineStringCoordinates`** / **`PARTIAL_PLAN_ROAD_GEOMETRY_MIN_COORDS`** in **`web/src/app/map/page.tsx`**. |
| **3c — Debug consolidation** | **Shipped:** **`liveCheckpoints`** prop (was **`liveFromJobPoll`**) — live rows from plan-job **checkpoints** show immediately; **blocking** `POST /plan` keeps **staggered readout** of **`debug.segmentsAttempted`**. Copy distinguishes **checkpoint** stream vs **staggered** finished response; section title **Debug — plan-job checkpoints**. |

**Non-goals for v1:** replacing the entire Debug panel; new API fields (Pillar 2 shape stays fixed unless a separate ADR).

---

## Slice 4 — Progressive refinement loops

**Goal:** Match **[`ROUTING_UX_SPEC.md`](../ROUTING_UX_SPEC.md)** §4 — **loop** refinement toward **next charge** or **next sleep**, then repeat until **destination**, with **user-visible** in-progress state.

**Shipped (MVP):** **[`slice4-progressive-first-screen.md`](./slice4-progressive-first-screen.md)** Phase **4** — map **Progressive refinement** checklist + **refinement anchors** line after a successful plan; **`planJob`** partial itinerary UX (Slice 2b) feeds **liveness** while the solver runs.

**Shipped (§4 v1 — segment hop checkpoints):** When **`planJob: true`**, **`planLeastTimeSegment`** emits **`partial_route`** checkpoints after each **timed hop** (start→first anchor→…→end), **`reason`** **`segment_refine_hop_<n>`**, `attempt.refinement` **`{ kind: "segment_prefix", hopIndex, totalHopsInSegment, overnightIndex? | segment: "remainder" | lockedChainIndex? }`**. Merge uses **`mergeSegmentPrefixIntoTripSnapshot`** (`api/src/planner/refinementPrefixMerge.ts`). Env **`PLAN_SEGMENT_PREFIX_REFINEMENT_CHECKPOINTS`** (default **`true`**) — set **`false`** to disable. **Last hop** is omitted (full snapshot still follows via existing **`emitPartialRouteSnapshot`**).

**Shipped (§4 v1 — web surfacing):** Map **Progressive refinement** stage **3** subline includes **“N segment-hop refinements”** when **`planJob`** is loading and the checkpoint stream contains **`partial_route`** attempts with **`attempt.refinement.kind === "segment_prefix"`** (client counts matching rows). Generic **checkpoint count** behavior unchanged.

**Shipped (§4 v1 — waypoint order proxy):** **`POST /plan`** accepts **`optimizeWaypointOrder`** (request + **`shared/types`**). **`api/src/planner/waypointOrder.ts`** picks an order that **minimizes sum of haversine leg miles** (user order, reverse, nearest-neighbor, full permutations for small **N**, random samples for large **N**) within **`PLAN_WAYPOINT_REORDER_BUDGET_MS`** (see **`.env.example`**). Runs only for **multi-waypoint** trips with **no** **`replanFrom`**, **no** charger/hotel locks. Successful responses may include **`debug.waypointOrderOptimization`** (`applied`, `chosenOrder`, scores, timing). Web: checkbox **Optimize waypoint order** (default **`NEXT_PUBLIC_OPTIMIZE_WAYPOINT_ORDER`** in **`docs/WEB_SWITCHES.md`**); when **`applied`**, a callout shows **user vs chosen** stop order. Contract: **`docs/V2_API.md`**. **Note:** proxy is **not** EV time-optimal; spec §4 “invalidate or relabel when order changes” is partially met via the callout — deeper UX if the solver’s notion of order diverges further is **backlog**.

**Open (later):**

| Workstream | Notes |
|------------|--------|
| **Waypoint reorder — deeper UX** | If future solvers change order beyond this haversine proxy, extend **invalidation / relabel** per **ROUTING_UX_SPEC** §4. |
| **Transport** | **Pillar 2** delivers checkpoints; further **correlated** refinement APIs — see **`slice4-progressive-first-screen.md`** Phase 4 **not done** rows. |
| **Map `rangeLegs` geometry** | Optional product visualization of range-leg polylines — **`NEXT_PUBLIC_MAP_DEBUG_RANGE_LEGS`** / Slice 3; not the same as segment-hop copy above. |

**Canonical design notes:** **`slice4-progressive-first-screen.md`** (phases, Valhalla usage, open questions) · **ROUTING_UX_SPEC** §3–§5 (first screen, refinements, don’t strand the driver).

---

## Product scope (three pillars) — summary

1. **Planner shape (Pillar 1)** — v1 **paused**; **optimizer** backlog — [§ Pillar 1 v1 handoff](#pillar-1-v1-handoff-paused).
2. **Incremental trust (Pillar 2)** — transport **shipped** — [§ Pillar 2](#pillar-2-incremental-trust-transport-shipped).
3. **Web (Pillar 3)** — §3a–c **shipped** — [§ Pillar 3](#pillar-3--web-consumer-active-focus).
4. **Progressive refinements (§4)** — segment-hop checkpoints + map **segment_prefix** copy + **waypoint-order proxy** **shipped**; remaining §4 / **`slice4-progressive-first-screen`** rows **open** — [§ Slice 4](#slice-4--progressive-refinement-loops).

---

## Ship order (reference)

| Order | Pillar | Rationale |
|-------|--------|-----------|
| **First** | **2 — Incremental trust** | Checkpoints reuse existing solver emission points (e.g. **`segmentsAttempted`**); de-risks API + client before changing the optimizer. **Team focus (rolling): execute here.** |
| **Second** | **3 — Web** | Consumer for streamed/polled events; replace stagger-only Debug; map line from checkpoint geometry when available. |
| **Third** | **1 — Planner shape (heavy)** | **Range-window** / true range-leg **optimizer** — ships after **2–3**; **Pillar 1 v1** slices shipped earlier as **presentation + linear SOC** without changing the core optimization problem. |

---

## Debug / observability

Weight **`debug.*`** (and Debug panel surfacing) **while the relevant pillar is in flux**; Pillar 1 v1 envs are **stable**; **Pillar 2** stream shape is **fixed**; **Pillar 3** + **§4** surfaces include **`debug.waypointOrderOptimization`** (when **`optimizeWaypointOrder`** is used) alongside checkpoint streams.

---

## Deferred (not blocking this track)

**Local mirror / NAS / §2 mirror-ops** — “Mirror” = **charger/hotel data snapshots**, not UI/debug mirroring: [`ROUTING_UX_SPEC.md`](../ROUTING_UX_SPEC.md) §2 · [`local-mirror-architecture.md`](../local-mirror-architecture.md). Resume ops via [`LOCAL_MIRROR_CHECKPOINT.md`](../LOCAL_MIRROR_CHECKPOINT.md).
