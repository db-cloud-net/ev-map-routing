# Range-based segments (product intent vs current MVP)

**Status:** Product intent vs MVP — **decisions & ship order:** **[`range-leg-incremental-trust-adr.md`](./range-leg-incremental-trust-adr.md)** · **index:** **[`TODOS.md`](../../TODOS.md)** (*Current — in review*). Shipped code still uses least-time + corridor pool until those milestones land. **This doc** defines **terminology** (**range leg** vs **waypoint leg** vs **solver attempt**). **Presentation `rangeLegs`** on successful **`POST /plan`** derives charge-boundary groupings from the current itinerary (see **`docs/V2_API.md`**); a **true** range-sized optimizer remains **pillar 1** in the ADR.

---

## Terminology (use these names)

| Term | Meaning |
|------|--------|
| **Range leg** | Product target: a driving chunk sized around **one vehicle charge** (effective range), then charge; next **range leg** starts at that charger. **API:** `rangeLegs[]` on **`POST /plan`** is a **presentation** grouping at charge boundaries (same least-time plan). **Not yet:** a **solver** that optimizes explicit range-sized windows along the road (ADR pillar 1). |
| **Waypoint leg** | Geographic hop when the user adds waypoints: **Start→WP1**, **WP1→End**, etc. Each is a separate `planTripOneLegFromCoords` call. |
| **Solver attempt** | One row in **`debug.segmentsAttempted`**: a **least-time segment** solve and/or **overnight-loop** iteration (corridor pool → `planLeastTimeSegment`). Shown in **Debug (MVP)** as **Solver attempts (debug)** with staggered reveal after `/plan` returns. |
| **Route-preview hop** | Valhalla **`/route-preview`** call between consecutive addresses (merged for multi-hop). Unrelated to EV range legs. |

Avoid overloading **“segment”** without context; prefer **range leg**, **waypoint leg**, or **solver attempt**.

---

## What you mean by “segment” (target UX)

1. **Slice the trip** into **driving chunks** that are **on the order of one vehicle charge** — e.g. slightly **longer than** (or up to) **effective EV range** (`EV_RANGE_MILES` + policy), along the **road** route (not arbitrary geography).
2. **Pick a charge stop** at the end of that chunk (or within reach of the chunk boundary).
3. **That charger becomes the start** of the **next** segment.
4. **Repeat** until destination.
5. **Progressive UI:** **Show each** “range segment” **as it is calculated** (stream, poll, or multi-phase API) — not only after the full `POST /plan` completes.

This is a **rolling origin** model: **segment boundaries = range economics + chosen charger**, not **user waypoints** and not **overnight time** alone.

---

## What the code does today (MVP)

| Topic | Current behavior |
|--------|------------------|
| **“Segment” in the solver** | One **`planLeastTimeSegment`** call from **`currentStart` → `finalEnd`** with a **pool** of corridor chargers (capped). It finds a **minimum total-time** path through chargers (Dijkstra-style), **not** fixed “range-sized” slices. |
| **Range** | `EV_RANGE_MILES` + **`CHARGE_BUFFER_SOC`** define **feasibility** of edges (can you drive this hop without violating SOC?), **not** “cut the trip every N miles.” |
| **Splitting long days** | **`OVERNIGHT_THRESHOLD_MINUTES`** (time on the segment) can force **sleep** insertion — **time-based**, not range-length segments. |
| **Waypoints** | **Geographic** stops only: **multi-leg** = independent plans **Start→WP1**, **WP1→End**, etc. **Not** “range segments.” |
| **Progressive display** | **No** streaming of per-segment results; the client gets **one** `POST /plan` body when the server finishes (see **ROUTING_UX_SPEC** §6.5, **TESTING.md**). |

So when we added **“Planner segment attempts”** in Debug, **`segmentsAttempted`** refers to **internal solver / overnight loop attempts** on that architecture — **not** “vehicle max range segments” in your sense.

---

## Gap to close (engineering directions)

To match your intent, we’d need something like:

1. **Planner:** Either **reformulate** the optimizer to **explicitly** build range-sized windows along the route, **or** add a **second** presentation layer that **groups** the chosen stops into “range legs” for display.
2. **API:** **Chunked** or **streaming** responses (SSE / NDJSON / `planPhase` + poll) so each range segment can be **returned and shown** before the full trip is solved.
3. **UI:** Map + sidebar that **append** each segment as it arrives.

Until then, **docs and Debug** use **solver attempt** (not “planner segment”) for `segmentsAttempted` rows.

---

## Related

- **[`../ROUTING_UX_SPEC.md`](../ROUTING_UX_SPEC.md)** — progressive first screen, §3 horizon, §6.5 liveness.
- **[`slice4-progressive-first-screen.md`](./slice4-progressive-first-screen.md)** — staged refinements (road → pins → full plan).
- **`api/src/planner/leastTimeSegment.ts`**, **`planTripOneLeg.ts`** — current math.
