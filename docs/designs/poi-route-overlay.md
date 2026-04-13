# POI Route Overlay — Implementation Reference

**Version:** 2.0
**Status:** Shipped (2026-04-12)
**Date:** 2026-03-28 (plan) / 2026-04-12 (implemented)

---

## 1. Summary

Add a second interaction mode to the trip map. Users toggle between **EV Route** (existing
charge + overnight itinerary) and **POI Select** (browse and select points of interest
along the route corridor). Selected POIs become waypoints; the user explicitly triggers
a replan to integrate them into the EV route.

---

## 2. User Flow

```
┌─────────────────────────────────────────────────────┐
│  User plans trip: Raleigh → Seattle                 │
│  → EV Route renders (charge stops, overnights)      │
│                                                     │
│  User taps [POI Select] toggle                      │
│  → Charge pins, overnight pins, stop labels HIDE    │
│  → Blue driving line STAYS                          │
│  → POI filter controls APPEAR                       │
│  → POI pins appear along corridor                   │
│                                                     │
│  User sets filters:                                 │
│    Type: accommodation / charger / all              │
│    Radius: slider 1-50mi from route (default 10)    │
│                                                     │
│  User taps a POI pin                                │
│    → Info tag appears on map:                        │
│      Name, address, type, key attributes            │
│      Distance from route                            │
│      [Add as Stop] button                           │
│                                                     │
│  User taps [Add as Stop]                            │
│    → POI pin changes style (selected)               │
│    → POI appears in stop list (sidebar)             │
│    → Travel time from previous stop shown           │
│    → Running total travel time shown                │
│    → [Reset Total] button available                 │
│    → Route does NOT replan yet                      │
│                                                     │
│  User adds more POI stops as desired                │
│                                                     │
│  User taps [Recalculate Route]                      │
│    → Selected POIs become waypoints                 │
│    → Full EV replan runs                            │
│    → Mode switches back to EV Route                 │
│    → Updated itinerary shows with POI waypoints     │
│      integrated into charge + overnight plan        │
│                                                     │
│  User can toggle back to POI Select to add more     │
│    → Previously selected POIs persist across modes  │
└─────────────────────────────────────────────────────┘
```

---

## 3. UI Specification

### 3.1 Mode Toggle

A two-state button in the map controls area:

```
┌──────────────┬──────────────┐
│   EV Route   │  POI Select  │
│   (active)   │              │
└──────────────┴──────────────┘
```

- **EV Route** (default): shows charge stops, overnight hotels, itinerary legs,
  ETAs, range indicators — everything the planner currently renders.
- **POI Select**: hides all EV itinerary overlays. Shows only the blue driving
  polyline and POI pins from the corridor query.

Toggling preserves state in both directions. POI selections persist when switching
to EV Route and back. The route polyline is the same in both modes.

### 3.2 POI Filter Controls

Visible only in POI Select mode. Rendered as a collapsible fieldset in the left sidebar.

```
┌─────────────────────────────────────────┐
│  POI Select Filters                     │
│  Filter corridor POIs and select to     │
│  lock into your route.                  │
│                                         │
│  ○ All POIs   ○ Chargers   ○ Hotels     │
│                                         │
│  Network filter (charger mode only):    │
│  [e.g. Tesla, ChargePoint          ]    │
│                                         │
│  Corridor radius (mi) │ Per segment     │
│  [   25              ] │ [  50       ]  │
│                                         │
│  [ Fetch corridor POIs ]                │
└─────────────────────────────────────────┘
```

- **POI Type**: radio group — All POIs / Chargers / Hotels. "Hotels" maps to `accommodation` internally, which the API translates to `poi_type: "hotel"` for the POI Service.
- **Corridor radius (mi)**: corridor half-width for queries. Default **25 mi**. Text input (not a slider).
- **Per segment**: POI result limit **per 150-mile route section**. Default **50**. Applied directly to each sectioned query (see §4.1 sectioning). Total POIs fetched = sections × per-segment value, minus duplicates.
- **Network filter**: optional text input, charger mode only. Narrows results to a specific charging network (Tesla, ChargePoint, etc.). Hidden when POI Type is Hotels.

Fetch is user-triggered — the **Fetch corridor POIs** button. No auto-fetch on filter change.

### 3.3 POI Pins on Map

Pins are 18px circles rendered via `maplibregl.Marker` with a custom `HTMLDivElement`.

**Color scheme:**

| Condition | Color | Notes |
|-----------|-------|-------|
| Charger — not paired | Teal `#39a6a1` | Standard DCFC marker |
| Hotel — not paired | Light orange `#f6ad55` | No nearby charger |
| Charger **or** hotel — paired | Dark red `#c53030` | Within 400 yd of each other (same algorithm as EV-route view) |
| Any — selected | Same base color + black border ring | `border: 2px solid #111` |

**Pairing algorithm:** a hotel and a charger are "paired" when `haversineMiles(hotel, charger) ≤ 400/1760` (~0.227 miles, 400 yards). Computed client-side across all POIs in the current result set. When `poi_type` is "all", both hotels and chargers in the results are checked against each other. When only one type is in the results, no pairing occurs (nothing to compare).

**Selection behavior:**
- Clicking an unselected pin selects it (highlights + border)
- Clicking a selected pin deselects it
- Selected POIs move to the **top of the sidebar list** immediately
- No info popup / tap target beyond the click toggle (info tag from the design spec is not yet implemented)

### 3.4 Info Tag (on pin tap)

```
┌──────────────────────────────────┐
│  Holiday Inn Express Mason City  │
│  4th St SW, Mason City, IA      │
│  Type: Accommodation             │
│  Onsite EV: L2 / 7.7kW          │
│  Nearby DCFC: 285 yd             │
│  Distance from route: 0.3 mi     │
│                                  │
│  Stop time: [  20  ] min         │
│             (default 20)         │
│                                  │
│  [ Add as Stop ]                 │
└──────────────────────────────────┘
```

For chargers:
```
┌──────────────────────────────────┐
│  Electrify America Raleigh       │
│  6204 Glenwood Ave, Raleigh, NC  │
│  Type: Charger                   │
│  Network: Electrify America      │
│  Power: 350 kW                   │
│  Ports: 6 (CCS)                  │
│  Distance from route: 1.2 mi     │
│                                  │
│  Stop time: [  20  ] min         │
│             (default 20)         │
│                                  │
│  [ Add as Stop ]                 │
└──────────────────────────────────┘
```

The stop time is user-editable before tapping "Add as Stop". Default is
`POI_DEFAULT_STOP_MINUTES` (20). The stop time is included in the running
total calculation: each POI contributes `travelFromPrev + stopTime` to the total.

**Suggested defaults by POI type** (future refinement):
| Type | Default minutes | Rationale |
|------|----------------|-----------|
| `accommodation` | 480 | 8-hour overnight |
| `charger` | 20 | Fast charge to 80% |
| `restaurant` | 45 | Meal |
| `rest_stop` | 10 | Bathroom / stretch |
| Other | 20 | Generic stop |

For v1, all POIs default to 20 minutes. User edits on the info tag before adding.

### 3.5 Selected Stop List (sidebar)

Shows POI stops in route order with travel time estimates:

```
┌─────────────────────────────────────┐
│  POI Stops                          │
│                                     │
│  1. Holiday Inn Express Knoxville   │
│     Accommodation · 0.5 mi detour   │
│     Travel from start: 4h 12m       │
│     Stop time: 480 min (overnight)  │
│                                     │
│  2. Cracker Barrel Lebanon          │
│     Restaurant · 1.2 mi detour      │
│     Travel from #1: 2h 45m          │
│     Stop time: 45 min               │
│     Running total: 7h 42m           │
│                                     │
│  3. Tesla Supercharger Rapid City   │
│     Charger · 0.1 mi detour         │
│     Travel from #2: 5h 30m          │
│     Stop time: 20 min               │
│     Running total: 13h 32m          │
│                                     │
│  [Reset Total]  [Recalculate Route] │
└─────────────────────────────────────┘
```

- **Travel time**: estimated driving time between consecutive selected stops,
  computed via Valhalla `/route` between stop coordinates.
- **Stop time**: user-set duration at this POI (default 20 min, editable on the
  info tag before adding). Included in running total.
- **Running total**: cumulative time (travel + stop time) from the first selected
  stop. Each row's total = previous total + travel from prev + this stop's time.
- **Reset Total**: zeros the running total from the next stop onward. Earlier stops
  keep their original cumulative totals while the next stop begins a fresh total.
- **Selected stops state**: selected POIs remain in the sidebar and stay highlighted
  on the map even if the current corridor filter changes or the user toggles modes.
- **Recalculate Route**: takes all selected POIs, converts them to waypoints in
  route order, and triggers a full `POST /plan` with those waypoints.

### 3.6 Recalculate Behavior

When the user taps **Recalculate Route**:

1. Collect selected POI coordinates in route-progress order
2. Build waypoints array: `[poi1_coords, poi2_coords, ...]`
3. Call `POST /plan` with:
   - Same start/end as original trip
   - `waypoints`: selected POI coordinates (geocoded or raw lat/lon)
   - `includeCandidates: true`
4. Disable POI Select mode while the request is in flight. If the request fails,
   preserve selected POIs, remain in POI Select mode, and show an error state so
   the user can retry without losing progress.
5. On success: switch to EV Route mode, render the new itinerary
6. The POI stops appear as `waypoint` type stops in the itinerary,
   with EV charge stops inserted around them as needed

---

## 4. API Changes (ev-map-routing)

### 4.1 Endpoint: `POST /corridor/pois`

Returns filterable POIs along an existing route corridor. Implemented in `api/src/server.ts`. Thin proxy to the POI Service's `POST /corridor/query` with shape sampling, type mapping, and `distance_from_route_mi` enrichment.

**Request (per-section — see client sectioning below):**
```typescript
POST /corridor/pois
{
  "shape": [...],              // sampled route polyline for this section
  "corridor_radius_mi": 25,   // user-adjustable; default 25
  "poi_type": "accommodation", // or "charger", "all"
  "network": "Tesla",          // optional; chargers only
  "limit": 50                  // per-section cap (not a global total)
}
```

**Response:**
```typescript
{
  "status": "ok",
  "pois": [
    {
      "id": "poi_services:hotel:16247",
      "poi_type": "accommodation",    // mapped from POI Service "hotel"
      "name": "Holiday Inn Express Mason City",
      "lat": 43.147,
      "lon": -93.246,
      "address": "4th St SW",
      "city": "Mason City",
      "state": "IA",
      "network": "IHG",
      "distance_from_route_mi": 0.3,
      "attributes": {
        "onsite_charger_level": "L2",
        "onsite_charger_power_kw": 7.7,
        "nearby_dcfc_distance_yd": 285,
        "rooms": 120
      }
    }
  ]
}
```

**Type mapping:** client `"accommodation"` → POI Service `"hotel"` on request; `"hotel"` → `"accommodation"` on response. `"charger"` and `"all"` pass through unchanged.

**Schema limits:** `shape` max 5,000 points; `corridor_radius_mi` max 500.

**Client-side sectioning (why multiple requests per fetch):**

The POI Service fills `limit` from POIs nearest to the **start** of the shape, so a single long-route query returns everything near the origin and nothing near the destination. The web client solves this by:

1. **Distance-based shape sampling** — one point per mile (minimum 1-mile spacing) for uniform geographic coverage. Valhalla polylines cluster densely in cities; raw points would bias queries toward urban start points.

2. **150-mile section splits** — the sampled shape is divided into ~150-mile sections. Each section is queried in **parallel** with the per-segment limit.

3. **Client-side deduplication** — results from all sections are merged by POI `id`. A POI that falls within two adjacent sections (near a split boundary) appears once.

```
Route: Raleigh → Seattle (~2,800 mi)
  → ~19 sections × 50 POIs each → up to 950 candidates, distributed across the full route
```

The **Per segment** UI control sets the `limit` sent to each section query. Default: **50**. Total POIs returned ≤ sections × per-segment (minus duplicates at section boundaries).

**Fetch lifecycle:** clicking **Fetch corridor POIs** replaces the entire current candidate list. Selected POIs (in `poiSelection` state) are preserved through re-fetches so selections are not lost if the user re-fetches with a different radius. Switching between POI types (e.g. Chargers → Hotels) clears candidates and selections. Toggling to EV Route mode and back preserves the candidate list and selections.

**POI ID format:**
All POI IDs are stable strings of the form `poi_services:<type>:<numeric_id>`
where `<type>` is the raw internal type (`hotel`, `charger`, etc., not the
user-facing `accommodation`). IDs are stable across pipeline rebuilds as long
the source data doesn't change — the pipeline uses a deterministic hash
of `source + source_id` when available, falling back to spatial hashing.

### 4.2 Travel Time Estimates

The stop list needs travel times between selected POIs. Two options:

**Option A (recommended): Client-side Valhalla call.** The web UI calls Valhalla
directly for each consecutive pair of selected stops. This keeps the API stateless
and avoids a new endpoint. The web app already has the Valhalla URL.

```typescript
// In web UI, when user adds a stop:
const prevStop = selectedStops[selectedStops.length - 1];
const newStop = { lat, lon };
const route = await fetch(`${VALHALLA_URL}/route`, {
  method: "POST",
  body: JSON.stringify({
    locations: [
      { lat: prevStop.lat, lon: prevStop.lon },
      { lat: newStop.lat, lon: newStop.lon }
    ],
    costing: "auto"
  })
});
const travelMinutes = route.trip.summary.time / 60;
```

**Option B: Haversine estimate.** Instant, no network call. Less accurate but
good enough for the stop list display. Refine with Valhalla when user taps
"Recalculate Route".

```typescript
const haversineMi = haversine(prevStop, newStop);
const estimateMinutes = (haversineMi / 60) * 60; // assume 60 mph
```

Recommendation: stay with Option A unless we find the latency or client-side
Valhalla call experience unacceptable to users. If we do need faster feedback,
Option B can be a fallback, but preserve direct Valhalla travel times as the
preferred implementation.

### 4.3 Replan with POI Waypoints

The existing `POST /plan` already supports `waypoints`. When the user taps
"Recalculate Route":

```typescript
POST /plan
{
  "start": "Raleigh, NC",
  "end": "Seattle, WA",
  "waypoints": [
    "43.147,-93.246",   // Mason City Holiday Inn (selected POI)
    "44.08,-103.23"     // Rapid City Supercharger (selected POI)
  ],
  "includeCandidates": true
}
```

The planner treats these as hard waypoints, inserts charge stops around them,
and produces the full EV itinerary with the POI stops integrated.

Note: if the backend requires structured waypoint objects instead of raw strings,
convert coordinates before sending. The current plan assumes the `POST /plan`
contract accepts `lat,lon` waypoint strings; validate the exact implementation
format before wiring the UI.

---

## 5. POI Service Changes

### 5.1 Accommodation Alias (API-level only)

The POI Service API maps `"accommodation"` to `"hotel"` on input and `"hotel"`
to `"accommodation"` on output. No pipeline or shard changes.

In `src/api/server.ts` and `src/api/corridorEngine.ts`:

```typescript
// Input mapping
function normalizePoiType(input: string): string {
  if (input === "accommodation") return "hotel";
  return input;
}

// Output mapping
function displayPoiType(stored: string): string {
  if (stored === "hotel") return "accommodation";
  return stored;
}
```

Apply `normalizePoiType` to incoming query parameters and corridor layer names.
Apply `displayPoiType` to outgoing POI objects in responses.

The corridor layer `"accommodation"` becomes a valid alias for `"hotel"`:

```bash
# Both work:
curl -X POST .../corridor/query -d '{"layers": ["accommodation", "charger"]}'
curl -X POST .../corridor/query -d '{"layers": ["hotel", "charger"]}'

# Response always says "accommodation" in poi_type field
```
