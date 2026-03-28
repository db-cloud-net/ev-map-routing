# D1 Runbook (deploy notes)

> **Mirror stack removed:** The **`docker-compose.mirror.yml`** layout (planner + `mirror-refresh-once`) and **`scripts/d1-verify-mirror.mjs`** were deleted. Corridor data for **`/plan`** comes from **POI Services** when **`POI_SERVICES_BASE_URL`** is set — see **[`deprecate-nrel-overpass-mirror-travel-routing-adr.md`](./designs/deprecate-nrel-overpass-mirror-travel-routing-adr.md)**.

## Synology NAS: POI Services on `prod-network` (port 8010)

When the **POI Services** stack runs as a container on the same user-defined network as the **planner API** (e.g. external **`prod-network`**), set:

- **`POI_SERVICES_BASE_URL=http://poi:8010`** — Docker DNS resolves the **`poi`** service name; **8010** is the port the POI API listens on inside that network (match your Compose service `ports` / `expose`).

From the host (not inside a container), use `localhost` only if port 8010 is published to the host; from the **planner** container, prefer **`http://poi:8010`**. Confirm with:

- `docker exec -it <planner-container> wget -qO- http://poi:8010/health` (or `curl` if installed)

If `/plan` never hits POI, verify **`USE_POI_SERVICES_CORRIDOR`** is not `false` and check **`debug.providerCalls.poi_services`** on a successful response.

#### Validating hotel ↔ DCFC proximity in shards (offline)

The POI Services repo may ship proximity experiments that scan **`/data/shards`** (SQLite) directly — no HTTP from Travel-Routing. Use that repo’s docs for offline QA.
