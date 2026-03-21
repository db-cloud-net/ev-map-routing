# Version 2 — cherry-pick gates (not baseline)

Baseline v2 ships **waypoints + along-route candidates** embedded in `POST /plan`. The following are **explicitly gated** until a short design note + PRD paragraph exists:

| Feature | Gate |
|---------|------|
| Saved trips / accounts | New doc under `docs/designs/` + API sketch |
| Shareable plan links | Same + privacy review |
| Public API versioning / rate limits | `docs/V2_API.md` + ops runbook |
| TSP / auto-reorder waypoints | PRD non-goal unless promoted; perf + QA implications |

**Rule:** do not implement gated items in the same PR as baseline v2 without the above.
