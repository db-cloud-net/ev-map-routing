# ADR — Data plane (corridor POI + graph) vs application plane (trip product)

> **Source of truth:** **POI Services** is the **system of record for places of interest** that participate in routing: corridor DC-fast chargers, hotels, optional **pairs** / **edges**, and any future POI types that share the same **routable-location** contract. The product does **not** require every user-facing location (addresses, arbitrary waypoints, one-off stops) to exist in POI — **trip endpoints and general geocoding** stay on the **geocoder** unless you explicitly route resolution through POI. That POI data is **optimized and tied to Valhalla** (tiles, offline matrices, shard layout) so POI and road geometry stay **aligned** — coupling is **owned in the POI pipeline**, not reimplemented in Travel-Routing. Ingest of upstream datasets (e.g. NREL/Overpass) may happen **inside** POI Services; Travel-Routing does **not** call those sources for corridor planning. **User-entered** start/end/waypoint **strings** are still **geocoded** via the app’s geocoder (`/plan` path) unless/until the product routes place resolution through POI explicitly.

**Status:** **Accepted** (2026-03-27) — **boundary + § “POI as source of truth”** below. **§ Options for wiring** (A/B/C) and performance numbers remain **documented alternatives** until one wiring is chosen and measured; record that choice in a follow-up note or ADR amendment.  
**Date:** 2026-03-24 · **Updated:** 2026-03-27  
**Related:** [deprecate-nrel-overpass-mirror-travel-routing-adr.md](./deprecate-nrel-overpass-mirror-travel-routing-adr.md) *(remove NREL/Overpass/mirror from Travel-Routing)* · [sparse-charger-graph-offline.md](./sparse-charger-graph-offline.md) · [local-mirror-architecture.md](../local-mirror-architecture.md) · [range-leg-incremental-trust-adr.md](./range-leg-incremental-trust-adr.md) · [ROUTING_UX_SPEC.md](../ROUTING_UX_SPEC.md)

---

## POI Services as source of truth (accepted)

1. **Places of interest with a routable role in the product** (chargers, hotels, pairs, edges, and future corridor POI types) **SHALL** be **authored, versioned, and served** from **POI Services** — not duplicated as ad-hoc datasets or live fetches inside Travel-Routing. This does **not** imply that **every** location the user can type (home, arbitrary address, off-network POI) must be modeled in POI; only **corridor POI layers** consumed for planning are in scope here.
2. **Design intent:** POI data and **Valhalla** (road network / tiles / offline cost artifacts) are **co-designed** so corridor queries, **stable ids**, and **road-linked** geometry remain **consistent** for optimal joint behavior between POI and routing.
3. **Travel-Routing** consumes POI only through **documented HTTP contracts** (e.g. `POST /corridor/query` with `layers[]`). It **SHALL NOT** add **new** production paths that invent parallel POI stores or call non-POI upstreams for **corridor POI** layers.
4. **Change control:** If a feature needs **new** POI-backed fields, **new** POI types, or **new** ways to tie places to the road graph, **pause** and treat it as a **POI Services** design question first: *does this belong in POI (schema + ingest + Valhalla alignment), and what is the API contract?* Only after alignment should Travel-Routing wire the client. If the right home is unclear, **stop and clarify** before implementing in this repo.

---

## Context

Travel-Routing is evolving toward **offline-precomputed** road costs between **DC-fast chargers** (sparse graph, sharded storage) so online planning does not issue hundreds of live Valhalla calls per trip. Separately, a **POI API** project (Python/FastAPI) implements **NREL + Overpass ingest**, **SQLite shards**, and **Valhalla matrix offline** — today some of that is bundled with **charger-specific Dijkstra** inside `POST /route`. **This ADR prefers decoupling:** POI exposes **data** only; **pathfinding and sequencing** live in the planning layer or caller.

We need a **stable boundary** between:

1. **POI / data plane** — **Where** things are, **what type** they are, **which are near each other**, **spatial queries** along a corridor, and **edge weights** (precomputed road time/distance between routable nodes) as **queryable artifacts**. It does **not** own **which stop sequence is optimal** for a given product.
2. **Routing / planning layer** — **How to sequence stops** under **constraints** the application defines: battery range, driving hours, locks, overnight policy, fuel economy, fleet rules, etc. May run Dijkstra, A\*, MILP, or heuristics — **on graphs built from data-plane responses**.
3. **Application plane (Travel-Routing product)** — Orchestration, UX, `planJob`, `rangeLegs`, preview + plan merge, and user-facing contracts.

Without this boundary, responsibilities **blur** (charger-specific Dijkstra baked into the POI service, duplicate planners, ID drift, unclear failure ownership).

### Edges as a data layer, not an algorithm

**Precomputed edges are just another layer** the POI service can serve (versioned, filtered by corridor/shard): `from_id`, `to_id`, `duration_s`, `distance_m`, plus manifest provenance. They are **not** synonymous with “the service runs shortest-path.” A **charger routing app** loads `charger` + `edges` and runs Dijkstra **client-side** or in a **separate planning microservice**. A **road-trip planner** requests `["restaurant", "rest_stop", "hotel"]` and **never** loads charger edges. An **EV planner** might request `["charger", "edges", "hotel", "pairs"]` and runs its own optimizer — or calls **Travel-Routing `planTrip`** which consumes POI data only through a thin client.

**Layered requests:** The POI service runs **only** the shard queries needed for the **requested layers** (POI types, edge bundles, pair tables). The **caller** picks layers; generic “what’s near my route” never touches DCFC edges.

---

## Decision (proposed)

**Record the following as the intended split; implementation and “HTTP vs shared files” remain open.**

### POI / data plane owns

- **Inputs:** Geographic **scope** only — corridor (polyline + radius), bbox, shard keys, optional filters on **type** / **network** / **connector**. No battery state, no “optimize my trip.”
- **Outputs:**
  - **POI records** with **stable join keys** (`source` + `source_id` or a defined global id scheme) and enrichments (e.g. hotel ↔ nearest DCFC, onsite L2).
  - **Edge records** (optional layer): directed edges with road **`duration_s`** / **`distance_m`**, offline-built with Valhalla, **versioned** in manifest (routing engine build, snapshot id).
  - **Derived relationships** as data: e.g. hotel–charger pairs within distance — **tables**, not a recommended itinerary.
- **Queries:** Bounding box, nearby, corridor POIs, corridor **edges** (subgraph), pair queries — **no Dijkstra**, no “optimal charger sequence” as a service-owned concept.

### Routing / planning layer owns

- **Any graph algorithm:** shortest path, resource constraints, multi-objective scoring, insertion of overnight stops — using **weights and nodes** from the POI layer.
- May live **inside Travel-Routing** (`planTrip`), in a **dedicated planning service**, or **in the client** for experiments.

### Application plane (Travel-Routing product) owns

- **User/session semantics:** vehicle range, buffer SoC, charge duration model, **locked chargers/hotel**, **overnight insertion**, **replan**.
- **Orchestration:** `POST /plan`, `planJob` + poll, timeouts, merging **route-preview** + **plan** + **candidates**.
- **Presentation:** `rangeLegs` (API), messages, Debug, ROUTING_UX_SPEC liveness rules. Map polyline split by `rangeLegs` is **debug-only** (`NEXT_PUBLIC_MAP_DEBUG_RANGE_LEGS`).

**Rule of thumb:** *POI data answers “what exists, where, and what are the road costs between nodes?”* · *Planning answers “what sequence satisfies my constraints?”* · *The product answers “what do we show the user?”*

---

## Performance goal (planning + EV product)

**Target:** Interactive EV planning — including **charger sequencing**, **overnight policy**, and **charger/hotel mapping** in the Travel-Routing app — should aim for **sub-second latency for the planning core** (typical: **p50 &lt; 500 ms**, **p95 &lt; 1 s** for the graph + constraint solver portion), once **charger↔charger edges are precomputed** and the online path **loads only a corridor-bounded subgraph**.

**What makes this achievable:** Offline Valhalla matrix work moves **out** of the request path; online work is **indexed shard reads** + **graph search** + product rules. The **POI / data layer** is not inherently slow — it is **read-mostly SQLite** (or equivalent) and **does not** run heavy optimization per request.

**What this ADR does *not* guarantee without measurement:** End-to-end **`POST /plan`** wall time includes geocode, Valhalla calls used by the planner (e.g. polyline / leg costs), **POI Services** corridor HTTP, and serialization — those need separate budgets and load tests.

**Validation:** Add benchmarks and CI thresholds (corridor size caps, shard counts) when implementing; record actual p50/p95 in `TESTING.md` or a perf appendix.

---

## Multi-consumer POI service (efficiency across apps)

A **data-only** POI service (spatial queries + optional edge layers, **no** embedded trip optimizer) is **efficient for multiple applications** (Travel-Routing, fleet tools, a generic “near my route” client):

- Each caller requests **only the layers it needs**; non-EV apps never pay for **edge** subgraphs.
- **Read-only** shards scale with **concurrent readers**; cost is proportional to **data touched**, not to “how smart” each downstream app is.
- **Sequencing and product policy** stay in each app — the shared service does not become a **bottleneck** by running **per-app** optimization server-side.

---

## Options for wiring POI data into Travel-Routing

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **A — Shared artifacts only** | `planTrip` reads **shard files + manifest** (same layout the pipeline writes). Planning runs **graph search + constraints** in Node (or WASM). | Single planner codebase; POI HTTP optional; NAS-friendly; **clear algorithm ownership** in Travel-Routing. | Implement **subgraph load + search** in TS; large edge sets need care. |
| **B — POI HTTP as pure data API** | FastAPI exposes **corridor POIs**, **corridor edges** (subgraph), **layers** — **no** bundled shortest-path. Travel-Routing runs optimization. | POI stays **thin**; multiple apps can share it; **no** charger-only coupling in POI. | Network hop; strict **contract** for subgraph shape and ids. |
| **C — Hybrid** | Files on disk are **canonical**; optional HTTP for tools; planner reads files in prod. | Portable truth + flexibility. | Two readers to test if both paths ship. |

**Deprecated pattern (avoid):** POI **`POST /route`** that **embeds Dijkstra** — couples place data to one optimization story.

**Decision to record later:** A vs B vs C after spike: **p95** vs targets above, **ops cost**, **solver ownership** (TS vs dedicated service).

---

## Consequences

### If we respect this boundary

- **New POI types** (rest areas, food) extend **data schema + ingest**; **product rules** that “prefer a stop after 3h” stay in the **application** as scoring over data-plane results (unless we deliberately move ranking offline).
- **Precomputed edges** can be **shared** across clients (CLI, future mobile) without dragging EV policy into the datastore.
- **Testing** splits naturally: **contract tests** + **golden shards** for data; **E2E** for application.

### If we blur the boundary

- **Dijkstra (or any sequencer) as the only POI HTTP surface** ties **every** consumer to charger-trip semantics; **restaurant-only** or **fleet** apps cannot reuse POI without inheriting EV assumptions. A **data-first** API (`POST /corridor/query` + layers) avoids that; an optional **`POST /route`** demo wrapper is fine if it is **not** the canonical contract (see References).
- Risk of **two competing “planners”** (POI `POST /route` vs `planTrip`) with **subtle** differences in start/end attachment, corridor geometry, or filters — **Travel-Routing should integrate against `POST /corridor/query`**, not `/route`, unless intentionally prototyping.
- **Integer per-run ids** (common in offline jobs) vs **string NREL ids** for locks — must be **mapped** explicitly at the boundary.

---

## Status transitions

| State | Meaning |
|-------|---------|
| **Proposed** | This ADR; team aligns on vocabulary and options. |
| **Accepted** | Boundary locked (POI SoT for corridor POI); A/B/C wiring may be chosen in a follow-up. Linked from `TODOS.md` / `PRD.md` when relevant. |
| **Superseded** | Replaced by a new ADR if we fold graph into mirror schema or add PostGIS serving layer. |

---

### POI corridor + overnight sleep (Travel-Routing)

When the app uses **POI Services** for corridor DC-fast sampling, it may also request **`hotel`** and **`pairs`** layers so overnight hotel discovery and **sleep-stop charger meta** stay in the **data-plane** id universe (no duplicate Overpass + NREL near-hotel calls when pairs exist). **Fail-closed** behavior and stable **`POI_SERVICES_*`** error codes are documented in **[`poi-corridor-sleep-stops.md`](./poi-corridor-sleep-stops.md)**.

---

## References (external)

### Reference implementation — **POI Services** (v2, sibling repo)

- **Deployment (prod):** On **Synology NAS**, POI runs as a Docker container (service name **`poi`**) on the user-defined **`prod-network`**, same network as the planner API — e.g. **`POI_SERVICES_BASE_URL=http://poi:8010`**. See **[`docs/d1-runbook.md`](../d1-runbook.md)** (§ Synology NAS: POI Services on `prod-network`).
- **Local dev:** Clone the **POI Services** repo **next to** Travel-Routing (its **own** git repository, not a subtree); use a **`POI_SERVICES_BASE_URL`** pointing at your local or LAN instance.
- **Canonical consumer contract:** **`POST /corridor/query`** with **`layers[]`** (`charger`, `hotel`, `edges`, `pairs`, `shape`, etc.). The service returns **spatial data and precomputed edges** only; **no** embedded trip policy (SoC, overnight, locks).
- **Optional convenience:** **`POST /route`** is a **thin wrapper** (corridor query → Dijkstra → legs) for demos and quickstarts — **not required** for integrators. **Travel-Routing** and other production apps should call **`/corridor/query`** and run optimization in the **planning layer** (or pass a **caller-supplied `shape`** to skip Valhalla inside POI when `src`/`dst` would otherwise resolve a polyline).
- **Implementation:** TypeScript **Express** API (`corridorEngine`, `shardReader`); **Python** pipeline for ingest + offline Valhalla matrix + shard build.
- **Contracts folder** (sibling repo **`contracts/`**): **`openapi.yaml`** (HTTP surface: `/corridor/query`, `/pois`, `/pois/hotel-charger-pairs`, …); **`shard-schema.json`** (SQLite shard write/read contract); **`CONTRACT.md`** (three boundaries: pipeline → shards → API → consumers); **`validate_shards.py`** / **`validateShards.ts`** (shard validators). Travel-Routing’s HTTP client types mirror **`openapi.yaml`**; shard files on disk must satisfy **`shard-schema.json`**.

### Legacy note — **POI API** (Python monolith, superseded by POI Services v2)

- Older FastAPI repo with Dijkstra bundled in **`POST /route`** — **superseded** by the layered corridor design above; do not use it as the reference for new integrations.
