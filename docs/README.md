# Documentation index

Start here for **v2** or onboarding. Longer specs are linked, not duplicated.

| Document | Purpose |
|----------|---------|
| **[V1_SYSTEM.md](./V1_SYSTEM.md)** | **Minimal reconstruction guide** — what was built, how it fits together, how to run and validate it. |
| [`../PRD.md`](../PRD.md) | Product requirements and QA-linked env knobs (overnight/hotel/charging invariants). |
| [`V2_API.md`](./V2_API.md) | **v2** `POST /plan` additive fields (`waypoints`, `includeCandidates`, `candidates`, **locks**). |
| [`V2_CHERRY_PICKS.md`](./V2_CHERRY_PICKS.md) | Gated extras (saved trips, sharing, TSP) — not baseline v2. |
| [`../README.md`](../README.md) | Repo root: dev quickstart, ports, scripts. |
| [`../TESTING.md`](../TESTING.md) | QA matrix, E2E runners, per-stage `/plan` timeouts, manual checks. |
| [`../TODOS.md`](../TODOS.md) | Phase checklist and backlog (living; optional for pure reconstruction). |
| [`local-mirror-architecture.md`](./local-mirror-architecture.md) | Full local mirror design (contracts, router modes, B1–D3). |
| [`LOCAL_MIRROR_CHECKPOINT.md`](./LOCAL_MIRROR_CHECKPOINT.md) | Epic status snapshot (living). |
| [`d1-runbook.md`](./d1-runbook.md) | Docker mirror + planner verification. |
| [`CI_SCOPE.md`](./CI_SCOPE.md) | Proposed CI gates + SLO log stub. |
| [`CLOUDFLARE.md`](./CLOUDFLARE.md) | Production **Cloudflare Tunnel** vs `planner-api`, CORS, secrets (no tokens in git). |

**Suggested order for a clean v2 baseline:** `V1_SYSTEM.md` → `PRD.md` (product) → `local-mirror-architecture.md` (only if you touch mirror/routing) → `TESTING.md` (verification).
