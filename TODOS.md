# TODOS

## Infrastructure

### Provider adapters + typed errors + caching
**What:** Implement NREL/Valhalla/Overpass adapters behind typed interfaces with bounded caching and standardized retry/backoff.  
**Why:** Prevent silent failures, rate-limit pain, and “least-time” bugs caused by inconsistent upstream payload handling.  
**Context:** No existing scaffolding found yet; implement clean boundaries first.  
**Effort:** XL (human) -> L (CC+gstack)  
**Priority:** P0  
**Depends on:** None

### Structured request logging (requestId) for `/plan`
**What:** Add structured logs for each `/plan` request (including `requestId`) and propagate through geocode/NREL/Overpass/Valhalla calls; include timing + why a stop was inserted/omitted.
**Why:** Without per-provider, per-request diagnostics, it is hard to debug “overnight missing sleep” flakiness and intermittent API failures at 3am.
**Context:** Current server logging is minimal (`api listening on ...`), while planner debug is returned only to the UI.
**Effort:** M (human) -> M (CC+gstack)
**Priority:** P1
**Depends on:** None

## Frontend

### MapLibre marker cleanup between plans
**What:** Clear previous plan markers on each “Plan Trip” click so repeated planning doesn’t accumulate stale markers and degrade UX/performance.  
**Why:** Current behavior rebuilds markers without reliably removing old ones, causing map clutter and potential slowdowns.  
**Context:** See `web/src/app/map/page.tsx` marker rendering logic inside the `useEffect` driven by `plan`.  
**Effort:** S (human) -> S (CC+gstack)  
**Priority:** P1  
**Depends on:** None

### MapLibre city/highway basemap (labels)
**What:** Use a map style that shows clearly readable city/highway labels (or add an additional label layer) instead of the current demo tiles.  
**Why:** Helps users orient quickly and trust the displayed itinerary context.  
**Context:** See `web/src/app/map/page.tsx` where `styleUrl` is set to `https://demotiles.maplibre.org/style.json`.  
**Effort:** S (human) -> S (CC+gstack)  
**Priority:** P2  
**Depends on:** None

### Highlight selected route on map
**What:** Ensure the route drawn after planning is clearly highlighted (and previous route artifacts cleared), optionally distinguishing drive vs connectors/overnight legs if geometry exists.  
**Why:** Users need visual confirmation of the selected itinerary, not just pins/markers.  
**Context:** See `web/src/app/map/page.tsx` where route layers/sources are added/removed around `plan`.  
**Effort:** M (human) -> M (CC+gstack)  
**Priority:** P2  
**Depends on:** Marker cleanup (optional)

## Planner / QA

### Reduce overnight invariant flakiness
**What:** Improve determinism for the overnight + Holiday Inn Express “sleep insertion” invariant (Overpass anchor+hotel discovery, anchor selection, and time-threshold edge behavior), and/or harden the functional E2E runner to retry/re-sample when external services return empty/partial results.  
**Why:** The functional overnight case can fail even when totals imply an overnight should exist, leading to inconsistent test outcomes and user-facing inconsistency.  
**Context:** QA invariant lives in `TESTING.md` under scenario A; planner logic in `api/src/planner/planTrip.ts`; functional runner in `scripts/e2e-plan-functional.mjs`.  
**Effort:** M (human) -> M (CC+gstack)  
**Priority:** P0  
**Depends on:** Infrastructure TODO (optional): typed adapter boundaries + caching can reduce flakiness.

## Delivery / CI-CD

### Decide CI pipeline + dev infra deployment timing
**What:** Create/define the CI pipeline and deployment workflow for pushing changes to your development infrastructure (Cloudflare Zero Trust tunnels + Synology Docker environment).  
**Why:** Without a defined CI/deploy path, integration regressions can slip through and dev infra changes can stall on coordination.  
**Context:** Your infra model is documented under `C:\Users\david\Dev\Infrastructure/` (Synology + Cloudflare tunnels). This TODO should capture when to implement CI, what triggers to use, and what “first deploy” includes (API + web).  
**Effort:** M (human) -> M (CC+gstack)  
**Priority:** P1  
**Depends on:** Confirm repository secrets required for registry + any tunnel/access setup.

