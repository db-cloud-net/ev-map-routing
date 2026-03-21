# Version 2 — cherry-pick gates (not baseline)

Baseline v2 ships **waypoints + along-route candidates** embedded in `POST /plan`. The following are **explicitly gated** until a short design note + PRD paragraph exists:

| Feature | Gate |
|---------|------|
| **Slice 3 — `POST /candidates`** | **Shipped** — [docs/designs/slice3-get-candidates.md](designs/slice3-get-candidates.md); map **prefetch** UI remains optional |
| **Slice 4 — progressive ~60s first screen** | **Phase 1 shipped:** `POST /route-preview` — [V2_API.md](./V2_API.md) § Slice 4; **Phase 2** map UI + refinements still gated — [designs/slice4-progressive-first-screen.md](designs/slice4-progressive-first-screen.md) |
| Saved trips / accounts | New doc under `docs/designs/` + API sketch |
| Shareable plan links | Same + privacy review |
| Public API versioning / rate limits | `docs/V2_API.md` + ops runbook |
| TSP / auto-reorder waypoints | **[ROUTING_UX_SPEC.md](./ROUTING_UX_SPEC.md)** §1/§4 define intent; implementation gated until time-box + perf + QA; see **PRD.md** § *Routing optimization* |

**Rule:** do not implement gated items in the same PR as baseline v2 without the above.
