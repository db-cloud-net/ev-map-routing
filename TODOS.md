# TODOS

**Resume local mirror work:** [`docs/LOCAL_MIRROR_CHECKPOINT.md`](docs/LOCAL_MIRROR_CHECKPOINT.md) *(what’s done, next steps, file index — updated 2026-03-20).*

## Current status (snapshot — **2026-03-19**)

**DRI:** David *(adjust if ownership changes)*

**Manual QA:** **`TESTING.md`** § *Version 2 smoke* + locks (step 5) + **Phase 1 exit** (replan / Raleigh→Greensboro) — **completed** (2026-03-19).

### Immediate next steps (pick one)

1. **Commit / PR** — Push local **`main`** (or open PR) when ready; keep **theme commits** if splitting mirror vs planner vs docs.
2. ~~**Manual verify**~~ — **Done** — see **Manual QA** above.
3. **Then** — **Slice 2** design **done** (PRD § *Mid-journey replan* + **`docs/V2_API.md`** § *Roadmap — Slice 2*). Implementation gated until approved. **Slice 3** `GET /candidates` stays gated per **`docs/V2_CHERRY_PICKS.md`**.

### Build & test priority (rolling)

Use this order when choosing what to run or build next. **Higher = do sooner; lower = roadmap / on-demand.**

| Tier | What | Why |
|------|------|-----|
| **P0 — every PR / merge** | `npm -w api run build`; **`npm run qa:smoke`** (see [`docs/CI_SCOPE.md`](docs/CI_SCOPE.md)); add **`npm -w web run build`** if the web app changed | Catches compile breaks + core E2E without Docker/Valhalla in CI. |
| **P1 — Slice 1 exit / locks confidence** | [`TESTING.md`](TESTING.md) § *Version 2 smoke* + **step 5** (locks); **Phase 1 exit** (replan 5×, Raleigh→Greensboro) if still unchecked; optional **automated E2E** for lock `errorCode` paths; **multi-leg + locks** via API manual or `SPAWN_SERVER` E2E (map UI is single-segment) | Proves shipped V2 locks + UI contract before moving on. |
| **P2 — mirror / deploy / NAS** | [`docs/d1-runbook.md`](docs/d1-runbook.md), `scripts/d1-verify-mirror.mjs`, mirror C4 scripts — **when** changing mirror, Docker compose, or source routing | Per [`docs/CI_SCOPE.md`](docs/CI_SCOPE.md): not the default PR gate; run before release or infra changes. |
| **P3 — ROUTING_UX roadmap** | Progressive **~60s** first screen + refinements (**new API shape** + UI states); mirror **fail closed** for `/plan` per [`docs/ROUTING_UX_SPEC.md`](docs/ROUTING_UX_SPEC.md) §2; **Slice 2** `replanFrom`; **Slice 3** `GET /candidates` | Spec is frozen; implementation is **after** P0–P2 baseline is green unless explicitly pulled forward. |

**Quick command reference:** `npm run qa:smoke` · `node scripts/e2e-plan-functional.mjs` · `SPAWN_SERVER=true …` per **`TESTING.md`**.

---

**Shipped / working in repo**

- **Phase 1 — Frontend (F1–F3):** Map page clears route + markers on replan (`clearMapPlanArtifacts`), uses **Carto Voyager** GL style for readable labels, route line + halo styling for visibility (`web/src/app/map/page.tsx`).
- **Phase 1 — Timeouts & errors:** API wraps `planTrip` with **`PLAN_TOTAL_TIMEOUT_MS`** (default 120s) → **408** + `debug.reason: planner_timeout`; web uses **`NEXT_PUBLIC_PLAN_CLIENT_TIMEOUT_MS`** + `AbortController` and **`classifyPlanError`** (timeout vs network vs HTTP) (`api/src/server.ts`, `web/src/app/map/page.tsx`). Documented in **`TESTING.md`**.
- **Logging (MVP):** `/plan` emits structured **JSON lines** for start/end/error with **`requestId`**; planner accepts and threads `requestId` through major paths (`api/src/server.ts`, `api/src/planner/planTrip.ts`).
- **Repo / DX:** `api/dist/` and `web/.next/` ignored; API **`start`** script targets built server path; **`.env.example`**, **`README.md`** (`dev:api` / `dev:web`, port **3000/3001**), **`CORS_ORIGIN`** called out for manual testing.
- **QA docs:** `TESTING.md` covers smoke vs **`SPAWN_SERVER=true`** E2E, PowerShell env, **Next.js chunk 400 / blank map**, WSL + **`browse`** fallback, CORS/port notes.
- **Phase 2 (architecture + harness):** `docs/local-mirror-architecture.md` **A1–D3** complete; Phase 2 checklist rows below are **checked**. Mirror smoke scripts (`scripts/mirror-c4-*.mjs`, `d1-verify-mirror.mjs`) + [`docs/d1-runbook.md`](docs/d1-runbook.md) support ops validation.
- **Production NAS (Synology):** `docker-compose.mirror.yml` under `/volume1/docker/Travel-Routing`: `planner-api`, `mirror-refresh-once`, external **`prod-network`**, Valhalla on same network, **`env_file`** to `.env`. Mirror files: **`api/mirror/current/manifest.json`** + **`api/mirror/snapshots/<id>/`**.
- **V2 Slice 1 — Locks (shipped in code):** `lockedChargersByLeg` + `lockedHotelId` on **`POST /plan`**, **chained** `planLeastTimeSegment` (`planTripOneLegLocked.ts`), **per-leg** rows + **`errorCode`** taxonomy (**`docs/V2_API.md`**), **`V2_MAX_LOCKED_CHARGERS`** (`.env.example`). Map UI: **tap-to-lock** on charger/hotel candidates for **single‑segment** trips only (**`web/src/app/map/page.tsx`**).

**Known gaps / don’t assume “done”**

- **Manual `Raleigh → Greensboro`:** Often blocked by **env/ops** (wrong **`CORS_ORIGIN`** vs web port, stale **`web/.next`**, port **3000** already in use), not only planner logic — follow **`README.md`** + **`TESTING.md` §7** and **§ Phase 1 exit verification (manual)**.
- **Per-stage `/plan` budgets:** See **`TESTING.md`** env matrix (`PLAN_TOTAL_TIMEOUT_MS`, `PLAN_GEOCODE_TIMEOUT_MS`, `PLAN_VALHALLA_POLYLINE_TIMEOUT_MS`, `PLAN_VALHALLA_LEG_TIMEOUT_MS`, `NREL_FETCH_TIMEOUT_MS`, `OVERPASS_FETCH_TIMEOUT_MS`); tune per SLO.
- **Phase 3:** **`npm run qa:smoke`** covers API build + fast E2E; **`browse.exe`** / UI under WSL may still need **Bun CLI** fallback (documented in **`TESTING.md`**).
- **Overnight E2E:** HIE scenario is reliable when run with **`SPAWN_SERVER=true`** (per-case env); smoke-only run against a long-running dev API can **false-fail** (documented in **`TESTING.md`**).

---

## Release backlog — observability + charge-time UX (this release)

### Provider call metrics (backlog)

**Goal:** See where `/plan` time goes and tune timeouts with data (e.g. long Raleigh→Seattle runs).

- [x] **Valhalla / NREL / Overpass / geocode** — **`debug.providerCalls`** on **`POST /plan`** responses: **calls**, **totalMs**, **avgMs**, **durationsMs** per provider (`api/src/services/providerCallMetrics.ts`, clients, **`server.ts`** merge). Map **Debug (MVP)** shows JSON.
- [ ] **Structured logs** — Optional: emit the same totals on **`requestId`** log lines for aggregation without loading the UI.
- [x] **Docs** — **`TESTING.md`** § per-stage timeouts + **`debug.providerCalls`** note.

### Charge times in turn-by-turn (expectation vs UI)

**What you’re seeing:** Values like **2 / 8 / 19 minutes** are **modeled** `chargeTimeMinutes` on each **leg** in the least-time solver — roughly “time charging at the **from** stop to add enough energy for the **to** hop,” using the planner’s simplified energy model **not** real charger power curves, taper, or “minutes to 80%.”

- Short “charge” segments can be **small top-ups** before a short drive; long drives after a stop can follow a **large** modeled charge — variance is expected.
- **Not a bug by itself** unless we claim wall-clock realism; **backlog:** clarify UI copy (e.g. *Est. charge time (model)*) and/or **PRD** a richer model (kW, battery size, SoC bands) if product wants realism.

---

## V2 Selective Expansion — pre-Slice 1 checklist (Plan-Eng-Review) — **resolved**

**Decisions (implemented / documented):**

- [x] **Lock semantics** — **B)** Chained **segment** solves (`planTripOneLegLocked.ts`), not a single modified Dijkstra inside `leastTimeSegment`. **Overnight + locks:** not combined; **`LOCKED_ROUTE_TOO_LONG`** if chained time exceeds threshold. **`docs/V2_API.md`** + **§ Locks** in **`TESTING.md`**.
- [x] **Multi-leg request shape** — **`lockedChargersByLeg: string[][]`** (one row per driving leg). **`lockedHotelId`** (single id for overnight preference). **`shared/types.ts`**.
- [x] **Error contract** — **`errorCode`** on **`PlanTripResponse`** (`UNKNOWN_CHARGER_LOCK`, `INFEASIBLE_CHARGER_LOCK`, `INVALID_LOCK_LEGS`, …). Validation → HTTP **400** JSON body (not 500).
- [x] **Support / debug** — **`debug.lockValidation`** **not** added; diagnose via **`requestId`** + structured logs + **`debug`** on errors (**`docs/V2_API.md`**).

### PR description snippet (copy-paste)

```markdown
## V2 Slice 1 — decisions (from TODOS.md)

- Lock semantics: **B** (chained least-time segments)
- Multi-leg locks: **`lockedChargersByLeg`** (per-leg rows)
- Error contract: **`errorCode`** — see `docs/V2_API.md`
- debug.lockValidation: **no** (logs + `requestId`)
```

---

## V2 Selective Expansion — Slice 1 (implementation) — **status**

**Depends on:** pre-Slice 1 checklist above (done). **PR split:** still recommended if committing mirror + v2 together.

### Slice 1 — contracts + types
- [x] **Owner:** David  **Task:** **`PRD.md`** — locks + V2 goals documented (**§ Version 2**, **`lockedChargersByLeg`** / **`lockedHotelId`**, pointer to **`docs/V2_API.md`**); map remains single-segment for tap-to-lock in UI.
- [x] **Owner:** David  **Task:** **`docs/V2_API.md`** — request fields, **error taxonomy**, semantics.
- [x] **Owner:** David  **Task:** **`shared/types.ts`** — `lockedChargersByLeg`, `lockedHotelId`, `errorCode`.

### Slice 1 — API + planner
- [x] **Owner:** David  **Task:** **Request schema** — Zod + **`lockValidation.ts`** (leg length, duplicates, caps).
- [x] **Owner:** David  **Task:** **`planTrip` / `planTripOneLeg` / `planTripOneLegLocked`** — enforce locks; **multi-leg** passes per-leg rows.
- [x] **Owner:** David  **Task:** **Performance guard** — **`V2_MAX_LOCKED_CHARGERS`** (`.env.example`, `lockValidation.ts`).

### Slice 1 — tests
- [ ] **Owner:** David  **Task:** **Automated E2E** for unknown vs infeasible lock (*optional follow-up*; **`TESTING.md`** step 5 documents manual).
- [ ] **Owner:** David  **Task:** **Multi-leg** lock API **manual** or E2E branch (*API supports; map UI is single-segment only*).
- [x] **Owner:** David  **Task:** **`npm run qa:smoke`** green.

### Slice 1 — web (map)
- [x] **Owner:** David  **Task:** **Tap-to-lock** (chargers + hotel); locked styling; **single-segment** trips only.
- [x] **Owner:** David  **Task:** **`POST /plan`** — `waypoints`, `includeCandidates`, lock fields; errors show **`message`** + **`errorCode`** in thrown message (*light polish: `classifyPlanError` by `errorCode*`).

### Slice 1 — exit criteria
- [x] **Owner:** David  **Single-leg** — **manual** + **`TESTING.md`**.
- [ ] **Owner:** David  **Multi-leg** + locks — **API** ready; **manual** or **E2E** when needed.
- [x] **Owner:** David  **Failure modes** — **`errorCode`** on responses; **`TESTING.md`** unknown-id repro.
- [ ] **Owner:** David  **`V2_CHERRY_PICKS`** / **`CI_SCOPE`** — review if a **locks-only** PR touches platform docs; **no change required** for pure feature PR.

---

## V2 Selective Expansion — plan after Slice 1

| Slice | What | Status |
|-------|------|--------|
| **Slice 2** | Mid-journey / **`replanFrom`** (PRD + API sketch) | **Design done** — implementation gated |
| **Slice 3** | **`GET /candidates`** | Gated — **`docs/V2_CHERRY_PICKS.md`** / product call |

---

## Execution Checklist (Plan-Eng-Review)

### Phase 1 — Reliability + Frontend (Now)
- [x] **Owner:** David  **Task:** F1 marker cleanup between plans *(clear on replan before `fetch`)*
- [x] **Owner:** David  **Task:** F2 readable basemap labels *(Carto Voyager `styleUrl`)*
- [x] **Owner:** David  **Task:** F3 highlighted selected route *(line + halo; artifacts cleared on replan)*
- [x] **Owner:** David  **Task:** long-route timeout/rescue handling *(total API + client caps; 408 / classified UI; per-stage envs in **`TESTING.md`**)*
- [x] **Owner:** David  **Task:** UI error-contract behavior *(timeout / network / HTTP distinctions in `classifyPlanError`)*

**Phase 1 exit criteria**
- [x] **Owner:** David  Re-plan map 5x in one session without stale markers/routes. *(Verified manual 2026-03-19; steps: **`TESTING.md` § Phase 1 exit verification**.)*
- [x] **Owner:** David  `Raleigh -> Greensboro` succeeds consistently. *(Verified manual 2026-03-19; **3000/3001 + CORS + `.env`**.)*
- [x] **Owner:** David  Long-haul requests return clear, classified failures (no generic `Failed to fetch` only — **improved**; providers can still fail for other reasons).
- [x] **Owner:** David  `/plan` has explicit per-stage timeout budgets (`geocode`, `NREL`, `Overpass`, `Valhalla`) plus total request cap documented and enforced. *(**`PLAN_TOTAL_TIMEOUT_MS`** + per-stage envs in **`TESTING.md`**; geocode / Valhalla polyline+legs / NREL / Overpass.)*

### Phase 2 — Local Mirror Architecture (A/B/C lanes)
- [x] **Owner:** David  **Task:** A1-A5 architecture decisions finalized and reviewed *(A1–A5 drafted in `docs/local-mirror-architecture.md`; sign-off checklist + D1–D3 specs completed)*
- [x] **Owner:** David  **Task:** B1-B4 snapshot/validation/fallback architecture finalized *(B1–B4 done in `docs/local-mirror-architecture.md`)*
- [x] **Owner:** David  **Task:** C3-C4 migration/rollback/observability architecture finalized
- [x] **Owner:** David  **Task:** C4 end-to-end smoke harness (`scripts/mirror-c4-longrun-smoke.mjs`) verified routing + required log events under `dual_read_compare` and `SOURCE_ROUTING_MODE_FORCE=remote_only`.
- [x] **Owner:** David  **Task:** C4 extended load smoke (`scripts/mirror-c4-load-smoke.mjs`) verified required log events under repeated `/plan` requests.

**Phase 2 exit criteria**
- [x] **Owner:** David  Source router ownership is centralized (single policy module design).
- [x] **Owner:** David  Typed error taxonomy and fallback matrix are complete (no silent-path gaps).
- [x] **Owner:** David  Snapshot lifecycle supports atomic promotion and rejection of invalid snapshots.
- [x] **Owner:** David  Dual-read compare and rollback trigger rules are explicit and testable on paper.
- [x] **Owner:** David  Matrix test requirement is explicit: `mode x failure` coverage (`remote-only`/`dual-read`/`local-primary` x `timeout`/`stale`/`schema mismatch`/`source unavailable`).

### Phase 3 — QA + CI Hardening
- [x] **Owner:** David  **Task:** one-command QA harness (WSL/Windows stable path) — **`npm run qa:smoke`** ([`scripts/qa-smoke-all.mjs`](scripts/qa-smoke-all.mjs)); browse/UI + Docker smoke remain per **`TESTING.md`**
- [x] **Owner:** David  **Task:** finalize CI gating plan with dev-infra timing — see [`docs/CI_SCOPE.md`](docs/CI_SCOPE.md) *(refine when CI provider is chosen)*
- [x] **Owner:** David  **Task:** connect SLO/error-budget checks to runbook/dashboard — *stub: log-based signals + pointers in [`docs/CI_SCOPE.md`](docs/CI_SCOPE.md) § SLO; dashboard TBD*

**Phase 3 exit criteria**
- [x] **Owner:** David  Single command runs **API build** + **core smoke** with clear pass/fail. *(`npm run qa:smoke`; full stack / Docker / UI — **`TESTING.md`** + `CI_SCOPE.md`.)*
- [x] **Owner:** David  CI/dev-infra decision recorded and gate scope agreed. *(Initial scope in **`docs/CI_SCOPE.md`**.)*
- [x] **Owner:** David  SLO/error-budget signals are visible enough for release readiness calls. *(v1: **JSON logs** + `CI_SCOPE.md` stub; formal dashboard optional.)*

### Deferred (explicit)
- **Provider contract/snapshot test suite expansion** — after mirror rollout starts.
- **Mirror resource/cost budgets** — after first prototype metrics.
- **Refresh observability as separate TODO** — bundled under local mirror epic.

## Infrastructure

### Local mirror architecture for NREL + Overpass (monthly refresh)
**What:** Design and phase in local data mirrors for NREL charger data and Overpass POI/hotel data (alongside existing local Valhalla), with monthly refresh jobs, schema/version validation, freshness SLA checks, and planner fallback behavior when data is stale/unavailable.  
**Why:** Removes external API/rate-limit bottlenecks and improves long-route reliability, QA repeatability, and predictable latency.  
**Context:** Target runtime is Synology NAS + Docker; keep external providers as fallback during rollout. Include phased migration (mirror bootstrap → dual-read/compare → local-primary → external-fallback).  
**Effort:** L (human) -> M (CC+gstack)  
**Priority:** P1  
**Depends on:** A1-A5 architecture decisions (provider adapters/caching follow these contracts).

### Local mirror architecture execution lane (architecture only)
**What:** Execute architecture design only (no implementation yet) for the local mirror epic in dependency order.  
**Why:** Prevents implementation thrash and locks contracts/fallback behavior before coding.  
**Context:** This lane decomposes the local mirror epic into architecture deliverables A1-D3. **Working draft:** `docs/local-mirror-architecture.md` — **A1–A5 complete**; **D3** still to fill.
**Effort:** L (human) -> M (CC+gstack)  
**Priority:** P0  
**Depends on:** None

### A1) Canonical data contracts for planner inputs
**What:** Define canonical schemas for charger data, POI/hotel data, and snapshot metadata consumed by planner logic regardless of source (local or remote).  
**Why:** Eliminates source-specific branching and integration drift.  
**Context:** Contract boundary all providers normalize to before planner orchestration.  
**Status:** **Drafted** in `docs/local-mirror-architecture.md` §A1 (2026-03-19).  
**Effort:** M (human) -> S (CC+gstack)  
**Priority:** P0  
**Depends on:** None

### A2) Typed error taxonomy for provider and mirror paths
**What:** Define explicit error classes and mapping rules (`Timeout`, `StaleSnapshot`, `SchemaMismatch`, `SourceUnavailable`, `ValidationFailure`).  
**Why:** Enables deterministic fallback and prevents silent failures.  
**Context:** Shared across provider adapters and source router policy. Implemented as `SourceError` / `SourceErrorCode` in doc.  
**Status:** **Drafted** in `docs/local-mirror-architecture.md` §A2 (2026-03-19).  
**Effort:** S (human) -> S (CC+gstack)  
**Priority:** P0  
**Depends on:** A1

### A3) Provider interfaces (source-agnostic contracts)
**What:** Define `ChargerProvider` and `PoiProvider` interfaces with strict input/output/error contracts and timeout semantics.  
**Why:** Decouples planner orchestration from source implementation details.  
**Context:** Remote APIs and local mirrors must be interchangeable behind these interfaces.  
**Status:** **Drafted** in `docs/local-mirror-architecture.md` §A3 (2026-03-19).  
**Effort:** M (human) -> S (CC+gstack)  
**Priority:** P0  
**Depends on:** A1, A2

### A4) Source routing architecture and mode policy
**What:** Define routing modes and decision tree (`remote-only`, `dual-read-compare`, `local-primary-fallback-remote`) and source metadata output.  
**Why:** Provides safe migration and controlled cutover path.  
**Context:** Router policy drives runtime source choice and fallback behavior.  
**Status:** **Drafted** in `docs/local-mirror-architecture.md` §A4 (2026-03-19).  
**Effort:** M (human) -> S (CC+gstack)  
**Priority:** P0  
**Depends on:** A2, A3

### A5) Freshness SLA and staleness policy
**What:** Define max snapshot age, staleness thresholds, and behavior when local data is stale.  
**Why:** Guarantees local data quality, not just local availability.  
**Context:** Drives promotion gates, fallback triggers, and health checks.  
**Status:** **Drafted** in `docs/local-mirror-architecture.md` §A5 (2026-03-19).  
**Effort:** S (human) -> S (CC+gstack)  
**Priority:** P0  
**Depends on:** A1, A4

### B1) Snapshot lifecycle architecture (atomic promotion)
**What:** Define snapshot lifecycle (`staging -> validate -> promote(active) -> archive`) with atomic active-pointer switch.  
**Why:** Prevents partial/corrupt refresh from becoming active.  
**Context:** Required for safe monthly refresh operations.  
**Effort:** M (human) -> S (CC+gstack)  
**Priority:** P1  
**Depends on:** A1, A5

### B2) Monthly refresh pipeline architecture (NREL + Overpass)
**What:** Define refresh orchestration with idempotency/restart-safety and source-specific ingest boundaries.  
**Why:** Creates predictable no-limits local data refresh operations.  
**Context:** Align with Synology NAS + Docker scheduling/runtime constraints.  
**Effort:** L (human) -> M (CC+gstack)  
**Priority:** P1  
**Depends on:** B1

### B3) Validation architecture before snapshot promotion
**What:** Define schema/version checks, data sanity checks, and freshness checks required before promotion.  
**Why:** Catches bad snapshots before planner impact.  
**Context:** Validation gates run in staging snapshot lifecycle step.  
**Effort:** M (human) -> S (CC+gstack)  
**Priority:** P1  
**Depends on:** B1, B2

### B4) Failure and fallback behavior matrix
**What:** Define exact fallback action per failure mode across local and remote paths, including user/debug impact.  
**Why:** Ensures predictable behavior under degraded conditions.  
**Context:** Uses typed errors and routing modes for deterministic fallback.  
**Effort:** M (human) -> S (CC+gstack)  
**Priority:** P1  
**Depends on:** A2, A4, B3

### C1) Dual-read compare architecture for migration
**What:** Define dual-read strategy, divergence thresholds, and mismatch handling/reporting.  
**Why:** Builds confidence in local mirrors before local-primary cutover.  
**Context:** Used during phased rollout while external providers remain fallback.  
**Effort:** M (human) -> S (CC+gstack)  
**Priority:** P1  
**Depends on:** A4, B4

### C2) Promotion criteria to local-primary mode
**What:** Define objective gates (latency/error/divergence/freshness) required to switch to local-primary.  
**Why:** Prevents premature cutover and regressions.  
**Context:** Criteria should align with `/plan` SLO/error budget targets.  
**Effort:** S (human) -> S (CC+gstack)  
**Priority:** P1  
**Depends on:** C1

### C3) Rollback architecture and incident triggers
**What:** Define immediate rollback path to remote-primary and trigger conditions that activate it.  
**Why:** Reduces MTTR when local data path regresses.  
**Context:** Must be operable via config/flag without code changes during incidents.  
**Effort:** S (human) -> S (CC+gstack)  
**Priority:** P1  
**Depends on:** C2

### C4) Observability contract for source selection and fallback
**What:** Define required logs/metrics/traces for source used, fallback reason, stage timings, and snapshot age.  
**Why:** Makes failures diagnosable and SLOs measurable.  
**Context:** Propagate `requestId` through planner/provider paths for correlation.  
**Effort:** M (human) -> S (CC+gstack)  
**Priority:** P1  
**Depends on:** A2, A4, B4

### D1) Synology/Docker deployment topology spec (architecture)
**What:** Define service boundaries, storage layout, and job placement for local mirrors in target infra.  
**Why:** Avoids architecture that fails under real deployment constraints.  
**Context:** Align with Cloudflare/Synology dev-infra roadmap.  
**Effort:** M (human) -> S (CC+gstack)  
**Priority:** P2  
**Depends on:** B2, C4

### D2) Config and secret model for source modes
**What:** Define env/config matrix for mode control, timeout budgets, and secret boundaries/rotation expectations.  
**Why:** Prevents config drift and unsafe runtime transitions.  
**Context:** Supports phased rollout and safe rollback operations.  
**Effort:** S (human) -> S (CC+gstack)  
**Priority:** P2  
**Depends on:** A4, D1

### D3) Architecture sign-off checklist (pre-implementation gate)
**What:** Define architecture completion checklist required before decomposition into implementation tickets.  
**Why:** Freezes design intent and avoids mid-implementation thrash.  
**Context:** Includes contract completeness, fallback determinism, rollout/rollback readiness, and observability coverage.  
**Effort:** S (human) -> S (CC+gstack)  
**Priority:** P2  
**Depends on:** A1-D2

### Provider adapters + typed errors + caching
**What:** Implement NREL/Valhalla/Overpass adapters behind typed interfaces with bounded caching and standardized retry/backoff.  
**Why:** Prevent silent failures, rate-limit pain, and “least-time” bugs caused by inconsistent upstream payload handling.  
**Context:** No existing scaffolding found yet; implement clean boundaries first.  
**Effort:** XL (human) -> L (CC+gstack)  
**Priority:** P0  
**Depends on:** A1-A5 architecture decisions (contracts + error taxonomy + interfaces before adapter rollout).

### Structured request logging (requestId) for `/plan`
**What:** Add structured logs for each `/plan` request (including `requestId`) and propagate through geocode/NREL/Overpass/Valhalla calls; include timing + why a stop was inserted/omitted.  
**Why:** Without per-provider, per-request diagnostics, it is hard to debug “overnight missing sleep” flakiness and intermittent API failures at 3am.  
**Context:** **MVP done:** `plan_request_start` / `plan_request_end` / `plan_request_error` JSON logs + `requestId` on `/plan`; planner threads `requestId` in orchestration. **Still open:** per-provider log lines, stage timings in logs, “why stop inserted/omitted” verbosity.  
**Effort:** M (human) -> M (CC+gstack)  
**Priority:** P1  
**Depends on:** None

## Frontend

### Frontend execution lane (P0)
**What:** Execute map UX essentials in strict order: marker cleanup -> readable basemap -> highlighted route.  
**Why:** These directly improve clarity/trust during trip planning and prevent map-state regressions during repeated runs.  
**Context:** Keep this as a fast execution lane parallel to architecture planning, with visual QA after each step.  
**Effort:** M (human) -> S (CC+gstack)  
**Priority:** P0  
**Depends on:** None

### F1) MapLibre marker cleanup between plans
**What:** Clear previous plan markers on each `Plan Trip` click so repeated planning does not accumulate stale markers.  
**Why:** Prevents map clutter and degraded UX/performance during iterative planning.  
**Context:** **`Done`:** `clearMapPlanArtifacts()` on plan start + effect cleanup when `plan` clears — `web/src/app/map/page.tsx`.  
**Effort:** S (human) -> S (CC+gstack)  
**Priority:** P0  
**Depends on:** None

### F2) MapLibre city/highway basemap labels
**What:** Use a style with clearly readable city/highway labels (or add label layers) for route context.  
**Why:** Improves geographic orientation and user trust in itinerary positioning.  
**Context:** **`Done`:** Carto Voyager GL style URL — `web/src/app/map/page.tsx`.  
**Effort:** S (human) -> S (CC+gstack)  
**Priority:** P0  
**Depends on:** F1

### F3) Highlight selected route on map
**What:** Ensure selected route is visually prominent and previous route artifacts are cleared on replans.  
**Why:** Users need clear confirmation of the active itinerary beyond markers alone.  
**Context:** **`Done`:** route line + halo; replan clears sources/layers via `clearMapPlanArtifacts` — `web/src/app/map/page.tsx`.  
**Effort:** M (human) -> S (CC+gstack)  
**Priority:** P0  
**Depends on:** F1, F2

### Legacy frontend items (replaced)
**Note:** Earlier duplicate entries for marker cleanup, basemap labels, and route highlight were removed; use canonical **`F1` / `F2` / `F3`** above.

## Planner / QA

### Reduce overnight invariant flakiness
**What:** Improve determinism for the overnight + Holiday Inn Express “sleep insertion” invariant (Overpass anchor+hotel discovery, anchor selection, and time-threshold edge behavior), and/or harden the functional E2E runner to retry/re-sample when external services return empty/partial results.  
**Why:** The functional overnight case can fail even when totals imply an overnight should exist, leading to inconsistent test outcomes and user-facing inconsistency.  
**Context:** Planner hardening + `/plan` logging landed in recent commits; **E2E overnight case passes with `SPAWN_SERVER=true`**. **Smoke-only** runs (existing dev API, no per-case env) can still false-fail — see **`TESTING.md` §2**. Ongoing: external API variance, richer retries.  
**Effort:** M (human) -> M (CC+gstack)  
**Priority:** P0  
**Depends on:** Infrastructure TODO (optional): typed adapter boundaries + caching can reduce flakiness.

### Add long-route timeout resilience and clearer UI errors
**What:** Add explicit timeout handling and user-facing messaging for long `/plan` requests (especially cross-country routes), including distinct messages for provider timeout vs generic fetch/network failure.  
**Why:** QA showed `Plan Trip` can end as `Failed to fetch` for heavy routes, which hides the root cause and looks like a frontend bug even when providers are slow/unresponsive.  
**Context:** **`Done` (MVP):** `withTimeout` + **408** + `planner_timeout` on API; client abort + `classifyPlanError` on web — see **`TESTING.md`** env table. **Still open:** per-stage timeouts inside `planTrip` as separate user-visible stages.  
**Effort:** M (human) -> M (CC+gstack)  
**Priority:** P0  
**Depends on:** Structured request logging (requestId) for `/plan` (recommended for diagnosis).

### Profile and optimize long-haul planner latency
**What:** Instrument and profile the `Raleigh -> Seattle` style planning path to identify slow stages (geocode, NREL, Overpass, Valhalla), then add targeted mitigations (timeouts, concurrency tuning, cache usage, fallback strategy).  
**Why:** Long-haul routes are currently the dominant source of QA instability and user-visible failures/timeouts.  
**Context:** Planner orchestration in `api/src/planner/planTrip.ts`, service clients under `api/src/services/*`, and `/plan` request logs.  
**Effort:** L (human) -> M (CC+gstack)  
**Priority:** P1  
**Depends on:** Provider adapters + typed errors + caching.

### Stabilize browser QA runtime in WSL (browse.exe parity)
**What:** Make packaged `browse.exe` reliable in WSL (matching source CLI behavior) so multi-step `/qa` flows persist browser state without manual Bun fallback.  
**Why:** Current QA often requires source CLI + `LD_LIBRARY_PATH` workaround, reducing repeatability and making scripted `/qa` runs brittle.  
**Context:** gstack browse runtime behavior in this repo’s WSL environment; fallback steps documented in `TESTING.md`.  
**Effort:** M (human) -> M (CC+gstack)  
**Priority:** P1  
**Depends on:** Validate Playwright Linux shared-library path setup.

## Delivery / CI-CD

### Decide CI pipeline + dev infra deployment timing
**What:** Create/define the CI pipeline and deployment workflow for pushing changes to your development infrastructure (Cloudflare Zero Trust tunnels + Synology Docker environment).  
**Why:** Without a defined CI/deploy path, integration regressions can slip through and dev infra changes can stall on coordination.  
**Context:** Your infra model is documented under `C:\Users\david\Dev\Infrastructure/` (Synology + Cloudflare tunnels). This TODO should capture when to implement CI, what triggers to use, and what “first deploy” includes (API + web).  
**Effort:** M (human) -> M (CC+gstack)  
**Priority:** P1  
**Depends on:** Confirm repository secrets required for registry + any tunnel/access setup.

