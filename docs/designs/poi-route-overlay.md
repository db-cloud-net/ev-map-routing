# POI Route Overlay — Feature Plan

**Version:** 1.0
**Status:** Planned
**Date:** 2026-03-28

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

Visible only in POI Select mode. Positioned above the map or in a collapsible sidebar.

```
┌─────────────────────────────────────┐
│  POI Type:  [All ▼]                 │
│             ○ All                   │
│             ○ Accommodation         │
│             ○ Charger               │
│                                     │
│  Distance from route: [──●──] 10 mi │
│                       1    50       │
│                                     │
│  Network:   [Any ▼]   (chargers     │
│                        only)        │
└─────────────────────────────────────┘
```

- **POI Type**: filter by `poi_type`. "Accommodation" maps to `hotel` internally.
- **Distance from route**: radius slider, 1-50 miles. Controls the corridor
  query `corridor_radius_mi`. Default 10.
- **Network**: optional filter for charger networks (Tesla, Electrify America,
  ChargePoint, EVgo, etc.). **Only applies when POI Type is "Charger" or "All."**
  When POI Type is "Accommodation", the Network dropdown is disabled/hidden —
  hotel brand filtering is a separate future feature (see roadmap §9.3). When
  POI Type is "All", the Network filter narrows only the charger results;
  accommodations pass through unfiltered.

Changing any filter triggers a new POI corridor query. Debounce slider at 300ms.

### 3.3 POI Pins on Map

- Unselected: small circle, colored by type (blue=charger, green=accommodation)
- Selected: larger circle with checkmark, highlighted color
- Tapping an unselected pin opens the info tag
- Tapping a selected pin deselects it (removes from stop list)

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

### 4.1 New Endpoint: `POST /corridor/pois`

Returns filterable POIs along an existing route corridor. This is a thin proxy
to the POI Service's `/corridor/query` with response mapping.

```typescript
POST /corridor/pois
{
  "shape": [...],              // route polyline (from initial plan)
  "corridor_radius_mi": 10,   // user-adjustable
  "poi_type": "accommodation", // or "charger", "all"
  "network": "Tesla",          // optional; chargers only (ignored for accommodation)
  "limit": 500                 // optional cap
}

Response:
{
  "status": "ok",
  "pois": [
    {
      "id": "poi_services:hotel:16247",
      "poi_type": "accommodation",    // mapped from "hotel"
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
    },
    ...
  ]
}
```

The `poi_type` mapping:
- Client sends `"accommodation"` → API queries POI Service with `poi_type: "hotel"`
- API response maps `"hotel"` → `"accommodation"` in the output

**Limit enforcement:**
The `limit` parameter is enforced **server-side** by the POI Service during
shard scan (SQLite `LIMIT` clause). The ev-map-routing API passes it through
without modification. Default is 500; max recommended is 2000 (above that,
map rendering slows noticeably on the client).

When `poi_type: "all"` is requested with a limit, the server splits the limit
across types proportionally to availability rather than applying it globally
to the combined result. For example, `limit: 500` with 3,000 candidate chargers
and 500 candidate accommodations in the corridor returns up to 430 chargers
and up to 70 accommodations (weighted by counts). This prevents one dense type
from starving the other.

**Deduplication:**
The POI Service deduplicates **within a single corridor query** by POI `id`
(SQLite `DISTINCT`). Each POI appears at most once in a response, even if the
shape crosses shard boundaries where the POI could be matched by multiple
corridor segments.

**Across queries** (e.g., user adjusts the radius slider, triggering a new
fetch), the client is responsible for handling transitions:
- The client **replaces** the previous POI list with the new response entirely
  (not merge-dedup). This keeps state simple and ensures removed filters
  cause POIs to disappear.
- Selected stops (in the sidebar) persist across filter changes — they are
  tracked separately from the filtered POI list and remain visible as selected
  pins even if the current filter would exclude them. An info badge can mark
them as "outside current filter" for clarity.

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
