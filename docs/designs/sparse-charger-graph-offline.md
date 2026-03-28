# Sparse DC-fast charger graph + offline segment routing (design draft)

**Status:** Draft — plan iteration (not implemented).  
**Related:** [data-plane-vs-application-plane-adr.md](./data-plane-vs-application-plane-adr.md) (boundary: POI/graph **data** vs trip **application**) · [local-mirror-architecture.md](../local-mirror-architecture.md) (A1/B-track snapshots), [LOCAL_MIRROR_CHECKPOINT.md](../LOCAL_MIRROR_CHECKPOINT.md).

## Problem

Online planning currently issues **many** Valhalla calls per trip (per-edge travel time in the least-time graph). We want **offline** precomputation of a **sparse** DC-fast charger graph (order 10⁴ nodes US-wide; ~50k as an upper-bound sizing anchor), **sharded** by region/tile, with optional **Overpass** enrichment on nodes, so **query time** is dominated by graph search + dynamic EV constraints—not live routing matrices.

## Target shape

- **Offline:** Ingest DC-fast nodes → generate candidate edges (spatially filtered) → batch Valhalla (or matrix APIs) → persist weighted edges + metadata → validate → promote (same lifecycle spirit as mirror snapshots).
- **Online:** Select relevant **shards** + **cross-shard** connectors → load subgraph → plan (SOC / locks / overnight remain dynamic).

## Storage / infra options (including PostGIS)

| Option | Strengths | Weaknesses | Fit for Synology / Compose |
|--------|-----------|------------|----------------------------|
| **NDJSON + manifest** (today’s mirror style) | Simple, diffable, atomic `current/` promotion | Poor random edge lookup unless entire shard loaded; huge files at scale | Excellent for **artifacts + audit**; weak alone for **hot** graph reads |
| **SQLite per shard** (indexed `edges`) | No extra service; copy/backup one file per shard; fast local lookup | Cross-shard queries need app logic | **Strong default** for embedded planner |
| **PostGIS (Postgres)** | **Spatial index** on `geography`/`geometry`; `ST_DWithin`, KNN (`<->`), corridor/polyline intersection; optional **pgRouting** experiments; mature ops (replication, PITR) | **Always-on DB**; pooler; migrations; backup discipline; planner API **depends** on DB availability | Good if you already run **Postgres** for other reasons; adds moving parts vs flat files |
| **Parquet / columnar** | Great for batch analytics, Spark | Weak for point lookups unless layered (e.g. DuckDB) | Better as **intermediate** export than primary online store |
| **Redis** | Fast cache | Not durable source of truth | Optional **L2** above disk/DB only |

### PostGIS-specific notes

**When it helps**

- **Online spatial selection:** “All charger nodes within **X km** of this **corridor LineString**” or “K nearest nodes to this polyline” without loading full shard lists into memory.
- **Cross-shard glue:** Store **bbox** or **geom** per shard; query which shards intersect a trip’s rough corridor before loading edge tables.
- **Enrichment joins:** Join Overpass-derived attributes in SQL if they land as relational rows; **GiST** indexes on geometry.
- **Operational:** If the stack already includes Postgres (e.g. future accounts, telemetry), **incremental cost** is lower.

**Costs / risks**

- **Drift from “boring file mirror”:** [local-mirror-architecture.md](../local-mirror-architecture.md) optimized for **versioned files + NAS**; PostGIS is a **service** with uptime and restore drills.
- **Planner coupling:** `POST /plan` latency and availability tie to DB (mitigate: read replicas, connection limits, timeouts, fallback to live Valhalla path).
- **Not required for offline batch:** Offline jobs can still write **SQLite or NDJSON** first, then **ETL into PostGIS** for serving—**dual artifact** (files = portable truth, DB = query index).

### Hybrid that preserves file-based truth

1. **Canonical snapshot** remains **files** under `mirror/snapshots/<id>/` (NDJSON/SQLite shards + `manifest.json`) for **portability and rollback**.
2. **Optional PostGIS** = **materialized serving layer**: refresh job loads the promoted snapshot into Postgres (truncate + copy or versioned schema), **or** use **Foreign Data Wrapper** / periodic sync—only if online spatial queries justify ops cost.

## Recommendation (iterative)

- Default **online** path: **indexed SQLite shards** (or mmap later) + manifest—**minimal new infra**.
- Add **PostGIS** when product needs **heavy geospatial filtering** on every plan, **multi-tenant** query concurrency, or you already operate Postgres in prod; treat it as a **serving index**, not the only copy of truth.

## Open decisions

- Shard key: H3 vs Valhalla tile vs bbox grid; cross-shard edge policy.
- Whether Overpass enriches **nodes only** vs adds **POI vertices** to the routable graph later.
- Explicit ADR to extend [local-mirror-architecture.md](../local-mirror-architecture.md) §4A scope: **precomputed Valhalla cost edges as data artifacts** (distinct from snapshotting Valhalla’s OSM extract).

## References (code)

- Mirror layout + manifest: [local-mirror-architecture.md](../local-mirror-architecture.md) A1.5, B1.
- Local mirror reader: [api/src/mirror/localMirrorAdapter.ts](../../api/src/mirror/localMirrorAdapter.ts) (full NDJSON load—**not** suitable for massive edge sets without change).
