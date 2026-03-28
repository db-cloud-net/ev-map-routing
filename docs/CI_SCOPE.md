# CI / gate scope (proposal)

> **Note:** Default PR gates (`qa:smoke`) assume **POI Services + Valhalla**-style envs per **`TESTING.md`**. The legacy mirror / NREL planner paths are removed from this repo.

**Status:** Decision record — adjust when dev-infra timing is fixed.

**Last verified on `main` (2026-03-24):** `npm -w api run build` · `npm run qa:smoke` · `npm -w web run build` — all pass *(local)*.

## Goals

- Catch TypeScript / build breaks before merge.
- Run fast, dependency-light smoke tests that do not require Docker Desktop, Synology, or a running long-lived dev server (those scripts spawn ephemeral APIs themselves).

## Suggested first gate (minimal)

| Step | Command | Notes |
|------|---------|--------|
| API compile | `npm -w api run build` | `tsc` |
| Web compile | `npm -w web run build` | Optional second stage if CI time allows |
| Automated smoke | `npm run qa:smoke` | `scripts/qa-smoke-all.mjs`: API build + `e2e-cors-functional.mjs` + `e2e-plan-log-contract.mjs` + `e2e-plan-job.mjs` + `e2e-replan-smoke.mjs` + `e2e-candidates-smoke.mjs` + `e2e-route-preview-smoke.mjs` + `e2e-multileg-locks-smoke.mjs` |

## Deferred / manual

- **`scripts/poi-services-corridor-spike.mjs`** — optional latency check against a running POI Services instance (`POI_SERVICES_BASE_URL`); not part of the default PR gate.
- **Docker / NAS deploy:** follow **`docs/d1-runbook.md`** for POI + planner networking; there is no mirror compose in this repo.
- **gstack browse / UI screenshots:** manual or dedicated QA job per `TESTING.md`.

## Secrets in CI

- Do **not** commit API keys.

## SLO / error budget (stub)

Until a dashboard exists, use **structured JSON logs** from the API (grep/journal):

- `plan_request_start` / `plan_request_end` / `plan_request_error` — latency and outcome.
- `plan_source_selection` — POI-only source selection (see [`deprecate-nrel-overpass-mirror-travel-routing-adr.md`](designs/deprecate-nrel-overpass-mirror-travel-routing-adr.md)).

Define budgets (p95 `/plan` duration, fallback rate) in team process; wire metrics later.

## References

- [`TESTING.md`](../TESTING.md) — full QA matrix and env table.
- [`TODOS.md`](../TODOS.md) — Phase 3 exit criteria.
