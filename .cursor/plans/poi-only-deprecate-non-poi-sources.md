# POI-only Travel-Routing — deprecate NREL, Overpass, mirror

**Normative detail:** [`docs/designs/deprecate-nrel-overpass-mirror-travel-routing-adr.md`](../../docs/designs/deprecate-nrel-overpass-mirror-travel-routing-adr.md)  
**Backlog / sequencing:** [`TODOS.md`](../../TODOS.md) — *Backlog — POI-only architecture cleanup*  
**Related execution plan (Cursor home):** `~/.cursor/plans/poi-only_no_nrel_8b7241e7.plan.md` — POI-only planner, fail-closed UX, strip runtime NREL paths

## Intent (short)

- **Runtime** corridor DCFC, hotels, pairs, edges: **POI Services only** for `/plan` and `/candidates`.
- **Remove** first-party use of **live NREL**, **live Overpass**, and **local mirror** (and runtime reads of data originating only from those pipelines) from this repo once POI-only prod/CI are validated.
- **POI failure:** show **message**, stable **errorCode**, **quit** — no fallback to NREL/Overpass/mirror.
- **Upstream ingest** (NREL/Overpass/Valhalla offline) stays **in POI Services**, not reimplemented here.

This file is a **pointer** so the policy lives in-repo beside the ADR; detailed checklists stay in `TODOS.md` and the home Cursor plan.
