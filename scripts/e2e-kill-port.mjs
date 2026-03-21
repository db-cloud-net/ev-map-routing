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
      try {
        execSync(
          `powershell -NoProfile -Command "$pids = Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($procId in $pids) { if ($procId) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } }"`,
          { stdio: "ignore" }
        );
      } catch {
        // ignore
      }
      try {
        const out = execSync(`cmd.exe /c netstat -ano`, { encoding: "utf8" });
        const portSuffix = `:${p}`;
        const seen = new Set();
        for (const line of out.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("TCP")) continue;
          if (!trimmed.includes("LISTENING")) continue;
          const parts = trimmed.split(/\s+/).filter(Boolean);
          if (parts.length < 5) continue;
          const localAddr = parts[1];
          if (!localAddr.endsWith(portSuffix)) continue;
          const m = localAddr.match(/:(\d+)$/);
          if (!m || Number(m[1]) !== p) continue;
          const pid = Number(parts[parts.length - 1]);
          if (!Number.isFinite(pid) || pid <= 0 || seen.has(pid)) continue;
          seen.add(pid);
          try {
            execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
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
