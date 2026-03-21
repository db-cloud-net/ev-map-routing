# Routing UX & objectives (frozen spec)

This document captures **product and UX decisions** for EV trip planning with **Valhalla** (roads), **local mirror** data for chargers and hotels (NREL + Overpass shaped), and **progressive** delivery of directions. It does **not** prescribe implementation tickets here.

**Related:** [VALHALLA.md](./VALHALLA.md) (base URL / port), [MAP_AND_NAV.md](./MAP_AND_NAV.md) (current MVP limitations), [local-mirror-architecture.md](./local-mirror-architecture.md) (mirror design).

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
| **NREL (chargers)** | Prefer **local mirror** (US dataset), not live API per request for normal operation. |
| **Overpass (hotels / POIs)** | Same: **local mirror**, US scope for snapshot pulls. |
| **Refresh cadence** | **Monthly** **or** **user-initiated** update/download. |
| **Fallback** | **Fail closed** — if mirror is missing, corrupt, or unusable for the request, return a **clear, actionable error** (no silent switch to remote NREL/Overpass for `/plan` under this policy). |
| **Trust** | Surface **data freshness** (e.g. mirror snapshot date) where it helps user confidence. |

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

## 7. UX principles (confidence & ease of use)

- **Honest states:** e.g. `Planning` → `Approximate route` → `Refining…` → `Up to date` / per-leg status.
- **Plain-language limits:** one line on what “approximate” vs “detailed” means on the map.
- **Assumptions visible:** range, travel-day rule, charging model — short “Assumptions” surface.
- **Actionable failures:** title → **why** (mirror, empty corridor, timeout) → **what to do** (refresh data, narrow trip, retry).
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
