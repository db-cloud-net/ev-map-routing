# Local mirror architecture (NREL + Overpass)

**Status:** Draft — design in progress (`/plan-eng-review` kickoff 2026-03-18).  
**Intent:** Architecture **before** implementation (see `TODOS.md` Phase 2 lanes A–D).  
**DRI:** David  

## Eng review decisions (locked — 2026-03-18)

| # | Choice | Meaning |
|---|--------|--------|
| **1A** | Doc-only A1–A5 first | No mirror ingest/runtime code until **A1–A5** are written and reviewed in this file. First code PR after that: **A3** interfaces + remote adapters only. |
| **2A** | Thin router module | Introduce a dedicated module (e.g. `api/src/sourceRouter.ts` or `api/src/planner/sourcePolicy.ts`) that **`planTrip`** calls; **avoid** growing `planTrip.ts` with mode branches. |
| **3A** | Storage in A1 | Choose mirror persistence (e.g. versioned files + manifest vs SQLite) inside **A1** with an explicit **boring-default** rationale for Synology/NAS. |
| **4A** | Valhalla out of mirror v1 | This epic **does not** include snapshotting or lifecycle for Valhalla unless **D1** explicitly expands; Valhalla stays as today’s deployment/integration. |
| **5A** | Dual-read later *(DRI-confirmed)* | **C1** dual-read/compare is **specified** in outline first; **implement** only after **local-primary + fallback** read path is working. |

Reopen only via explicit note in this doc (date + reason). **5A** reaffirmed by DRI explicitly (not default-only).

## Dependency order (do not reorder without cause)

```
A1 contracts ──► A2 errors ──► A3 provider IFs ──► A4 source router ──► A5 freshness
      │                                                      │
      └──────────────────────────┬───────────────────────────┘
                                 ▼
   B1 snapshot lifecycle ──► B2 refresh pipeline ──► B3 validation ──► B4 fallback matrix
                                 │
                                 ▼
   C1 dual-read ──► C2 promotion gates ──► C3 rollback ──► C4 observability
                                 │
                                 ▼
   D1 topology ──► D2 config/secrets ──► D3 sign-off checklist
```

## Current vs target (data flow)

**Today (simplified)**

```
Browser → POST /plan → planTrip.ts ─┬─► geocode
                                     ├─► nrelClient (HTTP)
                                     ├─► overpassClient (HTTP)
                                     └─► valhallaClient (HTTP/local)
```

**Target**

```
Browser → POST /plan → planTrip.ts
              │
              └── sourceRouter (A4) picks mode
                        │
         ┌──────────────┴──────────────┐
         ▼                             ▼
  ChargerProvider (A3)          PoiProvider (A3)
   ├─ RemoteNrelAdapter           ├─ RemoteOverpassAdapter
   └─ LocalMirrorAdapter          └─ LocalMirrorAdapter
              │                             │
              └────────► normalize to ◄─────┘
                    canonical types (A1)
```

**Valhalla (4A):** Often already local; **not** in mirror snapshot lifecycle for v1. Epic **centers on NREL + Overpass** mirrors unless D1 explicitly adds routing-graph artifacts.

## Sections (fill in order)

| ID | Section | State |
|----|---------|--------|
| A1 | Canonical schemas (charger, POI/hotel, snapshot metadata) | TODO |
| A2 | Typed error taxonomy + mapping rules | TODO |
| A3 | `ChargerProvider` / `PoiProvider` interfaces + timeout semantics | TODO |
| A4 | Source routing modes + decision tree | TODO |
| A5 | Freshness SLA + staleness behavior | TODO |
| B1–B4 | Snapshot lifecycle, refresh, validation, fallback matrix | TODO |
| C1–C4 | Dual-read, cutover, rollback, observability | TODO |
| D1–D3 | Synology/Docker topology, config model, sign-off gate | TODO |

## Related docs

- `TODOS.md` — full task breakdown and owners  
- `TESTING.md` — invariant-based QA (must hold after rollout)  
- `PRD.md` — product requirements tied to env + invariants  

## Next action

Complete **A1** in this document (concrete types/fields/versioning), then **A2**, before any mirror storage or ingest code.
