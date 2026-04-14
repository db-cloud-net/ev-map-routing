# D1 Runbook (deploy notes)

> **Mirror stack removed:** The **`docker-compose.mirror.yml`** layout (planner + `mirror-refresh-once`) and **`scripts/d1-verify-mirror.mjs`** were deleted. Corridor data for **`/plan`** comes from **POI Services** when **`POI_SERVICES_BASE_URL`** is set — see **[`deprecate-nrel-overpass-mirror-travel-routing-adr.md`](./designs/deprecate-nrel-overpass-mirror-travel-routing-adr.md)**.

## Synology NAS: POI Services on `prod-network` (port 8010)

When the **POI Services** stack runs as a container on the same user-defined network as the **planner API** (e.g. external **`prod-network`**), set:

- **`POI_SERVICES_BASE_URL=http://poi:8010`** — Docker DNS resolves the **`poi`** service name; **8010** is the port the POI API listens on inside that network (match your Compose service `ports` / `expose`).

From the host (not inside a container), use `localhost` only if port 8010 is published to the host; from the **planner** container, prefer **`http://poi:8010`**. Confirm with:

- `docker exec -it <planner-container> wget -qO- http://poi:8010/health` (or `curl` if installed)

If `/plan` never hits POI, verify **`USE_POI_SERVICES_CORRIDOR`** is not `false` and check **`debug.providerCalls.poi_services`** on a successful response.

---

## Staging environment (`stage-network`)

CI deploys to staging on every push to `main`. The staging stack runs four services on a Docker user-defined network (`stage-network`) isolated from prod.

### Architecture

```
stage-network (Docker bridge — isolated from prod-network)
  ├── stage-web       Next.js   :3000 → Cloudflare → stage.yourdomain.com
  ├── stage-api       Express   :3001 → Cloudflare → stage-api.yourdomain.com
  ├── stage-poi       POI Svc   :8010 (internal only)
  └── stage-valhalla  Valhalla  :8002 (internal only, tiles read-only)
```

### One-time NAS setup

Run these once before the first CI deploy:

```bash
# 1. Create the Docker network
docker network create stage-network

# 2. Create the Valhalla tiles directory (populate via Z: drive)
mkdir -p /volume1/docker/valhalla-stage/tiles
```

**Valhalla tiles:** Build tiles on your dev PC, then copy to `Z:\valhalla-stage\tiles\`
(Z: maps to `/volume1/docker` on the NAS). The `stage-valhalla` container mounts this path read-only.

**Self-hosted runner:** The CI deploy job runs on a self-hosted GitHub Actions runner
on the NAS. One-time setup:

**Step 1 — Get a registration token**

Go to: `https://github.com/organizations/db-cloud-net/settings/actions/runners/new`
(org-level runner, reusable across all repos in the org)

Select **Linux → x64**. Copy the token shown — it looks like `AABCDE...` and expires after 1 hour.

**Step 2 — Start the runner container on the NAS**

```bash
docker run -d --restart unless-stopped \
  --name github-runner \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /volume1/docker/github-runner:/home/runner/_work \
  -e RUNNER_NAME="nas-runner" \
  -e RUNNER_SCOPE="org" \
  -e ORG_NAME="db-cloud-net" \
  -e RUNNER_TOKEN="<paste-token-from-step-1>" \
  -e LABELS="self-hosted,nas" \
  myoung34/github-runner:latest
```

The runner registers itself on startup and appears in `github.com/organizations/db-cloud-net/settings/actions/runners` within ~30 seconds. The `RUNNER_TOKEN` is consumed on first registration — the container stores the credential internally after that.

**Verify:** `docker logs github-runner` should end with `Listening for Jobs`.

### GitHub Secrets (Settings → Secrets → Actions)

| Secret | Example value | Purpose |
|--------|---------------|---------|
| `STAGE_API_URL` | `https://stage-api.yourdomain.com` | Baked into Next.js image; health check target |
| `STAGE_WEB_URL` | `https://stage.yourdomain.com` | API `CORS_ORIGIN` for staging |

### POI Services image

Until POI Services has its own CI pipeline, build and push the image manually once:

```bash
# On your dev machine (one-time, or when POI Services code changes):
cd /path/to/poi-services-repo
docker build -t ghcr.io/db-cloud-net/poi-services:latest .
docker push ghcr.io/db-cloud-net/poi-services:latest
```

The `stage-poi` image in `docker-compose.stage.yml` is already set to `ghcr.io/db-cloud-net/poi-services:latest`.

**Automation:** Add a GitHub Actions workflow to the POI Services repo that builds and pushes
on push to `main`. Example workflow: `.github/workflows/publish.yml` with `docker/build-push-action@v5`
targeting `ghcr.io/db-cloud-net/poi-services:latest`.

### Cloudflare tunnel

Create two tunnel rules in your Cloudflare dashboard:
- `stage.yourdomain.com` → `http://localhost:<stage-web-host-port>` (or Docker service name if runner is on same host)
- `stage-api.yourdomain.com` → `http://localhost:<stage-api-host-port>`

Alternatively, expose the containers directly to the tunnel via Docker service names if your
Cloudflare connector runs inside the same Docker network.

---

#### Validating hotel ↔ DCFC proximity in shards (offline)

The POI Services repo may ship proximity experiments that scan **`/data/shards`** (SQLite) directly — no HTTP from Travel-Routing. Use that repo’s docs for offline QA.
