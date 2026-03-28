# Documentation index

Start here for **v2** or onboarding. Longer specs are linked, not duplicated.

**Doc precedence:** On **routing behavior** or **progressive UX**, **[ROUTING_UX_SPEC.md](./ROUTING_UX_SPEC.md)** **supersedes** **[PRD.md](../PRD.md)** when they conflict. **PRD.md** stays authoritative for QA invariants, env knobs, and **V2_API** pointers unless the routing spec says otherwise.

**Corridor data:** With **`POI_SERVICES_BASE_URL`** set, **POI Services** is the **runtime** source for corridor DC-fast chargers, hotels, and related layers on **`/plan`** / **`/candidates`**. Docs that discuss **NREL** or the **local mirror** may describe **offline refresh** or **legacy** paths — see **[ROUTING_UX_SPEC.md](./ROUTING_UX_SPEC.md)** §2.

| Document | Purpose |
|----------|---------|
| **[DEPRECATED_MIRROR_STACK.md](./DEPRECATED_MIRROR_STACK.md)** | **Do not use** removed mirror Docker / NREL mirror stack; git history vs current `main`. |
| **[V1_SYSTEM.md](./V1_SYSTEM.md)** | **Minimal reconstruction guide** — what was built, how it fits together, how to run and validate it. |
| [`../PRD.md`](../PRD.md) | Product requirements and QA-linked env knobs (overnight/hotel/charging invariants). |
| [`V2_API.md`](./V2_API.md) | **v2** `POST /plan` additive fields (`waypoints`, `includeCandidates`, `candidates`, **locks**); **Slice 3** `POST /candidates` (shipped). |
| [`V2_CHERRY_PICKS.md`](./V2_CHERRY_PICKS.md) | Gated extras (saved trips, sharing, TSP) — not baseline v2. |
| [`designs/slice3-get-candidates.md`](./designs/slice3-get-candidates.md) | **Slice 3:** dedicated **`POST /candidates`** — **implemented**; see **`V2_API.md`** § Slice 3. |
| [`designs/slice4-progressive-first-screen.md`](./designs/slice4-progressive-first-screen.md) | **Slice 4:** **`POST /route-preview`** + **`/map`** preview (**`V2_API.md`** § Slice 4); refinements / §5 **TBD**. |
| [`../README.md`](../README.md) | Repo root: dev quickstart, ports, scripts. |
| [`../TESTING.md`](../TESTING.md) | QA matrix, E2E runners, per-stage `/plan` timeouts, manual checks. |
| [`VALHALLA.md`](./VALHALLA.md) | **`VALHALLA_BASE_URL`** — port **8002**, Docker vs NAS vs localhost. |
| [`HANDOFF_2026-03-21.md`](./HANDOFF_2026-03-21.md) | Latest **session snapshot** (Valhalla, ports, debug, next steps). |
| [`MAP_AND_NAV.md`](./MAP_AND_NAV.md) | Why the map line is **straight between stops** and turn-by-turn is **not** road nav. |
| [`ROUTING_UX_SPEC.md`](./ROUTING_UX_SPEC.md) | **Frozen** routing/UX goals: objectives, **~60s** first paint, **time-based** TBT horizons, **progressive refinements**, mirror data, **fail closed**, confidence UX. |
| [`../TODOS.md`](../TODOS.md) | Phase checklist and backlog (living; optional for pure reconstruction). |
| [`local-mirror-architecture.md`](./local-mirror-architecture.md) | Full local mirror design (contracts, router modes, B1–D3). |
| [`LOCAL_MIRROR_CHECKPOINT.md`](./LOCAL_MIRROR_CHECKPOINT.md) | Epic status snapshot (living). |
| [`d1-runbook.md`](./d1-runbook.md) | Deploy notes: POI + planner on Docker networks (mirror compose **removed**). |
| [`CI_SCOPE.md`](./CI_SCOPE.md) | Proposed CI gates + SLO log stub. |
| [`CLOUDFLARE.md`](./CLOUDFLARE.md) | Production **Cloudflare Tunnel** vs `planner-api`, CORS, secrets (no tokens in git). |

**Suggested order for a clean v2 baseline:** `V1_SYSTEM.md` → `PRD.md` (product) → `local-mirror-architecture.md` (only if you touch mirror/routing) → `TESTING.md` (verification).
