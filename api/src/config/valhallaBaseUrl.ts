/**
 * Valhalla HTTP base URL (scheme + host + port, no path).
 *
 * Convention: Valhalla listens on **port 8002** in almost all deployments (container
 * or NAS). Use `VALHALLA_BASE_URL` in `.env` when the planner cannot use this default.
 *
 * @see docs/VALHALLA.md (repo root)
 */
export const DEFAULT_VALHALLA_BASE_URL = "http://valhalla:8002";

export function getValhallaBaseUrl(): string {
  const fromEnv = process.env.VALHALLA_BASE_URL?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_VALHALLA_BASE_URL;
}
