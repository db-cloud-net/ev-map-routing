# Documentation index

Start here for **v2** or onboarding. Longer specs are linked, not duplicated.

**Doc precedence:** On **routing behavior** or **progressive UX**, **[ROUTING_UX_SPEC.md](./ROUTING_UX_SPEC.md)** **supersedes** **[PRD.md](../PRD.md)** when they conflict. **PRD.md** stays authoritative for QA invariants, env knobs, and **V2_API** pointers unless the routing spec says otherwise.

| Document | Purpose |
|----------|---------|
| **[V1_SYSTEM.md](./V1_SYSTEM.md)** | **Minimal reconstruction guide** — what was built, how it fits together, how to run and validate it. |
| [`../PRD.md`](../PRD.md) | Product requirements and QA-linked env knobs (overnight/hotel/charging invariants). |
| [`V2_API.md`](./V2_API.md) | **v2** `POST /plan` additive fields (`waypoints`, `includeCandidates`, `candidates`, **locks**); **Slice 3** `POST /candidates` (shipped). |
| [`V2_CHERRY_PICKS.md`](./V2_CHERRY_PICKS.md) | Gated extras (saved trips, sharing, TSP) — not baseline v2. |
| [`designs/slice3-get-candidates.md`](./designs/slice3-get-candidates.md) | **Slice 3:** dedicated **`POST /candidates`** — **implemented**; see **`V2_API.md`** § Slice 3. |
| [`designs/slice4-progressive-first-screen.md`](./designs/slice4-progressive-first-screen.md) | **Slice 4:** progressive **~60s** first screen — **Phase 1:** `POST /route-preview` (**`V2_API.md`** § Slice 4); map UI / refinements **TBD**. |
| [`../README.md`](../README.md) | Repo root: dev quickstart, ports, scripts. |
| [`../TESTING.md`](../TESTING.md) | QA matrix, E2E runners, per-stage `/plan` timeouts, manual checks. |
| [`VALHALLA.md`](./VALHALLA.md) | **`VALHALLA_BASE_URL`** — port **8002**, Docker vs NAS vs localhost. |
| [`HANDOFF_2026-03-21.md`](./HANDOFF_2026-03-21.md) | Latest **session snapshot** (Valhalla, ports, debug, next steps). |
| [`MAP_AND_NAV.md`](./MAP_AND_NAV.md) | Why the map line is **straight between stops** and turn-by-turn is **not** road nav. |
| [`ROUTING_UX_SPEC.md`](./ROUTING_UX_SPEC.md) | **Frozen** routing/UX goals: objectives, **~60s** first paint, **time-based** TBT horizons, **progressive refinements**, mirror data, **fail closed**, confidence UX. |
| [`../TODOS.md`](../TODOS.md) | Phase checklist and backlog (living; optional for pure reconstruction). |
| [`local-mirror-architecture.md`](./local-mirror-architecture.md) | Full local mirror design (contracts, router modes, B1–D3). |
| [`LOCAL_MIRROR_CHECKPOINT.md`](./LOCAL_MIRROR_CHECKPOINT.md) | Epic status snapshot (living). |
| [`d1-runbook.md`](./d1-runbook.md) | Docker mirror + planner verification. |
| [`CI_SCOPE.md`](./CI_SCOPE.md) | Proposed CI gates + SLO log stub. |
| [`CLOUDFLARE.md`](./CLOUDFLARE.md) | Production **Cloudflare Tunnel** vs `planner-api`, CORS, secrets (no tokens in git). |

**Suggested order for a clean v2 baseline:** `V1_SYSTEM.md` → `PRD.md` (product) → `local-mirror-architecture.md` (only if you touch mirror/routing) → `TESTING.md` (verification).
