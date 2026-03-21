# D1 Runbook: Docker Mirror Refresh + Planner Consumption

## Goal
Verify that your Docker topology can:
1. Refresh local mirror artifacts (write-side)
2. Produce a valid `api/mirror/current/manifest.json` (B1/B3 promotion outcome)
3. Serve `/plan` using `SOURCE_ROUTING_MODE=local_primary_fallback_remote` (read-side)
4. Emit correlated routing/mirror observability logs (`plan_source_selection`, `mirror_staleness`) for a single request id

## Prerequisites
- Docker + `docker compose` (or `docker-compose`) installed
- `NREL_API_KEY` set in your shell environment (refresh worker needs it)
- Sufficient disk space for mirror snapshots and NDJSON artifacts

## Quick run
From repo root:
```bash
node scripts/d1-verify-mirror.mjs
```

Optional:
- Keep containers running for debugging:
  - `KEEP_RUNNING=true node scripts/d1-verify-mirror.mjs`

## What the script validates
- `api/mirror/current/manifest.json` exists and `schemaVersion === "1.0.0"`
- A short `/plan` call returns JSON (success or error is allowed)
- Docker logs for the `planner-api` container contain, correlated by the script-generated `requestId`:
  - `plan_source_selection` where:
    - `effectiveSourceRoutingMode === "local_primary_fallback_remote"`
    - `chargersTier === "mirror"`
    - `poisTier === "mirror"`
  - `mirror_staleness` emitted (mirror was consulted)

## Troubleshooting
- If refresh fails, check `mirror-refresh-once` container logs:
  - run the command again with `KEEP_RUNNING=true` and inspect:
    - `docker compose -f docker-compose.mirror.yml logs --tail 200 mirror-refresh-once`
- If manifest is missing:
  - confirm `./api/mirror` is bind-mounted correctly in `docker-compose.mirror.yml`.
- If `plan_source_selection` or `mirror_staleness` are missing:
  - confirm planner container is reachable at `http://localhost:3001`
  - confirm `DEPLOYMENT_ENV` / `SOURCE_ROUTING_MODE` are set as expected.

### Synology NAS: `NREL_API_KEY` empty in planner (`/health` shows `nrelApiKeyPresent: false`)

1. **Confirm the env file on disk** (same path Compose uses):
   - `test -f /volume1/docker/Travel-Routing/.env`
   - `grep -E '^NREL_API_KEY=' /volume1/docker/Travel-Routing/.env` (do not paste the value)

2. **Confirm Docker can read the key** (isolates file format vs Compose):
   - `docker run --rm --env-file /volume1/docker/Travel-Routing/.env alpine sh -c 'test -n "$NREL_API_KEY" && echo set || echo empty'`

3. **Compose merge rule:** anything under `environment:` overrides `env_file`. Do **not** keep `NREL_API_KEY: ${NREL_API_KEY}` in `environment` if `${NREL_API_KEY}` interpolates empty — it overrides the file. Prefer `env_file` only, or use `docker compose --env-file /volume1/docker/Travel-Routing/.env` so interpolation sees the key.

4. On NAS deploy copies, `env_file` may use an **absolute path** (`/volume1/docker/Travel-Routing/.env`) so Synology never resolves `.env` relative to the wrong working directory.

