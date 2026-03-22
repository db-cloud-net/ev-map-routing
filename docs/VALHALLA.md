# Valhalla — URL and port (source of truth)

The planner talks to Valhalla over HTTP at **`VALHALLA_BASE_URL`** (no path; requests use **`POST /route`**, health check **`GET /status`**).

## Port

- **Default Valhalla HTTP port is `8002`** (container image, most NAS/Docker setups).
- Do **not** assume **`:800`** unless you explicitly mapped that on the host and confirmed it.

## Defaults (consistent everywhere)

| Place | Value |
|-------|--------|
| Code fallback (no env) | **`http://valhalla:8002`** — `DEFAULT_VALHALLA_BASE_URL` in **`api/src/config/valhallaBaseUrl.ts`** |
| **`docker-compose.mirror.yml`** | `${VALHALLA_BASE_URL:-http://valhalla:8002}` |
| **`.env.example`** | `http://localhost:8002` for laptop + local Valhalla |

Override with **`VALHALLA_BASE_URL`** in **`.env`** when the planner runs somewhere that cannot use those hostnames.

## Where the API runs

| Planner runs on | Typical `VALHALLA_BASE_URL` |
|-----------------|----------------------------|
| **Docker** on same network as Valhalla | `http://valhalla:8002` (service name) |
| **Windows/macOS** hitting Valhalla on a **NAS** | `http://<NAS-LAN-IP>:8002` (confirm with `GET /status`) |
| **Local** Valhalla on same machine | `http://127.0.0.1:8002` or `http://localhost:8002` |

## Optional `traffic.tar` warnings (not your routing tiles)

Valhalla may log **`(stat): /custom_files/traffic.tar No such file or directory`** and **`Traffic tile extract could not be loaded`**. That refers to **optional traffic overlay** data, **not** the main graph.

- Your **routing** extract is typically something like **`valhalla_tiles.tar`** (or similar) in `custom_files/`. Logs like **`Tile extract successfully loaded with tile count: …`** mean routing tiles are fine.
- **`traffic.tar`** is separate. If you don’t use Valhalla’s traffic feature, you can **ignore** those WARN lines, or add an empty/minimal traffic setup only if your image requires it.

Do **not** rename `valhalla_tiles.tar` to `traffic.tar` — they are different products.

## Verify reachability

```powershell
Invoke-RestMethod -Uri "http://<host>:8002/status" -Method Get
```

Then set **`VALHALLA_BASE_URL`** to **exactly** that origin (scheme + host + port).

## Response shape (`/route`)

Some Valhalla builds return **`trip.legs[0].shape`** (or **`trip.shape`**) as a **Google-encoded polyline string** instead of GeoJSON. The API decodes **precision 6** (Valhalla default) and falls back to **precision 5** if needed.

## Related env (timeouts only)

- **`PLAN_VALHALLA_POLYLINE_TIMEOUT_MS`** — first corridor `/route`
- **`PLAN_VALHALLA_LEG_TIMEOUT_MS`** — per-leg `/route` in the segment solver  

See **`TESTING.md`**.
