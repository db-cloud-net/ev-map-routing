# Cloudflare (production edge)

This repo does **not** ship a `cloudflared` compose file; production uses a **separate** stack on the host (e.g. Synology) alongside the planner API. This doc records **how that fits together** so v2 can reproduce the same pattern.

## Role

- **Cloudflare Tunnel** (`cloudflared`) exposes an HTTPS hostname on Cloudflare’s edge and forwards traffic **outbound** from your network to origin services (Docker on NAS). You typically **do not** open inbound firewall ports for the app.
- **Zero Trust / Access** (optional) adds auth in front of the hostname; not required for tunnel basics.

## What you must align

| Concern | Notes |
|--------|--------|
| **Docker network** | `cloudflared` and `planner-api` (and Valhalla, etc.) should share a common user-defined network (e.g. `prod-network`) so the tunnel can reach `http://planner-api:3001` or `http://host.docker.internal:3001` depending on your ingress config. |
| **Ingress target** | In the Cloudflare dashboard (or local tunnel config), the **public hostname** for the API maps to the **internal origin URL** that resolves from inside the `cloudflared` container. |
| **CORS** | Browser calls use the **public** `https://…` origin. Set `DEPLOYMENT_ENV=production` and `CORS_ORIGIN` to that exact origin (or your chosen policy). See [`README.md`](../README.md) and [`api/src/server.ts`](../api/src/server.ts). |
| **Secrets** | Tunnel credentials use **`TUNNEL_TOKEN`** (or equivalent) from Cloudflare — **never commit**; inject via `.env` or DSM secrets on the NAS. |

## What stays out of git

- Tunnel token / account-specific YAML
- Exact public hostname(s) and Access policies (team-specific)

## References

- **Manual verification (CORS + public URL):** [`TESTING.md`](../TESTING.md) § *Production (public URL + CORS)*.
- Cloudflare docs: **Cloudflare Tunnel** (`cloudflared tunnel run`), **Public hostnames**, **Private networks** (if applicable).
- Deployment context: [`V1_SYSTEM.md`](./V1_SYSTEM.md), [`d1-runbook.md`](./d1-runbook.md), [`LOCAL_MIRROR_CHECKPOINT.md`](./LOCAL_MIRROR_CHECKPOINT.md).
