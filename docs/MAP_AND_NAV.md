# Map line and turn-by-turn — current behavior vs navigation apps

> **Planner corridor source:** With **`POI_SERVICES_BASE_URL`** set, **POI Services** supplies corridor DC-fast chargers and hotels for `/plan`. Travel-Routing does **not** use live NREL for that path.

This doc sets expectations: the MVP is an **EV feasibility + stop-sequence planner**, not a **turn-by-turn navigation** product.

**Web env toggles** (`NEXT_PUBLIC_*`, build-time): **[`WEB_SWITCHES.md`](./WEB_SWITCHES.md)**.

## What you see today

### Blue route on the map
- The API builds **`ItineraryLeg`** rows in **`leastTimeSegment.ts`** with **times** (`travelTimeMinutes`, optional `chargeTimeMinutes`) only — **no `geometry`** on each leg.
- **`web/src/app/map/page.tsx`** draws the line by:
  1. Concatenating **`leg.geometry`** if present (usually **empty** for solver output), else
  2. **Fallback:** straight **LineString** between **stops in order** (start → chargers → sleep → end).

So the line is **chords on the map**, not the road network. That matches what you see on Raleigh → St Louis: it will **not** follow highways.

### Slice 4 — `POST /route-preview` on `/map`
- For **normal** trips (start + optional waypoints + end, replan off), the web fetches **`POST /route-preview`** once per **hop** (`Valhalla` polyline + horizon per call) and **merges** polylines for the map. The API contract remains single-leg only; the client chains segments.
- For **true** single-hop trips, that is one call (same as before).
- **`POST /plan`** and **`POST /route-preview`** run **in parallel**; the UI **does not** wait for preview before applying the plan (so chargers/stops appear as soon as the planner returns). **If** `/plan` wins the race, the map **skips** drawing a straight chord line until preview arrives or fails (avoids a flash of wrong geometry while keeping the fast first paint).
- With **waypoints**, the client **merges** each segment’s **horizon** maneuvers (with segment headings) so turn-by-turn **updates** to cover **every** hop, not only the first segment.
- When the **`/plan`** response has **no** `leg.geometry` (usual), the map **reuses** that preview **LineString** for the **solid** route line instead of straight chords between stops, so the road shape **persists** after planning completes.
- **`rangeLegs`** on **`POST /plan`** is still returned for API consumers and future use. **Standard map UI** draws **one solid blue** merged road line. **Optional debug** (`NEXT_PUBLIC_MAP_DEBUG_RANGE_LEGS=true`, see **`WEB_SWITCHES.md`**): split that polyline at itinerary stops for validation (`web/src/lib/rangeLegRouteFeatures.ts`) and show a **Range legs (debug)** sidebar — **not** part of the standard product.
- **Progressive UI:** Default **blocking** `POST /plan` returns the full itinerary, route line, and Debug **when the request completes** (long runs can take many minutes). **`planJob` + poll** (`NEXT_PUBLIC_PLAN_USE_JOB`) surfaces **solver-attempt checkpoints** in Debug while running and applies **`partial_route`** checkpoints (**`stops` / `legs` / `rangeLegs`**) so **partial** map state can update while planning; the **final** body still arrives once in **`result`**. Range-leg **map** visualization remains debug-only.
- The sidebar keeps **“Road directions (Valhalla)”** (horizon maneuvers) **below** the itinerary; **“Segment-by-segment (planner)”** remains the stop-to-hop **model** estimate.

### “Segment-by-segment (planner)” in the sidebar
- It is **not** Valhalla driving instructions. It is a **generated list** of moves between **itinerary stops** (“Drive: charger A → charger B”), using leg times when available.
- There are **no step-by-step road maneuvers** (exits, street names) in the **`/plan`** response for those legs — use **Road directions (Valhalla)** when the map fetched **`POST /route-preview`** for the same trip.

## Where Valhalla *is* used
- **Corridor polyline** for charger/POI corridor sampling (`getRoutePolyline` along start→end when it succeeds) — POI Services or legacy NREL/mirror use that polyline to place corridor queries. Valhalla may return the route **`shape` as an encoded polyline string** (especially on long legs); the server must decode it the same way as route-preview. If decoding failed historically, the corridor fell back to **straight-line** sample points — candidate chargers then clustered along the chord instead of the highway (while the map blue line still followed roads from `/route-preview`).
- **Leg timing** inside the solver (`getTravelTimeMinutes` / distance) so drive times are **road-based**, not haversine — but that does **not** export full polyline per hop to the client.

### POI Select mode

The map has two top-level modes toggled by **EV Route** / **POI Select** buttons:

- **EV Route** (default): shows the planned itinerary — charge stop pins, hotel/sleep pins, route polyline, sidebar itinerary. The `poiMode` state is `"off"`.
- **POI Select**: hides the EV itinerary overlays. Shows the route polyline and corridor POI candidates as map pins. Filter controls appear in the sidebar.

**Mode switching:**
- Switching to EV Route (POI Select → EV Route): the POI candidate list and selections are **preserved**. Switching back shows the same results.
- Switching between POI types (e.g. Chargers → Hotels): candidates and selections are **cleared** (stale type cannot silently appear under a new filter).
- Switching to EV Route does **not** clear selections — selected POIs remain available as waypoints when planning.

**Map pin colors in POI Select mode:**

| Color | Meaning |
|-------|---------|
| Teal `#39a6a1` | Charger — not within 400 yd of a hotel in the result set |
| Light orange `#f6ad55` | Hotel — not within 400 yd of a charger |
| Dark red `#c53030` | Either type — paired (hotel+charger within 400 yards of each other) |
| Same color + black ring | Any — selected by user |

The 400-yard pairing threshold matches the EV-route candidate view (`hasNearbyCharger`).

**Sidebar list:** Selected POIs sort to the top. Checkboxes and map pin clicks both toggle selection.

**Selected POIs as waypoints:** When the user clicks **Plan Trip** from EV Route mode with POI selections active, selected charger POIs are injected as ordered `waypoints` in the plan request. Hotels go via `lockedHotelId`. Traditional charger/hotel locks from EV Route mode are excluded when POI selections are present.

### Optional: POI Services v2 (`POST /corridor/query`)
When **`POI_SERVICES_BASE_URL`** is set (sibling **POI Services** repo), the API loads **corridor chargers**, **hotels**, optional **`pairs`** (hotel↔DCFC for sleep meta), and optional **precomputed `edges`** from POI Services — the **runtime** source for that leg (see **[`docs/designs/data-plane-vs-application-plane-adr.md`](./designs/data-plane-vs-application-plane-adr.md)**, **[`docs/designs/poi-corridor-sleep-stops.md`](./designs/poi-corridor-sleep-stops.md)**, and **[`docs/designs/poi-route-overlay.md`](./designs/poi-route-overlay.md)**). Travel-Routing still runs **`planLeastTimeSegment`** here; POI does not choose the itinerary. **`debug.providerCalls.poi_services`** records HTTP time. **`POI_SERVICES_FALLBACK_TO_NREL`** defaults off (fail-closed); set `true` only for dev/legacy. On Synology Docker with **`prod-network`**, point the planner at **`http://poi:8010`** when the POI container is named **`poi`** (see **[`d1-runbook.md`](./d1-runbook.md)**).

## What it would take to “look like a real route”
1. **Backend:** After the final stop order is known, **enrich each leg** with Valhalla **`/route`** (e.g. `getRouteLegGeometryAndManeuvers`) for each consecutive pair of stops, attach **`geometry`** (and optionally **`maneuvers`**) to each **`ItineraryLeg`**.
2. **Cost / latency:** One Valhalla call per segment × number of segments (could be 10+ on long trips) — budget timeouts and consider merging polylines for the map.
3. **Web:** Already renders **`leg.geometry`** when present; it would start showing road shapes once the API fills them.

## Product wording
Until enrichment ships, consider UI copy such as **“Approximate path (straight segments between stops)”** so users aren’t expecting Garmin-style routing.

## Timeouts vs “hung”
- The map uses **client** and **API** **maximum** durations so a tab or server request cannot run forever (see [ROUTING_UX_SPEC §6.5](./ROUTING_UX_SPEC.md)). That is a **safety net**, not a promise that every trip finishes inside it.
- While **Plan Trip** is running, **liveness** is communicated by an **elapsed-time** clock, the **progressive refinement** checklist, and **partial** results (**teal** road line and **candidate** pins from parallel fetches that may complete before `POST /plan`).

---

See also: **[HANDOFF_2026-03-21.md](./HANDOFF_2026-03-21.md)** (Valhalla URL), **[VALHALLA.md](./VALHALLA.md)**.
