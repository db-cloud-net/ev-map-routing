# ADR — Deprecate NREL, Overpass, and local mirror in Travel-Routing

**Status:** Accepted — **runtime POI-only complete** in this repo (`api/src/corridor/providerContracts.ts`, `resolvePlanProviders` → `poi_only`, no `nrelClient` / `overpassClient` / mirror adapters). Corridor env names: **`CORRIDOR_*`** with legacy **`NREL_*` / `USE_NREL_*`** aliases in `corridorCandidates.ts`.  
**Date:** 2026-03-27  
**Related:** [data-plane-vs-application-plane-adr.md](./data-plane-vs-application-plane-adr.md) · [local-mirror-architecture.md](../local-mirror-architecture.md) *(legacy; targeted for shrink/remove)* · [`../../TODOS.md`](../../TODOS.md) *(backlog — POI-only architecture cleanup)*

---

## Context

Travel-Routing historically supported **three** ways to obtain corridor chargers and related POIs: **live NREL** HTTP, **live Overpass** HTTP, and a **local mirror** (NDJSON snapshots, often fed from the same upstream sources). **POI Services** now provides corridor DCFC, hotels, optional **pairs** / **edges**, and stable ids in one datastore, with ingest and optimization **outside** this app.

Maintaining parallel paths duplicates logic, encourages fallback bugs, increases env and ops surface area, and contradicts the product goal: **one reliable runtime data path** with clear failure behavior.

---

## Decision

1. **Travel-Routing SHALL NOT** depend on **live NREL**, **live Overpass**, or **local mirror reads** for user-facing **`POST /plan`** and **`POST /candidates`** once the POI-only implementation is complete. Corridor POI layers SHALL come **only** from **POI Services** (`POI_SERVICES_BASE_URL` and related client code).

2. **Travel-Routing SHALL** **remove or retire** first-party code, configuration, scripts, tests, and documentation that exist primarily to support NREL, Overpass, or the mirror stack (including `SOURCE_ROUTING_MODE` tiers, remote/mirror adapters on planner paths, refresh workers, `docker-compose.mirror.yml`, mirror C4 scripts, and planner fallbacks that call `nrelClient` / `overpassClient` / mirror adapters).

3. **Ingest** of NREL-, Overpass-, or Valhalla-derived data **MAY** continue **inside the POI Services project** (or other offline jobs). This ADR does **not** ban those upstream datasets; it bans **calling them from Travel-Routing** for planning/corridor use. **Product alignment:** POI Services is the **source of truth for places of interest** tied to **Valhalla**-consistent routing data — see **[data-plane-vs-application-plane-adr.md](./data-plane-vs-application-plane-adr.md)** § *POI Services as source of truth (accepted)* before adding new corridor POI behavior in this app.

4. **POI failure** for corridor queries SHALL remain **fail-closed** with a **user-visible** `message` and stable **`errorCode`** — no silent fallback to NREL/Overpass/mirror.

5. **Changes that reintroduce** NREL, Overpass, or mirror as a **runtime** planner dependency **SHOULD** be rejected unless this ADR is explicitly superseded or amended with rationale and date.

---

## Consequences

- **Positive:** Smaller API surface, fewer env vars, simpler `debug` / metrics, fewer flaky E2E dependencies, alignment with POI as single source of truth.
- **Negative:** One-time cost to delete code paths, update CI, and confirm no production deploy still uses mirror or remote-only routing for chargers/hotels.
- **Observability:** Buckets such as `debug.providerCalls.nrel` / `overpass` and mirror fields on `debug.sourceRouting` are **legacy** and SHOULD disappear when code is removed.

---

## Implementation notes (non-exhaustive)

Representative areas (historical checklist): types now live under **`api/src/corridor/`**; **`debug.corridorSampling.corridorRadiusMiles`** replaces **`nrelRadiusMiles`**. Long-form mirror docs remain for archaeology only (**[`DEPRECATED_MIRROR_STACK.md`](../DEPRECATED_MIRROR_STACK.md)**).
