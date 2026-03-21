# CI / gate scope (proposal)

**Status:** Decision record — adjust when dev-infra timing is fixed.

## Goals

- Catch TypeScript / build breaks before merge.
- Run fast, dependency-light smoke tests that do not require Docker Desktop, Synology, or a running long-lived dev server (those scripts spawn ephemeral APIs themselves).

## Suggested first gate (minimal)

| Step | Command | Notes |
|------|---------|--------|
| API compile | `npm -w api run build` | `tsc` |
| Web compile | `npm -w web run build` | Optional second stage if CI time allows |
| Automated smoke | `npm run qa:smoke` | `scripts/qa-smoke-all.mjs`: API build + `e2e-cors-functional.mjs` + `e2e-plan-log-contract.mjs` |

## Deferred / manual

- **Docker Compose** (`docker-compose.mirror.yml`, `scripts/d1-verify-mirror.mjs`): run on demand or on a self-hosted runner with Docker.
- **gstack browse / UI screenshots:** manual or dedicated QA job per `TESTING.md`.
- **Mirror C4 longrun / load** (`scripts/mirror-c4-*.mjs`): optional nightly or pre-release; may need `NREL_API_KEY` and Valhalla.

## Secrets in CI

- Do **not** commit API keys. For NREL-dependent jobs, use CI secret stores and inject `NREL_API_KEY` only for workflows that need it.

## SLO / error budget (stub)

Until a dashboard exists, use **structured JSON logs** from the API (grep/journal):

- `plan_request_start` / `plan_request_end` / `plan_request_error` — latency and outcome.
- `plan_source_selection`, `plan_fallback`, `mirror_staleness`, `dual_read_compare`, `rollback_triggered` — source routing health ([`local-mirror-architecture.md`](local-mirror-architecture.md) §C4).

Define budgets (p95 `/plan` duration, fallback rate) in team process; wire metrics later.

## References

- [`TESTING.md`](../TESTING.md) — full QA matrix and env table.
- [`TODOS.md`](../TODOS.md) — Phase 3 exit criteria.
