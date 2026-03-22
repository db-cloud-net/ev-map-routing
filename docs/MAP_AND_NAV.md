# Map line and turn-by-turn — current behavior vs navigation apps

This doc sets expectations: the MVP is an **EV feasibility + stop-sequence planner**, not a **turn-by-turn navigation** product.

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
- When the **`/plan`** response has **no** `leg.geometry` (usual), the map **reuses** that preview **LineString** for the **blue** route line instead of straight chords between stops, so the road shape **persists** after planning completes.
- The sidebar keeps **“Road directions (Valhalla)”** (horizon maneuvers) **below** the itinerary; **“Segment-by-segment (planner)”** remains the stop-to-hop **model** estimate.

### “Segment-by-segment (planner)” in the sidebar
- It is **not** Valhalla driving instructions. It is a **generated list** of moves between **itinerary stops** (“Drive: charger A → charger B”), using leg times when available.
- There are **no step-by-step road maneuvers** (exits, street names) in the **`/plan`** response for those legs — use **Road directions (Valhalla)** when the map fetched **`POST /route-preview`** for the same trip.

## Where Valhalla *is* used
- **Corridor sampling** for NREL charger discovery (`getRoutePolyline` along start→end when it succeeds). Valhalla may return the route **`shape` as an encoded polyline string** (especially on long legs); the server must decode it the same way as route-preview. If decoding failed historically, the corridor fell back to **straight-line** sample points — candidate chargers then clustered along the chord instead of the highway (while the map blue line still followed roads from `/route-preview`).
- **Leg timing** inside the solver (`getTravelTimeMinutes` / distance) so drive times are **road-based**, not haversine — but that does **not** export full polyline per hop to the client.

## What it would take to “look like a real route”
1. **Backend:** After the final stop order is known, **enrich each leg** with Valhalla **`/route`** (e.g. `getRouteLegGeometryAndManeuvers`) for each consecutive pair of stops, attach **`geometry`** (and optionally **`maneuvers`**) to each **`ItineraryLeg`**.
2. **Cost / latency:** One Valhalla call per segment × number of segments (could be 10+ on long trips) — budget timeouts and consider merging polylines for the map.
3. **Web:** Already renders **`leg.geometry`** when present; it would start showing road shapes once the API fills them.

## Product wording
Until enrichment ships, consider UI copy such as **“Approximate path (straight segments between stops)”** so users aren’t expecting Garmin-style routing.

---

See also: **[HANDOFF_2026-03-21.md](./HANDOFF_2026-03-21.md)** (Valhalla URL), **[VALHALLA.md](./VALHALLA.md)**.
