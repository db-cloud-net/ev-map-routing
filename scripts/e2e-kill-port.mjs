/**
 * Best-effort: stop any process listening on `port` so E2E scripts can spawn
 * a fresh API. Safe to call when the port is already free.
 *
 * Windows: PowerShell Get-NetTCPConnection + Stop-Process
 * Unix: lsof + kill -9
 */

import { execSync } from "node:child_process";

/**
 * @param {number} port
 * @param {{ verbose?: boolean }} [opts]
 */
export function killListenersOnPort(port, opts = {}) {
  const { verbose = false } = opts;
  const p = Number(port);
  if (!Number.isFinite(p) || p < 1 || p > 65535) return;

  const log = (msg) => {
    if (verbose) {
      // eslint-disable-next-line no-console
      console.error(`[e2e-kill-port] ${msg}`);
    }
  };

  try {
    if (process.platform === "win32") {
      execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${p} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
        { stdio: "ignore" }
      );
      log(`freed listeners on :${p} (Windows)`);
    } else {
      let pids = "";
      try {
        pids = execSync(`lsof -ti:${p}`, { encoding: "utf8" }).trim();
      } catch {
        // no listeners
      }
      if (pids) {
        for (const pid of pids.split(/\s+/).filter(Boolean)) {
          try {
            execSync(`kill -9 ${pid}`, { stdio: "ignore" });
          } catch {
            // ignore
          }
        }
        log(`freed listeners on :${p} (kill ${pids})`);
      }
    }
  } catch {
    // port likely free or process not killable
  }
}
