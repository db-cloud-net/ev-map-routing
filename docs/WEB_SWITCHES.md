# Web build-time switches (`NEXT_PUBLIC_*`)

**Canonical reference** for the **map** app (`web/src/app/map/page.tsx`). Next.js **inlines** these at **build** time — restart **`npm -w web run dev`** or rebuild after editing **`web/.env.local`**.

**API alignment:** API planning uses per-segment timeout (**`PLAN_SEGMENT_TIMEOUT_MS`**) with no global wall-clock cap for `/plan`. In `planJob` mode, the web timeout is idle-based and resets on new checkpoints — see **[`TESTING.md`](../TESTING.md)**.

**Related:** **[`V2_API.md`](./V2_API.md)** (`planJob`) · **[`range-leg-incremental-trust-adr.md`](./designs/range-leg-incremental-trust-adr.md)** · **[`TESTING.md`](../TESTING.md)** (full QA matrix).

---

## Table

| Variable | Default | Role |
|----------|---------|------|
| `NEXT_PUBLIC_API_BASE` | *(see below)* | Optional **planner API** origin (no trailing slash), e.g. `http://localhost:3001`. If unset, the map uses **`http://<current-host>:3001`** in the browser — handy for WSL / LAN testing. |
| `NEXT_PUBLIC_PLAN_CLIENT_TIMEOUT_MS` | `300000` | For blocking `POST /plan`, this is the fetch abort budget. For `NEXT_PUBLIC_PLAN_USE_JOB=true`, this is an **idle** budget (deadline resets on each **checkpoint** or server **`heartbeat`** event). Not used for `/candidates` or `/route-preview`. Legacy `130000` / `180000` in env map to 300s in code. |
| `NEXT_PUBLIC_ROUTE_PREVIEW_CLIENT_TIMEOUT_MS` | `300000` | Abort for **hops 2+** of merged **`POST /route-preview`** (multi-waypoint); hop **1** is not aborted. |
| `NEXT_PUBLIC_PREFETCH_CANDIDATES` | `true` | Parallel **`POST /candidates`** (Slice 3) so pins can appear before **`/plan`** finishes; set **`false`** to skip. |
| `NEXT_PUBLIC_PREFETCH_ROUTE_PREVIEW` | `true` | Parallel **`POST /route-preview`** (Slice 4) on normal single-flow trips; set **`false`** to skip. |
| `NEXT_PUBLIC_PLAN_USE_JOB` | *(unset → off)* | **`POST /plan`** with **`planJob: true`**, then **`GET /plan/jobs/:id/events`** (SSE / **`EventSource`**) for checkpoints when **`NEXT_PUBLIC_PLAN_USE_SSE` ≠ `false`**; otherwise poll **`GET /plan/jobs/:id`** every 250ms. **Debug:** live solver checkpoints. **Map (standard):** partial itineraries from checkpoints update the route/stop list with user-visible status (stop count, refinement stage 3 stays active until complete). Requires API support. |
| `NEXT_PUBLIC_PLAN_USE_SSE` | *(unset → on)* | When **`NEXT_PUBLIC_PLAN_USE_JOB=true`**, use **Server-Sent Events** for plan-job checkpoints (same JSON as **`GET /plan/jobs/:id`**, pushed as **`data:`** lines). On transient disconnects, the map **reconnects** with capped exponential backoff (up to **8** attempts, max delay **30s** between tries — constants in **`web/src/app/map/page.tsx`**). Set to **`false`** to use **polling only** (e.g. debugging or proxies that block SSE). |
| `NEXT_PUBLIC_MAP_SHOW_CANDIDATES_DEFAULT` | dev: `true`, prod: `false` | Initial UI default for **charger + hotel candidate markers**. Users can still toggle with checkboxes after load. |
| `NEXT_PUBLIC_MAP_SHOW_WAYPOINTS_DEFAULT` | dev: `true`, prod: `false` | Initial default for rendering **auto-waypoint itinerary markers** (route line is unaffected). |
| `NEXT_PUBLIC_MAP_DEBUG_RANGE_LEGS` | *(unset → off)* | **Debug:** split merged route polyline by presentation **`rangeLegs`** and show the **Range legs (debug)** sidebar. Standard product uses a **single blue** route line; omit this in production builds. |
| `NEXT_PUBLIC_OPTIMIZE_WAYPOINT_ORDER` | `true` | With **≥2 waypoints** and no locks/replan, map sends **`optimizeWaypointOrder: true`** on **`POST /plan`** so the API can reorder intermediates by haversine proxy (**`debug.waypointOrderOptimization`**). Uncheck **Optimize waypoint order** in the sidebar to disable per session. |

| *(behavior)* | — | **`debug.segmentsAttempted`** on **blocking** `POST /plan` appears only when the plan finishes. With **`planJob`**, poll responses include **`checkpoints`** before **`result`** — see **`V2_API.md`**. |
| *(behavior)* | — | **Multi-waypoint** merged **`/route-preview`**: hop **2+** shares **`NEXT_PUBLIC_ROUTE_PREVIEW_CLIENT_TIMEOUT_MS`**. If a later hop fails or times out, the merged preview may stay **partial** (`partialPreviewMeta` in the JSON). The map **extends** the loaded road polyline with **straight connectors** along **start → waypoints → end** so the full corridor still draws; raise the timeout if you need road geometry on every hop. |

---

## Example `web/.env.local`

```env
# Planner API (optional — defaults to same host :3001)
# NEXT_PUBLIC_API_BASE=http://localhost:3001

# Match or exceed API PLAN_TOTAL_TIMEOUT_MS
# NEXT_PUBLIC_PLAN_CLIENT_TIMEOUT_MS=600000

# NEXT_PUBLIC_ROUTE_PREVIEW_CLIENT_TIMEOUT_MS=300000
# NEXT_PUBLIC_PREFETCH_CANDIDATES=true
# NEXT_PUBLIC_PREFETCH_ROUTE_PREVIEW=true

# Live Debug checkpoints (async plan job → SSE by default, or poll if SSE disabled)
# NEXT_PUBLIC_PLAN_USE_JOB=true
# NEXT_PUBLIC_PLAN_USE_SSE=false

# Marker visibility defaults:
# Dev default is visible; production default is hidden unless overridden.
# NEXT_PUBLIC_MAP_SHOW_CANDIDATES_DEFAULT=true
# NEXT_PUBLIC_MAP_SHOW_WAYPOINTS_DEFAULT=true

# Debug: range-leg polyline split + sidebar (not standard product)
# NEXT_PUBLIC_MAP_DEBUG_RANGE_LEGS=true
```

Copy from repo **`.env.example`** (web section) for commented templates.
