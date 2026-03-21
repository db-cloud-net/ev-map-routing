# Map line and turn-by-turn — current behavior vs navigation apps

This doc sets expectations: the MVP is an **EV feasibility + stop-sequence planner**, not a **turn-by-turn navigation** product.

## What you see today

### Blue route on the map
- The API builds **`ItineraryLeg`** rows in **`leastTimeSegment.ts`** with **times** (`travelTimeMinutes`, optional `chargeTimeMinutes`) only — **no `geometry`** on each leg.
- **`web/src/app/map/page.tsx`** draws the line by:
  1. Concatenating **`leg.geometry`** if present (usually **empty** for solver output), else
  2. **Fallback:** straight **LineString** between **stops in order** (start → chargers → sleep → end).

So the line is **chords on the map**, not the road network. That matches what you see on Raleigh → St Louis: it will **not** follow highways.

### “Turn-by-turn (MVP)” in the sidebar
- It is **not** Valhalla driving instructions. It is a **generated list** of moves between **itinerary stops** (“Drive: charger A → charger B”), using leg times when available.
- There are **no step-by-step road maneuvers** (exits, street names) in the API response for those legs.

## Where Valhalla *is* used
- **Corridor sampling** for NREL charger discovery (`getRoutePolyline` along start→end when it succeeds).
- **Leg timing** inside the solver (`getTravelTimeMinutes` / distance) so drive times are **road-based**, not haversine — but that does **not** export full polyline per hop to the client.

## What it would take to “look like a real route”
1. **Backend:** After the final stop order is known, **enrich each leg** with Valhalla **`/route`** (e.g. `getRouteLegGeometryAndManeuvers`) for each consecutive pair of stops, attach **`geometry`** (and optionally **`maneuvers`**) to each **`ItineraryLeg`**.
2. **Cost / latency:** One Valhalla call per segment × number of segments (could be 10+ on long trips) — budget timeouts and consider merging polylines for the map.
3. **Web:** Already renders **`leg.geometry`** when present; it would start showing road shapes once the API fills them.

## Product wording
Until enrichment ships, consider UI copy such as **“Approximate path (straight segments between stops)”** so users aren’t expecting Garmin-style routing.

---

See also: **[HANDOFF_2026-03-21.md](./HANDOFF_2026-03-21.md)** (Valhalla URL), **[VALHALLA.md](./VALHALLA.md)**.
