# TODOS

## Execution Checklist (Plan-Eng-Review)

### Phase 1 — Reliability + Frontend (Now)
- [ ] **Owner:** ______  **Task:** F1 marker cleanup between plans
- [ ] **Owner:** ______  **Task:** F2 readable basemap labels
- [ ] **Owner:** ______  **Task:** F3 highlighted selected route
- [ ] **Owner:** ______  **Task:** long-route timeout/rescue handling with explicit stage budgets
- [ ] **Owner:** ______  **Task:** UI error-contract behavior (timeout/provider/network distinctions)

**Phase 1 exit criteria**
- [ ] Re-plan map 5x in one session without stale markers/routes.
- [ ] `Raleigh -> Greensboro` succeeds consistently.
- [ ] Long-haul requests return clear, classified failures (no generic `Failed to fetch`).
- [ ] `/plan` has explicit per-stage timeout budgets (`geocode`, `NREL`, `Overpass`, `Valhalla`) plus total request cap documented and enforced.

### Phase 2 — Local Mirror Architecture (A/B/C lanes)
- [ ] **Owner:** ______  **Task:** A1-A5 architecture decisions finalized and reviewed
- [ ] **Owner:** ______  **Task:** B1-B4 snapshot/validation/fallback architecture finalized
- [ ] **Owner:** ______  **Task:** C1-C4 migration/rollback/observability architecture finalized

**Phase 2 exit criteria**
- [ ] Source router ownership is centralized (single policy module design).
- [ ] Typed error taxonomy and fallback matrix are complete (no silent-path gaps).
- [ ] Snapshot lifecycle supports atomic promotion and rejection of invalid snapshots.
- [ ] Dual-read compare and rollback trigger rules are explicit and testable on paper.
- [ ] Matrix test requirement is explicit: `mode x failure` coverage (`remote-only`/`dual-read`/`local-primary` x `timeout`/`stale`/`schema mismatch`/`source unavailable`).

### Phase 3 — QA + CI Hardening
- [ ] **Owner:** ______  **Task:** one-command QA harness (WSL/Windows stable path)
- [ ] **Owner:** ______  **Task:** finalize CI gating plan with dev-infra timing
- [ ] **Owner:** ______  **Task:** connect SLO/error-budget checks to runbook/dashboard

**Phase 3 exit criteria**
- [ ] Single command runs setup + smoke + artifacts with clear pass/fail.
- [ ] CI/dev-infra decision recorded and gate scope agreed.
- [ ] SLO/error-budget signals are visible enough for release readiness calls.

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
**Context:** This lane decomposes the local mirror epic into architecture deliverables A1-D3.  
**Effort:** L (human) -> M (CC+gstack)  
**Priority:** P0  
**Depends on:** None

### A1) Canonical data contracts for planner inputs
**What:** Define canonical schemas for charger data, POI/hotel data, and snapshot metadata consumed by planner logic regardless of source (local or remote).  
**Why:** Eliminates source-specific branching and integration drift.  
**Context:** Contract boundary all providers normalize to before planner orchestration.  
**Effort:** M (human) -> S (CC+gstack)  
**Priority:** P0  
**Depends on:** None

### A2) Typed error taxonomy for provider and mirror paths
**What:** Define explicit error classes and mapping rules (`Timeout`, `StaleSnapshot`, `SchemaMismatch`, `SourceUnavailable`, `ValidationFailure`).  
**Why:** Enables deterministic fallback and prevents silent failures.  
**Context:** Shared across provider adapters and source router policy.  
**Effort:** S (human) -> S (CC+gstack)  
**Priority:** P0  
**Depends on:** A1

### A3) Provider interfaces (source-agnostic contracts)
**What:** Define `ChargerProvider` and `PoiProvider` interfaces with strict input/output/error contracts and timeout semantics.  
**Why:** Decouples planner orchestration from source implementation details.  
**Context:** Remote APIs and local mirrors must be interchangeable behind these interfaces.  
**Effort:** M (human) -> S (CC+gstack)  
**Priority:** P0  
**Depends on:** A1, A2

### A4) Source routing architecture and mode policy
**What:** Define routing modes and decision tree (`remote-only`, `dual-read-compare`, `local-primary-fallback-remote`) and source metadata output.  
**Why:** Provides safe migration and controlled cutover path.  
**Context:** Router policy drives runtime source choice and fallback behavior.  
**Effort:** M (human) -> S (CC+gstack)  
**Priority:** P0  
**Depends on:** A2, A3

### A5) Freshness SLA and staleness policy
**What:** Define max snapshot age, staleness thresholds, and behavior when local data is stale.  
**Why:** Guarantees local data quality, not just local availability.  
**Context:** Drives promotion gates, fallback triggers, and health checks.  
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
**Context:** Current server logging is minimal (`api listening on ...`), while planner debug is returned only to the UI.  
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
**Context:** `web/src/app/map/page.tsx` marker rendering inside `useEffect` driven by `plan`.  
**Effort:** S (human) -> S (CC+gstack)  
**Priority:** P0  
**Depends on:** None

### F2) MapLibre city/highway basemap labels
**What:** Use a style with clearly readable city/highway labels (or add label layers) for route context.  
**Why:** Improves geographic orientation and user trust in itinerary positioning.  
**Context:** `web/src/app/map/page.tsx` `styleUrl` map initialization.  
**Effort:** S (human) -> S (CC+gstack)  
**Priority:** P0  
**Depends on:** F1

### F3) Highlight selected route on map
**What:** Ensure selected route is visually prominent and previous route artifacts are cleared on replans.  
**Why:** Users need clear confirmation of the active itinerary beyond markers alone.  
**Context:** `web/src/app/map/page.tsx` route layers/sources around `plan`.  
**Effort:** M (human) -> S (CC+gstack)  
**Priority:** P0  
**Depends on:** F1, F2

### Legacy frontend items (replaced)
**Note:** Earlier duplicate entries for marker cleanup, basemap labels, and route highlight were removed; use canonical **`F1` / `F2` / `F3`** above.

## Planner / QA

### Reduce overnight invariant flakiness
**What:** Improve determinism for the overnight + Holiday Inn Express “sleep insertion” invariant (Overpass anchor+hotel discovery, anchor selection, and time-threshold edge behavior), and/or harden the functional E2E runner to retry/re-sample when external services return empty/partial results.  
**Why:** The functional overnight case can fail even when totals imply an overnight should exist, leading to inconsistent test outcomes and user-facing inconsistency.  
**Context:** QA invariant lives in `TESTING.md` under scenario A; planner logic in `api/src/planner/planTrip.ts`; functional runner in `scripts/e2e-plan-functional.mjs`.  
**Effort:** M (human) -> M (CC+gstack)  
**Priority:** P0  
**Depends on:** Infrastructure TODO (optional): typed adapter boundaries + caching can reduce flakiness.

### Add long-route timeout resilience and clearer UI errors
**What:** Add explicit timeout handling and user-facing messaging for long `/plan` requests (especially cross-country routes), including distinct messages for provider timeout vs generic fetch/network failure.  
**Why:** QA showed `Plan Trip` can end as `Failed to fetch` for heavy routes, which hides the root cause and looks like a frontend bug even when providers are slow/unresponsive.  
**Context:** Frontend request handling in `web/src/app/map/page.tsx`; API planner path in `api/src/server.ts` and `api/src/planner/planTrip.ts`.  
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

