# EV travel routing (monorepo)

## Manual testing (default: web **3000**, API **3001**)

1. **Copy env** (once): `cp .env.example .env` — add `NREL_API_KEY` and any service URLs you use.

2. **Match CORS to the port you use in the browser.** For the default setup, `.env` should include:

   ```env
   CORS_ORIGIN=http://localhost:3000
   ```

   If you run Next on another port (e.g. 3003), set `CORS_ORIGIN` to that exact origin.

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
