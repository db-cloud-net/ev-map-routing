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

### Synology NAS: POI Services on `prod-network` (port 8010)

When the **POI Services** stack runs as a container on the same user-defined network as **`planner-api`** (e.g. external **`prod-network`**), set:

- **`POI_SERVICES_BASE_URL=http://poi:8010`** — Docker DNS resolves the **`poi`** service name; **8010** is the port the POI API listens on inside that network (match your Compose service `ports` / `expose`).

From the host (not inside a container), use `localhost` only if port 8010 is published to the host; from **`planner-api`**, prefer **`http://poi:8010`**. Confirm with:

- `docker exec -it <planner-api-container> wget -qO- http://poi:8010/health` (or `curl` if installed)

If `/plan` never hits POI, verify **`USE_POI_SERVICES_CORRIDOR`** is not `false` and check **`debug.providerCalls.poi_services`** on a successful response.

#### Validating hotel ↔ DCFC proximity in shards (offline)

The POI Services repo ships **`experiments/proximity_sweep.py`**, which scans **`/data/shards`** (SQLite) directly — no HTTP. Example (from repo root, with the same **`poi_data`** volume you use for builds):

```bash
docker run --rm \
  -v "$(pwd)/poi_data:/data" \
  -v "$(pwd)/experiments:/app/experiments" \
  poi-updater \
  python /app/experiments/proximity_sweep.py /data/shards
```

Example output shape (full US HIE + DCFC corpus): **~2237 hotels**, **~15075 chargers**, then cumulative **hotels with a nearest DCFC within** each yard threshold — e.g. **67 @ 100 yd**, **135 @ 200 yd**, … **1338 @ 2640 yd** (~59.8% of hotels), plus histogram and top closest / most isolated pairs.

Use this when **`GET /health`** shows large **`total_*`** counts but **`GET /pois`** / **`GET /pois/hotel-charger-pairs`** / **`POST /corridor/query`** return **empty** results: the **runtime API container** must mount the **same** populated **`/data/shards/*.db`** (and **`manifest.json`**) as **`DATA_DIR`** (default **`/data`**). **`/health`** reads **`manifest.json`** only; spatial endpoints open the SQLite files. If the mount is missing or points at an empty directory, health can still look “healthy” while every query returns **zero rows**.

**HTTP regression check (hotels + DCFC + L2 by `power_kw`):** from Travel-Routing repo, `POI_SERVICES_BASE_URL=http://poi:8010` (or your NAS host:port) — **`node scripts/poi-container-data-validation.mjs`**. Exit **0** when spatial data returns; **2** when manifest claims data but `/pois` is empty (mount issue).

**Planner-side POI review log (periodic data QA):** when the planner runs with **`POI_REVIEW_LOG=true`**, it writes NDJSON review lines (default **`logs/poi-corridor-review.ndjson`**) for events such as **`sleep_dcfc_corridor_miss`** and resolution outcomes. Summarize with **`node scripts/poi-review-log-summary.mjs`** after POI shard refreshes to spot coverage drift quickly.

