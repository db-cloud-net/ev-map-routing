# EV travel routing (monorepo)

## Documentation (v1 handoff → v2)

| Doc | Use |
|-----|-----|
| **[docs/V1_SYSTEM.md](./docs/V1_SYSTEM.md)** | Minimal map to **reconstruct** the system: layout, flow, run, verify. |
| **[docs/README.md](./docs/README.md)** | Index of all docs. |
| **[PRD.md](./PRD.md)** | Product requirements + QA-linked env knobs. |
| **[TESTING.md](./TESTING.md)** | QA runners, timeouts, troubleshooting. |
| **[docs/CLOUDFLARE.md](./docs/CLOUDFLARE.md)** | Public HTTPS via Cloudflare Tunnel + CORS (production). |

## Manual testing (default: web **3000**, API **3001**)

1. **Copy env** (once): `cp .env.example .env` — add `NREL_API_KEY` and any service URLs you use.

2. **Set `DEPLOYMENT_ENV` + CORS.** For the default local dev setup, `.env` should include:

   ```env
   DEPLOYMENT_ENV=dev-local
   CORS_ORIGIN=http://localhost:3000
   ```

   In `dev-local`, the API reflects the browser `Origin` header, so WSL/host IP origins work without you hardcoding `CORS_ORIGIN` to the WSL IP.
   `CORS_ORIGIN` matters mainly in `DEPLOYMENT_ENV=production` where the API uses a strict allowlist.

3. **Two terminals** from the repo root:

   ```bash
   npm run dev:api
   ```

   ```bash
   npm run dev:web
   ```

4. Open **`http://localhost:3000/map`**, use **Plan Trip**.

5. More detail, E2E, and troubleshooting: **[TESTING.md](./TESTING.md)**.

## Scripts

| Command           | Description              |
|-------------------|--------------------------|
| `npm run dev:api` | API on port **3001**     |
| `npm run dev:web` | Next.js on port **3000** |
| `npm run build`   | Build API + web          |
| `npm run qa:smoke` | API `tsc` + CORS + `/plan` log contract E2E ([TESTING.md](./TESTING.md)) |
